import {prepareQuality} from './tools/quality.js';
import {prepareCustomer} from './gitlab/customer.js';
import {prepareSoftwareInstall} from './tools/software.js';
import {prepareNativeInitialization} from './tools/initialization.js';
import type {SetupOperation} from '../types.js';
import {dirname,isAbsolute,resolve} from 'node:path';
import {agents,prepareCustomerMcp} from './tools/customer-mcp.js';
import {collectCustomSkill} from './custom-skills.js';
import {renderCustomerTemplate} from './custom-templates.js';
import {openwiki} from './tools/openwiki.js';
import {codegraph} from './tools/codegraph.js';
import type {Ownership} from '../managed-input.js';
import {superpowers} from './sdd/superpowers.js';
import {openspec} from './sdd/openspec.js';
import {specKit} from './sdd/spec-kit.js';
import {readFile} from 'node:fs/promises';
import {digest} from '../analyzer/evidence.js';
export interface Recipe {packageIntegrity?:string;integrationId:string;version:string;kind:'agent'|'sdd'|'tool';sources:{url:string;revision:string;verifiedAt:string}[];evidenceStatus:{source:boolean;contract:boolean;live:boolean}}
export function requireRecipeEvidence(recipe:Recipe,version=recipe.version):void {
 if(version !== recipe.version) throw new Error(recipe.integrationId+': version change requires new evidence');
 if(!recipe.evidenceStatus.source || !recipe.sources.length) throw new Error(recipe.integrationId+': unverified source evidence');
 if(!/^(?:[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?|[a-f0-9]{40})$/.test(recipe.version)) throw new Error(recipe.integrationId+': exact version required');
 for(const source of recipe.sources) {
  if(!source.revision || !/^\d{4}-\d{2}-\d{2}$/.test(source.verifiedAt)) throw new Error('source evidence metadata missing');
  const url=new URL(source.url);if(url.protocol !== 'https:' || url.username || url.password) throw new Error('source evidence URL invalid');
 }
}
export function selectUpdateVersion(recipe:Recipe,installedVersion?:string,upgrade?:string):string {if(upgrade) {requireRecipeEvidence(recipe,upgrade);return upgrade;}
 return installedVersion ?? recipe.version;}
export function parseUpstreamLock(value:unknown):Recipe[]{
 if(!value || typeof value !== 'object') throw new Error('upstream lock: expected object');
 const doc=value as Record<string,unknown>;
 if(doc.schemaVersion !== 1 || !Array.isArray(doc.integrations)) throw new Error('upstream lock: schemaVersion/integrations invalid');
 const seen=new Set<string>();
 for(const raw of doc.integrations) {
  if(!raw || typeof raw !== 'object' || typeof raw.integrationId !== 'string' || !['agent','sdd','tool'].includes(raw.kind) || typeof raw.version !== 'string') throw new Error('upstream lock: invalid recipe');
  if(seen.has(raw.integrationId)) throw new Error('upstream lock: duplicate integration');seen.add(raw.integrationId);
  if(!Array.isArray(raw.sources) || !raw.evidenceStatus || ['source','contract','live'].some(k=>typeof raw.evidenceStatus[k] !== 'boolean')) throw new Error('upstream lock: evidence levels required');
  if(raw.integrationId === 'codegraph' && raw.repository !== 'https://github.com/colbymchenry/codegraph') throw new Error('CodeGraph repository does not match required upstream');
  if(!/^(?:[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?|[a-f0-9]{40})$/.test(raw.version)) throw new Error('upstream lock: exact version required');
  if(raw.evidenceStatus.source) requireRecipeEvidence(raw);
 }
 return doc.integrations as Recipe[];
}
export async function loadUpstreamLock():Promise<Recipe[]>{return parseUpstreamLock(JSON.parse(await readFile(new URL('../../docs/compatibility/upstream-lock.json',import.meta.url),'utf8')));}
export interface SddBinding {status:'source-bound';id:string;agent:string;prepare:string[];deliver:string[];artifacts:string[];gates:string[]}
export function bindSdd(id:string,agent:string,available:string[]):SddBinding|{status:'pending';id:string;reason:string} {
 if(!['claude','codex','opencode','omp'].includes(agent)) throw new Error('unsupported host');
 if(id === 'superpowers' && agent === 'omp') return {status:'pending',id,reason:'OMP-specific Superpowers binding not verified; Pi support is not evidence for OMP'};
 const descriptor=id === 'superpowers' ? superpowers : id === 'openspec' ? openspec : id === 'spec-kit' ? specKit : undefined;
 if(!descriptor) throw new Error('unsupported SDD');
 const names=(list:string[])=>id === 'spec-kit' ? list.map(name=>agent === 'codex' ? 'speckit-'+name : 'speckit.'+name) : list.map(name=>available.includes(name)?name:available.includes(name.split(':').at(-1)!)?name.split(':').at(-1)!:name);
 const prepare=names(descriptor.prepare);const deliver=names(descriptor.deliver);
 for(const entry of [...prepare,...deliver]) if(!available.includes(entry)) throw new Error('missing native entry: '+entry);
 return {status:'source-bound',id,agent,prepare,deliver,artifacts:[...descriptor.artifacts],gates:[...descriptor.gates]};
}
export interface SkillSource {name:string;origin:'plugin'|'local'|'managed'|'unknown';identity:string;digest?:string;satisfies:boolean;version?:string;nativeName?:string;problem?:string}
export function resolveSkillSource(name:string,sources:SkillSource[],selectedIdentity?:string):SkillSource {
 let matches=sources.filter(s=>s.name === name);
 if(selectedIdentity) matches=matches.filter(s=>s.identity === selectedIdentity);
 if(!matches.length) throw new Error('missing skill source: '+name);
 if(matches.some(s=>s.origin === 'unknown' || !s.satisfies)) throw new Error('skill source unknown or dependency needs verification'+(matches.some(s=>s.problem)?': '+matches.flatMap(s=>s.problem?[s.problem]:[]).join('; '):''));
 if(matches.length>1 && (!matches[0].digest || matches.some(s=>s.digest !== matches[0].digest))) throw new Error('skill source conflict: select an explicit identity');
 return matches.find(s=>s.origin === 'plugin') ?? matches[0];
}
export interface PreparedAsset {logicalId:string;target:string;content:string;ownership:Ownership;source:{kind:string;ref:string;digest?:string};encoding?:'utf8'|'base64';mode?:number;consumer?:string}
export interface IntegrationPreparation {assets:PreparedAsset[];operations:SetupOperation[];warnings:string[];requirements:{integrationId:string;reason:string}[];bindings:SddBinding[];skillBindings?:{agent:string;consumer:string;target?:string;nativeName?:string}[]}
export async function prepareIntegrations(profile:import('../analyzer/repository.js').ProjectProfile,options:import('../types.js').SetupOptions):Promise<IntegrationPreparation>{
 const lock=await loadUpstreamLock();const assets:PreparedAsset[]=[];const operations:SetupOperation[]=[];const warnings:string[]=[];const requirements:IntegrationPreparation['requirements']=[];const bindings:SddBinding[]=[];const skillBindings:NonNullable<IntegrationPreparation['skillBindings']>=[];
 const requireKnown=(id:string)=>{const recipe=lock.find(r=>r.integrationId === id);if(!recipe) throw new Error('unsupported integration: '+id);requireRecipeEvidence(recipe);return recipe;};
 for(const agent of options.agents) {if(!Object.hasOwn(agents,agent)) throw new Error('unknown agent');requireKnown(agent);}
 const push=(added:PreparedAsset[])=>{
  for(const asset of added) {
   const same=assets.find(a=>a.target === asset.target && JSON.stringify(a.ownership) === JSON.stringify(asset.ownership));
   if(same) {if(same.content === asset.content) continue;throw new Error('integration target collision: '+asset.target);}
   if(assets.some(a=>a.target === asset.target && (a.ownership.kind === 'file'||asset.ownership.kind === 'file'))) throw new Error('integration target overlap: '+asset.target);
   assets.push(asset);
  }
 };
 if(options.sdd) {
  requireKnown(options.sdd);
  for(const agent of options.agents) {
   try {const available=profile.nativeEntries?.[agent]??[];const binding=bindSdd(options.sdd,agent,available);if(binding.status==='pending')requirements.push({integrationId:options.sdd,reason:binding.reason});else{const resolve=(name:string)=>{const base=name.split(':').at(-1)!;const candidates=(profile.skillSources?.[agent]??[]).filter(s=>s.name===name||s.name===base||s.name===options.sdd+':'+base);const source=resolveSkillSource(base,candidates.map(s=>({...s,name:base,nativeName:s.name})));return source.nativeName!;};bindings.push({...binding,prepare:binding.prepare.map(resolve),deliver:binding.deliver.map(resolve)});}}
   catch(error){requirements.push({integrationId:options.sdd,reason:(error as Error).message});}
  }
 }
 for(const input of options.mcp ?? []) {
  if(input.agents.some(a=>!options.agents.includes(a))) throw new Error('MCP target agent not selected');
  const prepared=await prepareCustomerMcp(profile.root,input);push(prepared.assets);warnings.push(...prepared.warnings);
 }
 for(const selection of options.tools ?? []) {
  const recipe=requireKnown(selection.id);const tool=selection.id === 'openwiki' ? openwiki : selection.id === 'codegraph' ? codegraph : undefined;
  if(!tool) throw new Error('unsupported executable adapter');
  if(selection.agents.some(a=>!options.agents.includes(a))) throw new Error('tool MCP target agent not selected');
  for(const agent of selection.agents) {
   const prepared=await prepareCustomerMcp(profile.root,{id:tool.id,agents:[agent],command:{executable:selection.install ? resolve(profile.root,'.rigup/tools/'+tool.id+'/node_modules/.bin/'+tool.software) : tool.software,args:tool.mcpArgs(agent),cwd:'.',envRefs:[]}},tool.id+'-'+agent);push(prepared.assets);
  }
  warnings.push(tool.id+': binary '+recipe.version+' availability and native connection pending');
  let installed=false;
  if(selection.install) {
   const prepared=await prepareSoftwareInstall(profile.root,selection.id,recipe.version,recipe.packageIntegrity,profile.installedTools?.[tool.id]);
   if('pending' in prepared) {warnings.push(tool.id+': '+prepared.pending);requirements.push({integrationId:tool.id,reason:prepared.pending});}
   else if('reused' in prepared) {installed=true;warnings.push(tool.id+': reuse receipted project installation '+prepared.version);}
   else operations.push(prepared);
  }
  if(selection.initialize) {
   const prepared=await prepareNativeInitialization(profile.root,selection.id,recipe.version,recipe.packageIntegrity,{installed,prerequisiteIds:operations.filter(o=>o.id==='install:'+selection.id).map(o=>o.id)});
   if('pending' in prepared){warnings.push(tool.id+': '+prepared.pending);requirements.push({integrationId:tool.id,reason:prepared.pending});}else operations.push(prepared);
  }
 }
 for(const skill of options.customSkills ?? []) for(const agent of options.agents) {
  const copies=await collectCustomSkill(skill.source.startsWith('/') ? skill.source : profile.root+'/'+skill.source,agents[agent].skillDirectory);
  const entry=copies.find(a=>a.target.endsWith('/SKILL.md'))!;const name=entry.target.split('/').at(-2)!;
  const existing=(profile.skillSources?.[agent]??[]).filter(s=>s.name===name||s.name.split(':').at(-1)===name);
  const resolved=existing.length?resolveSkillSource(name,existing.map(s=>({...s,name,nativeName:s.name}))):undefined;
  if(resolved){
   const bundle=(items:Awaited<ReturnType<typeof collectCustomSkill>>)=>digest(JSON.stringify(items.map(a=>({target:a.target,digest:a.source.digest,mode:a.mode,encoding:a.encoding}))));
   for(const source of existing){const installed=await collectCustomSkill(dirname(isAbsolute(source.identity)?source.identity:resolve(profile.root,source.identity)),agents[agent].skillDirectory);if(bundle(installed)!==bundle(copies))throw new Error('skill source conflict: selected and native resources are not equivalent');}
  }
  if(skill.position==='release')requirements.push({integrationId:name,reason:'Customer release position pending a verified release adapter; no release workflow is installed'});
  else if(skill.position)skillBindings.push({agent,consumer:'change-'+skill.position,...(resolved&&isAbsolute(resolved.identity)?{nativeName:resolved.nativeName}:{target:resolved?.identity??entry.target})});
  if(resolved) {warnings.push(name+': reuse satisfied native source; no duplicate copy');continue;}
  push(copies.map(a=>({...a,...(skill.position && a === entry ? {consumer:'change-'+skill.position} : {})})));
 }
 const context=options.projectConventions?.documentRoutes?.context ?? 'docs/rigup';
 const roots=[context,...assets.filter(a=>a.target.endsWith('/SKILL.md')).map(a=>a.target.slice(0,-9)+'/references')];
 for(const template of options.templates ?? []) push([await renderCustomerTemplate(profile.root,template,roots,'change-deliver:review')]);
 if(options.projectConventions?.tracker) warnings.push('Tracker convention recorded; executable tracker adapter is pending');
 const quality=await prepareQuality(profile,options);push(quality.assets);warnings.push(...quality.warnings);requirements.push(...quality.requirements);
 const customer=prepareCustomer(options);push(customer.assets);warnings.push(...customer.warnings);requirements.push(...customer.requirements);
 for(let i=operations.length-1;i>=0;i--) {
  const operation=operations[i];
  if(operation.declaredWrites.some(scope=>assets.some(asset=>scope === '.' || asset.target === scope || asset.target.startsWith(scope+'/')))) {
   operations.splice(i,1);const reason='external write scope overlaps a text candidate; manual preparation required';
   warnings.push(operation.integrationId+': '+reason);requirements.push({integrationId:operation.integrationId,reason});
  }
 }
 return {assets,operations,warnings,requirements,bindings,skillBindings};
}
