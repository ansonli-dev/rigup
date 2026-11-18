import {execFile} from 'node:child_process';
import {access,constants,readFile,realpath,stat} from 'node:fs/promises';
import {isAbsolute,posix,relative,resolve,sep} from 'node:path';
import {promisify} from 'node:util';
import type {ProjectProfile} from '../../analyzer/repository.js';
import type {CheckSelector,CommandSpec,SetupOptions} from '../../types.js';
import type {IntegrationPreparation} from '../registry.js';
import {prepareGitlab} from '../gitlab/ci.js';
import {selectedChecks} from './check-catalog.js';
import {executeCheck} from './project-check.mjs';
import {runtimeEnvironment} from '../../runtime-inputs.js';

const exec=promisify(execFile);
async function hasNativeHook(root:string,name:string):Promise<boolean>{
 try{
  const path=(await exec('git',['-C',root,'rev-parse','--git-path','hooks/'+name])).stdout.trim();
  const hook=await realpath(resolve(root,path)),rel=relative(root,hook);
  if(rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel))return false;
  const info=await stat(hook);
  if(!info.isFile()||info.size>256_000)return false;
  await access(hook,constants.X_OK);
  return !/\.rigup\/scripts\/check-(?:snapshot|worktree)\.mjs/.test(await readFile(hook,'utf8'));
 }catch{return false;}
}

export async function prepareQuality(profile:ProjectProfile,options:SetupOptions):Promise<IntegrationPreparation>{
 const result:IntegrationPreparation={assets:[],operations:[],warnings:[],requirements:[],bindings:[]};
 const q=options.quality;if(!q)return result;
 const commands=(selectors:CheckSelector[]=[])=>selectedChecks(profile,selectors).flatMap(({name,check,selector})=>{
  if(check)return [check];
  const manifest=typeof selector==='string'?undefined:posix.join(selector.cwd,'package.json');
  if(profile.checkCoverageIncomplete&&(!manifest||!profile.checkManifests?.includes(manifest))){
   result.warnings.push('Quality check '+name+' could not be verified in this inventory.');
   return [];
  }
  result.requirements.push({integrationId:'quality:'+name,reason:'Select an existing project command'});return [];
 });
 const hooks=[['pre-commit',q.preCommit],['pre-push',q.prePush]] as const;
 const nativeHooks=await Promise.all(hooks.map(([name,selected])=>selected?.length?hasNativeHook(profile.root,name):false));
 hooks.forEach(([name,selected],index)=>{
  if(!selected?.length)return;
  commands(selected);
  if(nativeHooks[index])result.warnings.push('Reuse the existing '+name+' hook. Confirm that it covers the selected project checks.');
  else result.requirements.push({integrationId:'quality:'+name,reason:'Configure and activate a project-owned '+name+' hook, or remove this selection.'});
 });
 if(q.gitlab){
  const checks=commands(q.gitlab.checks);
  if(profile.gitlabReviewRequired)return result;
  const ci=await prepareGitlab(profile.root,q.gitlab,checks.map(check=>check.command));
  result.assets.push(...ci.assets);result.requirements.push(...ci.requirements);
  result.warnings.push('Verify the native GitLab jobs with the target runner. Provision selected tools and dependencies in that environment.');
 }
 return result;
}

export interface ResolvedProjectCheck {name:string;command?:CommandSpec;privateEnvironment?:true}
export function resolveProjectChecks(profile:ProjectProfile,selectors:CheckSelector[],options?:SetupOptions):ResolvedProjectCheck[]{
 return selectedChecks(profile,selectors).map(({name,check})=>{
  const environment=options?.customer?.commands?.environment;
  if(name==='environment'&&environment)return {name,command:environment,privateEnvironment:true};
  return {name,command:check?.command};
 });
}

export function runProjectChecks(profile:ProjectProfile,selectors:CheckSelector[],signal?:AbortSignal,options?:SetupOptions){
 return runResolvedProjectChecks(profile,resolveProjectChecks(profile,selectors,options),signal,options);
}

export async function runResolvedProjectChecks(profile:ProjectProfile,checks:ResolvedProjectCheck[],signal?:AbortSignal,options?:SetupOptions):Promise<import('../../installer/apply.js').CheckResult[]>{
 const results:import('../../installer/apply.js').CheckResult[]=[];
 for(const {name,command,privateEnvironment} of checks){
  if(!command){results.push({name,status:'pending',message:'No existing command; not evaluated'});continue;}
  let env:NodeJS.ProcessEnv|undefined;
  if(privateEnvironment&&options){
   try{env=await runtimeEnvironment(profile.root,options,'customer:environment');}
   catch{results.push({name,status:'pending',message:'Correct the private runtime input file before running the environment check'});continue;}
  }
  const {reason,...result}=await executeCheck(command,profile.root,{signal,env});
  results.push({name,...result,message:reason,fingerprint:profile.fingerprint,commit:profile.git.head??'unavailable',environment:{node:process.version,platform:process.platform}});
  if(signal?.aborted)break;
 }
 return results;
}
