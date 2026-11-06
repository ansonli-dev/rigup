import {posix} from 'node:path';
import type {SpecializedCheck} from '../../analyzer/check-prerequisites.js';
import type {ProjectProfile} from '../../analyzer/repository.js';
import type {CheckKind,CheckSelector,CommandSpec,NpmScript} from '../../types.js';
import {npmScriptName,projectRelativePath} from './project-check.mjs';

export type CheckCommand = CommandSpec & {tools?:SpecializedCheck['tools'];testDatabase?:true};
const kinds=['build','lint','test','environment','eval'];
export const isCheckKind=(value:unknown):value is CheckKind=>typeof value==='string'&&kinds.includes(value);
export function isNpmScript(value:unknown):value is NpmScript {
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==2)return false;
 const {cwd,script}=value as Record<string,unknown>;
 return (cwd==='.'||projectRelativePath(cwd))&&npmScriptName(script);
}
export const isCheckSelector=(value:unknown):value is CheckSelector=>isCheckKind(value)||isNpmScript(value);
export const npmScript=({cwd,args}:CommandSpec):NpmScript=>({cwd,script:args[1]});
const key=({cwd,script}:NpmScript)=>JSON.stringify([cwd,script]);

export function projectChecks(profile:Pick<ProjectProfile,'commands'|'specializedChecks'>):SpecializedCheck[] {
 const checks=new Map<string,SpecializedCheck>();
 for(const command of Object.values(profile.commands).flat()){
  checks.set(key(npmScript(command)),{command,source:posix.join(command.cwd,'package.json')});
 }
 for(const check of profile.specializedChecks)checks.set(key(npmScript(check.command)),check);
 return [...checks.values()];
}

export function checkCommand(check:SpecializedCheck):CheckCommand {
 return {...check.command,...(check.tools?{tools:check.tools}:{}),...(check.postgres?{testDatabase:true as const}:{})};
}

export function selectedChecks(profile:ProjectProfile,selectors:readonly CheckSelector[]):{name:string;check?:SpecializedCheck}[] {
 const catalog=new Map(projectChecks(profile).map(check=>[key(npmScript(check.command)),check])),seen=new Set<string>();
 return selectors.flatMap(name=>{
  const refs=typeof name==='string'?(profile.commands[name]??[]).map(npmScript):[name];
  const label=typeof name==='string'?name:name.cwd+' npm run '+name.script;
  const found=refs.map(ref=>catalog.get(key(ref))).filter((check):check is SpecializedCheck=>!!check);
  if(!found.length)return [{name:label}];
  return found.filter(check=>{
   const identity=key(npmScript(check.command));
   if(seen.has(identity))return false;
   seen.add(identity);return true;
  }).map(check=>({name:label,check}));
 });
}
