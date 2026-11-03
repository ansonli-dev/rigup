import {readFile,realpath} from 'node:fs/promises';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {resolve,relative,isAbsolute} from 'node:path';
import type {ProjectProfile} from '../../analyzer/repository.js';import type {SetupOptions,CheckKind} from '../../types.js';import type {IntegrationPreparation,PreparedAsset} from '../registry.js';
import {prepareGitlab} from '../gitlab/ci.js';import {digest} from '../../analyzer/evidence.js';
const exec=promisify(execFile);
export async function prepareQuality(profile:ProjectProfile,options:SetupOptions):Promise<IntegrationPreparation>{
 const result:IntegrationPreparation={assets:[],operations:[],warnings:[],requirements:[],bindings:[]};const q=options.quality;if(!q)return result;
 const commands=(kinds:CheckKind[]=[])=>kinds.flatMap(kind=>{const found=profile.commands[kind]??[];if(!found.length)result.requirements.push({integrationId:'quality:'+kind,reason:'No existing command; no test system is generated'});return found;});
 const config={preCommit:commands(q.preCommit),prePush:commands(q.prePush),ci:commands(q.gitlab?.checks),maxCommits:q.maxPushCommits??100,reportPaths:q.gitlab?.reportPaths??[]};
 const add=(logicalId:string,target:string,content:string,mode?:number)=>result.assets.push({logicalId,target,content,mode,ownership:{kind:'file'},source:{kind:'quality-template',ref:'1',digest:digest(content)}});
 add('quality:config','.rigup/checks.json',JSON.stringify(config,null,2)+'\n');add('quality:script','.rigup/scripts/check-snapshot.mjs',await readFile(new URL('../../../templates/scripts/check-snapshot.mjs',import.meta.url),'utf8'));
 for(const [kind,selected] of [['pre-commit',q.preCommit],['pre-push',q.prePush]] as const)if(selected?.length){
  try{const gitPath=(await exec('git',['-C',profile.root,'rev-parse','--git-path','hooks/'+kind])).stdout.trim();const absolute=resolve(profile.root,gitPath);const target=relative(profile.root,absolute);if(target.startsWith('..')||isAbsolute(target))throw new Error('shared hooks are outside selected worktree');
   add('quality:'+kind,target,'#!/bin/sh\nrigup_root=$(git rev-parse --show-toplevel) || exit 1\nexec node "$rigup_root/.rigup/scripts/check-snapshot.mjs" '+kind+' "$rigup_root/.rigup/checks.json"\n',0o755);
  }catch{result.requirements.push({integrationId:'quality:'+kind,reason:'Native hooks path unavailable or outside worktree; configure manually without replacing existing hooks'});}
 }
 if(q.gitlab){const ci=await prepareGitlab(profile.root,q.gitlab);result.assets.push(...ci.assets);result.requirements.push(...ci.requirements);result.warnings.push('GitLab syntax and runner environment require live CI lint/runner verification; OpenWiki credentials/provisioning are CI prerequisites');}
 return result;
}

export async function runProjectChecks(profile:ProjectProfile,kinds:CheckKind[],signal?:AbortSignal):Promise<import('../../installer/apply.js').CheckResult[]>{
 const results:import('../../installer/apply.js').CheckResult[]=[];
 for(const kind of kinds){const commands=profile.commands[kind]??[];if(!commands.length){results.push({name:kind,status:'pending',message:'No existing command; not evaluated'});continue;}
  for(const command of commands){
   const startedAt=new Date().toISOString();const common={name:kind,command,fingerprint:profile.fingerprint,commit:profile.git.head??'unavailable',startedAt,environment:{node:process.version,platform:process.platform}};
   if(signal?.aborted){results.push({...common,status:'pending',message:'Cancelled before check',finishedAt:new Date().toISOString()});continue;}
   const cwd=await realpath(resolve(profile.root,command.cwd));const rel=relative(profile.root,cwd);if(rel.startsWith('..')||isAbsolute(rel))throw new Error('check cwd outside project');
   const {spawn}=await import('node:child_process');const child=spawn(command.executable,command.args,{cwd,shell:false,detached:true,stdio:'ignore',env:process.env});
   const result=await new Promise<{status:'passed'|'failed'|'pending';exitCode:number;message?:string}>(done=>{
    let cancelled=false;const stop=()=>{cancelled=true;try{process.kill(-child.pid!,'SIGKILL');}catch{}};const timer=setTimeout(stop,60000);signal?.addEventListener('abort',stop,{once:true});
    child.once('error',()=>{clearTimeout(timer);signal?.removeEventListener('abort',stop);done({status:'failed',exitCode:1,message:'Existing command unavailable'});});
    child.once('close',code=>{clearTimeout(timer);signal?.removeEventListener('abort',stop);let active=false;try{process.kill(-child.pid!,0);active=true;process.kill(-child.pid!,'SIGKILL');}catch{}done({status:cancelled?'pending':code===0&&!active?'passed':'failed',exitCode:code??1,...(active?{message:'Check left a process running; result cannot be accepted'}:{})});});
   });results.push({...common,...result,finishedAt:new Date().toISOString()});
  }
 }
 return results;
}
