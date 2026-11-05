import {openspec} from './openspec.js';
import {specKit} from './spec-kit.js';
import {superpowers} from './superpowers.js';

interface SddDescriptor {
 id:string;
 prepare:string[];
 deliver:string[];
 revise?:string;
 sync?:string;
 artifacts:string[];
 gates:string[];
}

const descriptors:readonly SddDescriptor[]=[superpowers,openspec,specKit];

export interface SddBinding {
 status:'source-bound';
 id:string;
 agent:string;
 prepare:string[];
 deliver:string[];
 artifacts:string[];
 gates:string[];
 revise?:string;
 projectSources?:string[];
}

interface PendingBinding {
 status:'pending';
 id:string;
 reason:string;
}

export interface SkillSource {
 name:string;
 origin:'plugin'|'local'|'managed'|'unknown';
 identity:string;
 digest?:string;
 satisfies:boolean;
 version?:string;
 nativeName?:string;
 problem?:string;
}

export function unqualifiedSkillName(name:string):string {
 return name.slice(name.lastIndexOf(':')+1);
}

function specKitName(name:string,agent:string):string {
 return 'speckit'+(agent==='codex'?'-':'.')+name;
}

function optionalEntries(descriptor:SddDescriptor):string[] {
 return [descriptor.revise,descriptor.sync].filter(name=>name!==undefined);
}

export function sddDiscoveryNames(id:string,includeOptional=true):string[] {
 const descriptor=descriptors.find(candidate=>candidate.id===id);
 if(!descriptor) return [];
 const names=[...descriptor.prepare,...descriptor.deliver,...(includeOptional?optionalEntries(descriptor):[])];
 return descriptor===specKit
  ? names.flatMap(name=>[specKitName(name,'codex'),specKitName(name,'opencode')])
  : names.map(unqualifiedSkillName);
}

function availableEntry(name:string,id:string,available:string[]):string|undefined {
 const base=unqualifiedSkillName(name);
 return [name,base,id+':'+base].find(candidate=>available.includes(candidate));
}

export function bindSdd(id:string,agent:string,available:string[]):SddBinding|PendingBinding {
 if(!['claude','codex','opencode','omp'].includes(agent)) throw new Error('unsupported host');
 if(id===superpowers.id && agent==='omp') return {status:'pending',id,reason:'OMP-specific Superpowers binding not verified; Pi support is not evidence for OMP'};
 const descriptor=descriptors.find(candidate=>candidate.id===id);
 if(!descriptor) throw new Error('unsupported SDD');
 const nativeName=(name:string)=>{
  const canonical=descriptor===specKit?specKitName(name,agent):name;
  return availableEntry(canonical,id,available)??canonical;
 };
 const prepare=descriptor.prepare.map(nativeName);
 const deliver=descriptor.deliver.map(nativeName);
 for(const entry of [...prepare,...deliver]) if(!available.includes(entry)) throw new Error('missing native entry: '+entry);
 return {status:'source-bound',id,agent,prepare,deliver,artifacts:[...descriptor.artifacts],gates:[...descriptor.gates]};
}

export function resolveSkillSource(name:string,sources:SkillSource[],selectedIdentity?:string):SkillSource {
 const matches=sources.filter(source=>source.name===name && (!selectedIdentity || source.identity===selectedIdentity));
 if(!matches.length) throw new Error('missing skill source: '+name);
 if(matches.some(source=>source.origin==='unknown' || !source.satisfies)){
  const problems=matches.flatMap(source=>source.problem?[source.problem]:[]);
  throw new Error('skill source unknown or dependency needs verification'+(problems.length?': '+problems.join('; '):''));
 }
 if(matches.length>1 && (!matches[0].digest || matches.some(source=>source.digest!==matches[0].digest))){
  throw new Error('skill source conflict: select an explicit identity');
 }
 return matches.find(source=>source.origin==='plugin') ?? matches[0];
}

export function resolveSddBinding(id:string,agent:string,available:string[],sources:SkillSource[],files:string[]):{binding:SddBinding|PendingBinding;warnings:string[]} {
 const binding=bindSdd(id,agent,available);
 const warnings:string[]=[];
 if(binding.status==='pending') return {binding,warnings};
 const descriptor=descriptors.find(candidate=>candidate.id===id)!;
 const resolveEntry=(name:string)=>{
  const base=unqualifiedSkillName(name);
  const candidates=sources.filter(source=>source.name===name || source.name===base || source.name===id+':'+base);
  return resolveSkillSource(base,candidates.map(source=>({...source,name:base,nativeName:source.name})));
 };
 const prepare=binding.prepare.map(resolveEntry);
 const deliver=binding.deliver.map(resolveEntry);
 const optional=optionalEntries(descriptor).flatMap(name=>{
  const entry=availableEntry(name,id,available);
  if(!entry)return [];
  try {return [resolveEntry(entry)];}
  catch {warnings.push(agent+': '+name+' needs source reconciliation');return [];}
 });
 const revise=optional.find(source=>unqualifiedSkillName(source.nativeName!)===descriptor.revise)?.nativeName;
 const projectSources=[...prepare,...deliver,...optional].map(source=>source.identity).filter(path=>files.includes(path));
 return {
  binding:{...binding,prepare:prepare.map(source=>source.nativeName!),deliver:deliver.map(source=>source.nativeName!),revise,projectSources},
  warnings,
 };
}
