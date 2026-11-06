import {execFile} from 'node:child_process';
import {access,constants,readFile,realpath,stat} from 'node:fs/promises';
import {isAbsolute,relative,resolve} from 'node:path';
import {promisify} from 'node:util';
import type {ProjectProfile} from '../../analyzer/repository.js';
import type {CheckSelector,SetupOptions} from '../../types.js';
import type {IntegrationPreparation} from '../registry.js';
import {prepareGitlab} from '../gitlab/ci.js';
import {checkCommand,selectedChecks} from './check-catalog.js';
import {executeCheck} from './project-check.mjs';

const exec=promisify(execFile);
async function hasNativeHook(root:string,name:string):Promise<boolean>{
 try{
  const path=(await exec('git',['-C',root,'rev-parse','--git-path','hooks/'+name])).stdout.trim();
  const hook=await realpath(resolve(root,path)),rel=relative(root,hook);
  if(rel==='..'||rel.startsWith('../')||isAbsolute(rel))return false;
  const info=await stat(hook);
  if(!info.isFile()||info.size>256_000)return false;
  await access(hook,constants.X_OK);
  return !/\.rigup\/scripts\/check-(?:snapshot|worktree)\.mjs/.test(await readFile(hook,'utf8'));
 }catch{return false;}
}

export async function prepareQuality(profile:ProjectProfile,options:SetupOptions):Promise<IntegrationPreparation>{
 const result:IntegrationPreparation={assets:[],operations:[],warnings:[],requirements:[],bindings:[]};
 const q=options.quality;if(!q)return result;
 const commands=(selectors:CheckSelector[]=[])=>selectedChecks(profile,selectors).flatMap(({name,check})=>{
  if(check)return [check];
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
  const ci=await prepareGitlab(profile.root,q.gitlab,checks.flatMap(check=>{
   if(check.postgres||check.tools?.includes('pm2')){
    result.requirements.push({integrationId:'gitlab',reason:'Use a project-owned CI job to provision the services for '+check.command.args.join(' ')+' in '+check.command.cwd+'.'});
    return [];
   }
   return [check.command];
  }));
  result.assets.push(...ci.assets);result.requirements.push(...ci.requirements);
  result.warnings.push('Verify the native GitLab jobs with the target runner. Provision selected tools and dependencies in that environment.');
 }
 return result;
}

export async function runProjectChecks(profile:ProjectProfile,selectors:CheckSelector[],signal?:AbortSignal):Promise<import('../../installer/apply.js').CheckResult[]>{
 const results:import('../../installer/apply.js').CheckResult[]=[];
 for(const {name,check} of selectedChecks(profile,selectors)){
  if(!check){results.push({name,status:'pending',message:'No existing command; not evaluated'});continue;}
  const {reason,...result}=await executeCheck(checkCommand(check),profile.root,{signal});
  results.push({name,...result,message:reason,fingerprint:profile.fingerprint,commit:profile.git.head??'unavailable',environment:{node:process.version,platform:process.platform}});
 }
 return results;
}
