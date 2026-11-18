import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import {isAbsolute,join,relative} from 'node:path';
import {scanNativeEntries,type ProjectProfile} from '../../analyzer/repository.js';
import {terminalText} from '../../cli-output.js';
import {privateDirectory} from '../../generator/cache.js';
import {loadOptions} from '../../config.js';
import {loadManifest} from '../../installer/baseline.js';
import {interruptedInstallApplyId,interruptedSeedApplyId} from '../../installer/apply.js';
import {acquireLock,type ProjectLock} from '../../installer/lock.js';
import {assertNoUnknownWriters} from '../../installer/operations.js';
import {agents as hostInfo,projectCommandRoots} from '../agents/index.js';
import {quoteShell} from '../../shell-command.js';
import type {Agent} from '../../types.js';
import {NativeBlocker,toBlocker,type Blocker} from './blockers.js';
import {t,translate} from '../../i18n/index.js';
import {choice} from '../../prompt.js';
import {claudeArgs,claudeCommand,claudeRecognized,inspectClaude,prepareClaudeScratch,type ClaudeStep,type ClaudeTarget} from './claude.js';
import {stamp,statIfPresent} from './host-files.js';
import {claudePlugin,ompPackage,superpowersManual,superpowersReadiness,supportedHost} from './manual.js';
import {storePackage,verifyOmpStore} from './omp-archive.js';
import {resolveOmpPin,type OmpPin} from './omp-pin.js';
import {downloadOmp,inspectOmp,installOmpStore,ompArgs,ompCommand,ompRecognized} from './omp.js';
import {claudeCliVersion,ompCliVersion} from './pins.js';
import {bindingFrom} from './receipt.js';
import {consumerEnvironment,inspectHostLocations,inspectHostRuntime,nativeChildEnv,nativeHome,withHostWriter,type HostCommand,type HostRuntime,type NativeInputs,type SetupHost} from './runtime.js';

export interface NativeSetupServices extends NativeInputs {
 signal?:AbortSignal;
 fetch?:typeof fetch;
 launch?:(command:HostCommand,cwd:string)=>Promise<{code:number;output?:string}>;
}
type Write={level:'project'|'config'|'cache'|'state';path:string};
type Step={id:ClaudeStep|'link';command:string;pin:string;writes:Write[];undo?:string};
type Planned={
 host:'claude';runtime:HostRuntime;recipe:Awaited<ReturnType<typeof inspectClaude>>;steps:Step[];
}|{
 host:'omp';runtime:HostRuntime;recipe:Awaited<ReturnType<typeof inspectOmp>>;pin:OmpPin;store:string;stored:boolean;steps:Step[];
};
type Entry={
 host:Agent;status:'ready'|'manual'|'action';reason?:string;action?:Planned;blocker?:Blocker;recognizedPaths?:string[];
};
const executionOrder:Agent[]=['claude','omp','codex','opencode'];
const scan=async(root:string,hosts:Agent[],input:NativeInputs)=>{
 const env=consumerEnvironment(input.env??(input.home?{}:process.env));
 const home=nativeHome(input,env);
 return scanNativeEntries(root,{agents:hosts,sdd:'superpowers',backend:'host',
  scope:hosts.flatMap(agent=>[hostInfo[agent].skillDirectory,...projectCommandRoots[agent]])},{home,env});
};
async function inspectStore(store:string,pin:OmpPin){
 try{return await verifyOmpStore(store,pin);}
 catch{throw new NativeBlocker('host-plugin-broken','The existing OMP store could not be verified against the approved package.',{evidence:[store]});}
}
const commandLine=(runtime:HostRuntime,args:string[])=>[runtime.program.file,...runtime.program.args,...args].map(quoteShell).join(' ');
function claudeStep(runtime:HostRuntime,recipe:Awaited<ReturnType<typeof inspectClaude>>,id:ClaudeStep):Step{
 const writes:Write[]=[{level:'project',path:recipe.project},{level:'cache',path:recipe.configFile},{level:'cache',path:recipe.backups}];
 const command=commandLine(runtime,claudeArgs(id));
 if(id==='marketplace')return {id,command,pin:'Current official marketplace metadata',
  writes:[...writes,{level:'cache',path:recipe.known},{level:'cache',path:recipe.catalogRoot}]};
 const {target}=recipe;
 if(!target)throw new NativeBlocker('claude-catalog-no-entry','The official Claude catalog did not provide an installation target.',{evidence:[recipe.catalog]});
 return {id,command,pin:target.version?'Superpowers '+target.version+' at '+target.sha:'Superpowers at '+target.sha+' (catalog version unavailable)',
  writes:[...writes,{level:'cache',path:recipe.registry},{level:'cache',path:recipe.packageRoot}],
  undo:'claude plugin uninstall '+claudePlugin+' --scope project --keep-data'};
}
async function planHost(root:string,host:SetupHost,input:NativeSetupServices):Promise<Planned>{
 const runtime=await inspectHostRuntime(root,host,input);
 if(host==='claude'){
  const recipe=await inspectClaude(runtime);
  const steps:Step[]=[];
  if(recipe.market==='missing'||!recipe.declared)steps.push(claudeStep(runtime,recipe,'marketplace'));
  if(recipe.target)steps.push(claudeStep(runtime,recipe,'install'));
  return {host,runtime,recipe,steps};
 }
 const recipe=await inspectOmp(runtime);
 const pin=await resolveOmpPin(input.fetch,input.signal),store=storePackage(runtime,pin);
 const stored=await inspectStore(store,pin);
 return {host,runtime,recipe,pin,store,stored,steps:[{id:'link',command:commandLine(runtime,ompArgs(store)),
  pin:ompPackage+'@'+pin.version+' '+pin.tarball+' '+pin.integrity,
  writes:[{level:'config',path:recipe.plugins},{level:'config',path:recipe.lock},{level:'config',path:recipe.manifest},
   {level:'config',path:recipe.target},{level:'config',path:recipe.locations.state},{level:'config',path:recipe.locations.cache},
   {level:'state',path:store}],undo:'omp plugin uninstall '+ompPackage}]};
}

const inspectLocal=(host:SetupHost,locations:Awaited<ReturnType<typeof inspectHostLocations>>)=>
 host==='claude'?inspectClaude(locations):inspectOmp(locations);

export async function nativePreparationProblem(root:string,host:SetupHost,input:NativeInputs={}){
 try{await inspectLocal(host,await inspectHostRuntime(root,host,input));return;}
 catch(error){return toBlocker(host,error).reason;}
}

const sourcePaths=(profile:ProjectProfile,host:Agent)=>(profile.skillSources?.[host]??[])
 .filter(source=>!source.identity.endsWith(':unavailable')).slice(0,20)
 .map(source=>isAbsolute(source.identity)?source.identity:join(profile.root,source.identity));

async function existingProblem(profile:ProjectProfile,host:SetupHost,input:NativeInputs){
 const diagnostics=profile.nativeDiagnostics?.filter(item=>item.agent===host)??[];
 const evidence=[...diagnostics.flatMap(item=>item.evidence??[]),...sourcePaths(profile,host)].slice(0,30);
 try{
  const inspected=await inspectLocal(host,await inspectHostLocations(profile.root,host,input));
  return toBlocker(host,new NativeBlocker('host-plugin-broken','Existing Superpowers sources are incomplete or conflicting.'),
   {evidence:[...evidence,...('registry' in inspected?[inspected.registry,inspected.project]:[inspected.target,inspected.lock])]});
 }catch(error){return toBlocker(host,error,{evidence});}
}

async function currentReviewPolicy(root:string){
 const manifest=await loadManifest(root);
 return (await loadOptions(root,{},undefined,{fallback:manifest?.options})).executionPolicy?.mode==='review';
}

export async function planNativePreparation(root:string,hosts:Agent[],input:NativeSetupServices={}){
 const profile=await scan(root,hosts,input);
 const entries:Entry[]=[];
 for(const host of executionOrder.filter(host=>hosts.includes(host))){
  const readiness=superpowersReadiness(profile,host);
  if(readiness.status==='ready'){entries.push({host,status:'ready',recognizedPaths:sourcePaths(profile,host)});continue;}
  if(!supportedHost(host)){entries.push({host,status:'manual',reason:readiness.reason});continue;}
  if(readiness.status==='manual'){
   const blocker=await existingProblem(profile,host,input);
   entries.push({host,status:'manual',reason:blocker.reason,blocker});continue;
  }
  try{
   const action=await planHost(root,host,input);
   entries.push({host,status:'action',action,reason:readiness.reason});
  }catch(error){
   const blocker=toBlocker(host,error);
   entries.push({host,status:'manual',reason:blocker.reason,blocker});
  }
 }
 return {root,hosts,entries};
}
export type NativePreparation=Awaited<ReturnType<typeof planNativePreparation>>;
const verifiedVersion=(host:Agent)=>host==='claude'?claudeCliVersion:ompCliVersion;
export function describeNativePreparation(plan:NativePreparation){
 return {kind:'superpowers',blockers:plan.entries.flatMap(entry=>entry.blocker?[entry.blocker]:[]),hosts:plan.entries.map(({host,status,reason,action})=>({
  host,status,reason,...(status==='ready'?{}:{manual:superpowersManual[host]}),steps:action?.steps??[],
  ...(action?{launcher:{requiredVersion:verifiedVersion(host),verifiedVersion:verifiedVersion(host),
    versionCommand:commandLine(action.runtime,['--version']),temporaryUnder:action.runtime.stateRoot,writerState:action.runtime.writerRoot}}:{}),
  ...(action?.host==='omp'?{envReport:action.recipe.envReport}:{}),
  ...(action?.host==='claude'&&!action.recipe.target?{conditional:'Rigup will show the Claude plugin target and ask for approval after adding the marketplace.'}:{}),
  ...(host==='omp'&&status!=='ready'&&plan.entries.some(entry=>entry.host==='claude'&&entry.action)?{conditional:'Skip the user plugin link if the approved Claude project install supplies the full OMP workflow.'}:{}),
 }))};
}

export type NativeProgress={host:Agent;status:'recognized'|'ready'|'manual'|'stopped'|'uncertain';message:string;
 step?:Step['id'];code?:number|null;changes?:string[];undo?:string;pin?:string;blocker?:Blocker;
 stage?:'version'|'store';cliVersion?:string;installedVersion?:string;installedSha?:string;installPath?:string};
type RunCode=0|1|3|130;
type NativeProjectChange={path:string;undo?:string;marketplaceAdded?:true};
type ProjectEffects={projectChanges:NativeProjectChange[];uncertainProjectPaths:string[]};
export interface NativeSetupEffects {
 projectChanges:readonly NativeProjectChange[];
 uncertainProjectPaths:readonly string[];
 reloadRecommended:boolean;
}
type RunResult={exitCode:RunCode;progress:NativeProgress[];effects:NativeSetupEffects};
type ConfirmClaudeInstall=(step:Step,target:ClaudeTarget)=>Promise<boolean>;

const needsReview=(reason:string,evidence:string[])=>new NativeBlocker('native-target-changed',reason,{evidence});
function compareDestinations(expected:string[],current:string[]){
 const changed=expected.findIndex((path,index)=>relative(path,current[index])!=='');
 if(changed!==-1)throw needsReview('Native preparation destination changed after approval. Review a fresh plan.',[expected[changed],current[changed]]);
}

const sameClaudeTarget=(before:ClaudeTarget|undefined,after:ClaudeTarget|undefined)=>before?.sha===after?.sha&&before?.version===after?.version;
function targetChanged(expected:Planned,current:Planned){
 if(expected.host==='claude'&&current.host==='claude'){
  const before=expected.recipe,after=current.recipe;
  return before.market!==after.market||before.declared!==after.declared||before.installed!==after.installed||
   !sameClaudeTarget(before.target,after.target);
 }
 return expected.host==='omp'&&current.host==='omp'&&
  (expected.recipe.linked!==current.recipe.linked||expected.stored&&!current.stored);
}

async function visibleChanges(paths:Write[]){
 return new Map(await Promise.all(paths.map(async ({path})=>{
  try{const info=await statIfPresent(path);return [path,info&&stamp(info)] as const;}
  catch{return [path,'unavailable'] as const;}
 })));
}

function addBlocker(progress:NativeProgress[],blocker:Blocker,status:'manual'|'stopped'|'uncertain'='stopped',
 details:Pick<NativeProgress,'step'|'code'|'pin'|'changes'>={}){
 progress.push({host:blocker.host,status,message:blocker.reason,blocker,...details});
}

function rescanEvidence(state:Planned,after:Planned|undefined,latest:ProjectProfile|undefined){
 if(state.host==='claude'){
  const receipt=after?.host==='claude'?after.recipe:undefined;
  return [state.recipe.catalog,receipt?.installed,
   'Approved SHA '+(state.recipe.target?.sha??'unavailable'),'Installed SHA '+(receipt?.installedSha??'unavailable'),
   ...(state.recipe.target?.version?['Approved version '+state.recipe.target.version]:[]),
   ...(receipt?.installedVersion?['Installed version '+receipt.installedVersion]:[])].filter((item):item is string=>item!==undefined);
 }
 const {envReport,shadowEvidence}=after?.host==='omp'?after.recipe:state.recipe;
 return [...shadowEvidence,...envReport.pathKeys.map(({file,key})=>file+' ('+key+')'),
  ...envReport.unreadable.map(file=>file+' (could not inspect)'),
  ...(latest?sourcePaths(latest,'omp'):[])];
}

class UncertainNativeWriter extends NativeBlocker {
 constructor(evidence:string[]){
  super('native-writer-unverified','Host process termination or its effects could not be established.',{evidence,agentCanDraft:false});
 }
}

async function executeHost(approved:Planned,lock:ProjectLock,input:NativeSetupServices,progress:NativeProgress[],effects:ProjectEffects,confirmClaudeInstall?:ConfirmClaudeInstall):Promise<RunCode>{
 const {host,runtime}=approved,{root,stateRoot,writerRoot}=runtime;
 const {signal}=input;
 const stop=(error:unknown,exitCode:1|3):1|3|130=>{
  if(signal?.aborted)return 130;
  addBlocker(progress,toBlocker(host,error,{evidence:error instanceof NativeBlocker?[]:approved.recipe.paths}));
  return exitCode;
 };
 const readTarget=async ():Promise<Planned>=>{
  const current=await inspectHostRuntime(root,host,input);
  compareDestinations([root,runtime.home,stateRoot,writerRoot],[current.root,current.home,current.stateRoot,current.writerRoot]);
  if(relative(runtime.program.file,current.program.file)!==''||runtime.program.args.join('\0')!==current.program.args.join('\0'))
   throw needsReview('The native CLI launcher changed after approval. Review a fresh plan.',[runtime.program.file,current.program.file]);
  const observed:Planned=approved.host==='claude'
   ?{...approved,recipe:await inspectClaude(current)}
   :{...approved,recipe:await inspectOmp(current),stored:await inspectStore(approved.store,approved.pin)};
  compareDestinations(approved.recipe.paths,observed.recipe.paths);
  return observed;
 };
 const changed=()=>needsReview('Native targets changed after approval. Review a fresh plan.',
  approved.host==='claude'?[approved.recipe.catalog,approved.recipe.project]:[approved.recipe.target,approved.store]);
 let dispatching=false;
 let projectTargets:string[]=[];
 try{
  return await withHostWriter<RunCode>(lock,host,async runner=>{
   let state:Planned;
   try{state=await readTarget();}catch(error){return stop(error,3);}
   if(targetChanged(approved,state))return stop(changed(),3);
   const scratch=await mkdtemp(join(await privateDirectory(lock.stateRoot,root),'native-')),work=join(scratch,'work');
   try{
    await mkdir(work,{mode:0o700});
    if(host==='claude')await prepareClaudeScratch(scratch);
    let dispatchBlocker:Blocker|undefined;
    const guard=async()=>{
     if(signal?.aborted)return 'Native preparation canceled before dispatch.';
     try{
      if(await currentReviewPolicy(root))throw needsReview('The project now requires review. Native preparation needs a fresh plan.',[root]);
      const observed=await readTarget();
      if(targetChanged(state,observed))throw changed();
      if(superpowersReadiness(await scan(root,[host],input),host).status!=='missing')
       throw needsReview('Native entry sources changed after approval. Review a fresh plan.',[root,...state.recipe.paths]);
     }catch(error){
      dispatchBlocker=toBlocker(host,error);
      return dispatchBlocker.reason;
     }
    };
    const beforeDispatch=(reason:string|undefined):3|130=>{
     if(signal?.aborted)return 130;
     addBlocker(progress,dispatchBlocker??toBlocker(host,needsReview(reason??'Native preparation stopped before dispatch.',[root])));
     return 3;
    };
    const run=async(command:HostCommand,cwd:string,timeout:number,capture?:(bytes:Buffer)=>void)=>{
     dispatchBlocker=undefined;
     if(input.launch){
      const blocked=await guard();
      if(blocked)return {code:null,blocked,dispatched:false,cancelled:!!signal?.aborted};
      try{
       const result=await input.launch(command,cwd);
       if(capture&&result.output)capture(Buffer.from(result.output));
       return {code:result.code,blocked:undefined,dispatched:true,cancelled:!!signal?.aborted};
      }catch{return {code:null,blocked:undefined,dispatched:true,cancelled:!!signal?.aborted};}
     }
     dispatching=true;
     const result=await runner.run(command,cwd,timeout,guard,capture);
     dispatching=false;
     return result;
    };

    // Verify downloaded bytes before running the host or touching its package destinations.
    let bytes:Buffer|undefined;
    if(state.host==='omp'&&!state.stored)try{bytes=await downloadOmp(state.pin,signal,input.fetch);}
    catch(error){return stop(error,3);}
    let version='';
    const program=runtime.program;
    const probe=await run({executable:program.file,args:[...program.args,'--version'],env:nativeChildEnv(runtime,scratch)},work,20_000,
     chunk=>{version+=(chunk.toString('utf8').slice(0,4097-version.length));});
    if(!probe.dispatched)return beforeDispatch(probe.blocked);
    if(probe.code!==0||probe.cancelled||!version.trim())
     return stop(new NativeBlocker('cli-not-runnable','The '+host+' CLI did not return a version successfully.',{evidence:[program.file]}),1);
    const knownVersion=verifiedVersion(host);
    const detected=/^(?:omp\/)?([0-9]{1,9}\.[0-9]{1,9}\.[0-9]{1,9}(?:[-+][A-Za-z0-9.+-]{1,96})?)(?: \(Claude Code\))?$/.exec(version.trim())?.[1];
    if(detected!==knownVersion)progress.push({host,status:'ready',stage:'version',
     message:detected?'CLI version '+detected+' differs from the verified '+knownVersion+'. Continuing.':
      'The CLI responded to --version. Its output could not be compared with the verified '+knownVersion+'. Continuing.',
     ...(detected?{cliVersion:detected}:{})});
    if(state.host==='omp'&&bytes){
     const blocked=await guard();
     if(blocked)return beforeDispatch(blocked);
     try{await installOmpStore(runtime,bytes,state.pin);}
     catch{
      return stop(new NativeBlocker('download-failed','The approved OMP archive could not be staged and verified.',{evidence:[state.pin.tarball,state.store]}),3);
     }
     state={...state,stored:true};
     progress.push({host,status:'ready',stage:'store',message:'Verified OMP package stored at '+state.store});
    }

    const steps=[...approved.steps];
    for(const step of steps){
     projectTargets=step.writes.filter(item=>item.level==='project').map(item=>item.path);
     const before=await visibleChanges(step.writes);
     const command=state.host==='claude'?claudeCommand(runtime,scratch,step.id as ClaudeStep):ompCommand(runtime,state.store,scratch);
     const outcome=await run(command,state.host==='claude'?root:work,900_000);
     if(!outcome.dispatched)return beforeDispatch(outcome.blocked);
     const [observed,rescanned]=await Promise.allSettled([readTarget(),scan(root,[host],input)]);
     const after=observed.status==='fulfilled'?observed.value:undefined;
     const latest=rescanned.status==='fulfilled'?rescanned.value:undefined;
     const afterWrites=await visibleChanges(step.writes);
     const changes=[...afterWrites].filter(([path,value])=>value!==before.get(path)).map(([path])=>path);
     const marketplaceAdded=step.id==='marketplace'&&state.host==='claude'&&!state.recipe.declared&&after?.host==='claude'&&after.recipe.declared;
     const projectChanges:NativeProjectChange[]=[];
     for(const path of projectTargets){
      const prior=before.get(path),current=afterWrites.get(path);
      if(prior==='unavailable'||current==='unavailable'||(!after&&prior===current)){
       effects.uncertainProjectPaths.push(path);
      }else if(prior!==current||marketplaceAdded){
       projectChanges.push({path,...(marketplaceAdded?{marketplaceAdded:true}:{})});
      }
     }
     effects.projectChanges.push(...projectChanges);
     const stepProgress={step:step.id,code:outcome.code,changes,pin:step.pin};
     const evidence=[...step.writes.map(item=>item.path),
      ...(observed.status==='rejected'?toBlocker(host,observed.reason).evidence:[])];
     const failStep=(problem:NativeBlocker):1=>{
      addBlocker(progress,toBlocker(host,problem,{evidence,suggest:step.undo?[step.undo]:[]}), 'stopped',stepProgress);
      return 1;
     };
     if(signal?.aborted){
      progress.push({host,status:'stopped',message:'Native preparation canceled after dispatch.',...stepProgress});
      return 130;
     }
     if(outcome.code!==0||outcome.cancelled)return failStep(new NativeBlocker('install-command-failed','The '+host+' '+step.id+' command failed.'));

     if(step.id==='marketplace'&&state.host==='claude'){
      if(after?.host!=='claude'||!after.recipe.declared||!after.recipe.target){
       const error=observed.status==='rejected'&&observed.reason instanceof NativeBlocker?observed.reason:
        new NativeBlocker('claude-catalog-no-entry','Could not verify the official marketplace and its project declaration.',{evidence:[state.recipe.catalog]});
       return failStep(error);
      }
      if(state.recipe.target&&!sameClaudeTarget(state.recipe.target,after.recipe.target))return failStep(changed());
      const needsApproval=!state.recipe.target;
      state=after;
      progress.push({host,status:'recognized',message:'Official marketplace and its project declaration verified.',...stepProgress});
      if(needsApproval){
       const install=claudeStep(runtime,state.recipe,'install');
       if(!confirmClaudeInstall)return stop(new NativeBlocker('native-approval-required','Approve the specific Claude plugin target before installation.',{evidence:[state.recipe.catalog]}),3);
       if(!await confirmClaudeInstall(install,after.recipe.target)||signal?.aborted)return 130;
       steps.push(install);
      }
      continue;
     }

     const receipt=after?.host==='claude'?after.recipe:undefined;
     const target=state.host==='claude'?state.recipe.target:undefined;
     const verified=after&&latest&&(after.host==='claude'?
      target&&sameClaudeTarget(target,receipt?.target)&&receipt?.installedSha===target.sha&&
       (!target.version||receipt.installedVersion===target.version)&&claudeRecognized(after.recipe,latest):
      after.stored&&ompRecognized(after.recipe,latest,after.store));
     if(!verified)return failStep(new NativeBlocker(host+'-not-recognized-after-install',
      'Could not verify the approved '+host+' Superpowers install after rescanning.',{evidence:rescanEvidence(state,after,latest)}));
     const installedVersion=receipt?.installedVersion,installedSha=receipt?.installedSha;
     if(step.undo)for(const change of projectChanges)change.undo=step.undo;
     progress.push({host,status:'recognized',message:'recognized; reopen the host to pick it up.'+
      (installedSha?' Installed Superpowers'+(installedVersion?' '+installedVersion:'')+' at '+installedSha+'.':''),
      ...stepProgress,undo:step.undo,...(receipt?{installedVersion,installedSha,installPath:receipt.installed}:{})});
    }
    return 0;
   }finally{if(!dispatching)await rm(scratch,{recursive:true,force:true,maxRetries:3});}
  },signal,writerRoot);
 }catch(error){
  if(!dispatching)throw error;
  effects.uncertainProjectPaths.push(...projectTargets);
  throw new UncertainNativeWriter([writerRoot,...approved.recipe.paths]);
 }
}

export async function executeNativePreparation(plan:NativePreparation,input:NativeSetupServices={},confirmClaudeInstall?:ConfirmClaudeInstall):Promise<RunResult>{
 const {root}=plan,progress:NativeProgress[]=[];
 const effects:ProjectEffects={projectChanges:[],uncertainProjectPaths:[]};
 const end=(exitCode:RunCode):RunResult=>({exitCode,progress,effects:{
  ...effects,reloadRecommended:progress.some(item=>item.status==='recognized'&&(item.step==='install'||item.step==='link')),
 }});
 if(input.signal?.aborted)return end(130);
 const initial=plan.entries.find(entry=>entry.action)?.action;
 if(!initial)return end(plan.entries.every(entry=>entry.status==='ready')?0:3);
 let currentHost:Agent=initial.host,exit:RunCode=0;
 try{
  const lock=await acquireLock(root,{stateRoot:initial.runtime.stateRoot,recover:true});
  try{
   await assertNoUnknownWriters(root,lock.stateRoot);
   if(await currentReviewPolicy(root))throw needsReview('The project now requires review. Native preparation needs a fresh plan.',[root]);
   if(await interruptedInstallApplyId(root,lock.stateRoot)||await interruptedSeedApplyId(root,lock.stateRoot))
    throw new NativeBlocker('native-writer-unverified','Reconcile the interrupted Rigup installation before native preparation.',{evidence:[lock.stateRoot],agentCanDraft:false});
   for(const entry of plan.entries){
    currentHost=entry.host;
    if(input.signal?.aborted)return end(130);
    const profile=await scan(root,[currentHost],input),ready=superpowersReadiness(profile,currentHost);
    if(ready.status==='ready'){
     const claudePath=progress.find(item=>item.host==='claude'&&item.step==='install'&&item.status==='recognized')?.installPath;
     const imported=currentHost==='omp'&&claudePath&&bindingFrom(profile,'omp',claudePath,'superpowers');
     progress.push({host:currentHost,status:imported?'recognized':'ready',message:imported?
      'recognized via the Claude project plugin; reopen the host to pick it up. No OMP user plugin was linked.':
      'Native Superpowers sources are already recognized; no setup needed.'});
     continue;
    }
    if(!entry.action||ready.status==='manual'){
     let blocker=entry.blocker;
     if(supportedHost(currentHost)){
      if(ready.status==='manual')blocker=await existingProblem(profile,currentHost,input);
      else if(entry.status==='ready')blocker=toBlocker(currentHost,needsReview(
       'Previously recognized Superpowers sources disappeared after approval. Review a fresh plan.',entry.recognizedPaths?.length?entry.recognizedPaths:[root]));
     }
     if(blocker)addBlocker(progress,blocker,'manual');
     else progress.push({host:currentHost,status:'manual',message:entry.reason??ready.reason});
     exit=exit||3;
     continue;
    }
    const hostExit=await executeHost(entry.action,lock,input,progress,effects,confirmClaudeInstall);
    if(hostExit===130)return end(130);
    if(hostExit===1||hostExit===3&&exit===0)exit=hostExit;
   }
   return end(exit);
  }finally{await lock.release();}
 }catch(error){
  if(input.signal?.aborted)return end(130);
  const uncertain=error instanceof UncertainNativeWriter;
  const blocker=toBlocker(currentHost,error instanceof NativeBlocker?error:
   new NativeBlocker('native-writer-unverified','The native writer state could not be verified. Review it before retrying.',{
    evidence:[root,initial.runtime.stateRoot,initial.runtime.writerRoot],agentCanDraft:false,
   }));
  addBlocker(progress,blocker,uncertain?'uncertain':'stopped');
  return end(uncertain||exit===1?1:3);
 }
}

function describeOutcome(description:ReturnType<typeof describeNativePreparation>,progress:NativeProgress[]){
 const last=new Map(progress.map(item=>[item.host,item]));
 const ready=(host:Agent)=>{
  const item=last.get(host);
  return item?.status==='ready'&&!item.stage||item?.status==='recognized'&&item.step!=='marketplace';
 };
 const blockers=description.hosts.flatMap(({host})=>{
  const blocker=last.get(host)?.blocker??description.blockers.find(item=>item.host===host);
  return blocker&&!ready(host)?[blocker]:[];
 });
 const hosts=description.hosts.map(item=>{
  if(ready(item.host))return {...item,status:'ready' as const,reason:undefined,manual:undefined,conditional:undefined};
  const blocker=blockers.find(blocker=>blocker.host===item.host);
  return blocker?{...item,status:'manual' as const,reason:blocker.reason}:item;
 });
 return {...description,hosts,blockers,progress};
}

function nativeProgressMessage(item:NativeProgress):string{
 if(item.blocker||item.status==='manual'||item.status==='uncertain')return item.message;
 if(item.stage==='version'){
  const version=verifiedVersion(item.host);
  return item.cliVersion?t('native.versionDiffers',{detected:item.cliVersion,version}):t('native.versionUncompared',{version});
 }
 if(item.stage==='store')return t('native.ompStored',{path:item.message.slice('Verified OMP package stored at '.length)});
 if(item.status==='recognized'){
  if(!item.step)return t('native.imported');
  if(item.step==='marketplace')return t('native.marketplaceVerified');
  const ready=t('native.recognized');
  if(!item.installedSha)return ready;
  const receipt=item.installedVersion?
   t('native.receiptVersion',{version:item.installedVersion,sha:item.installedSha}):t('native.receiptSha',{sha:item.installedSha});
  return ready+' '+receipt;
 }
 if(item.status==='ready')return t('native.ready');
 return item.step?t('native.canceledAfterDispatch'):item.message;
}

function nativeManualText(host:Agent){
 const command=superpowersManual[host];
 if(host==='omp')return t('native.manualOmp');
 if(host==='codex')return t('native.manualCodex');
 if(host==='opencode')return t('native.manualOpenCode');
 return command;
}

export async function nativeSetupInteraction(root:string,hosts:Agent[],input:NativeSetupServices,ui:{
 write:(message:string)=>void;report?:(value:Record<string,unknown>)=>void;
 ask:import('../../prompt.js').Ask;inspect:boolean;canPrompt:boolean;back?:boolean;isTTY?:boolean;verbose?:boolean;
 onEffects?:(effects:NativeSetupEffects)=>void;
}):Promise<0|1|3|130|'back'>{
 const {nativePreparationCommand}=await import('./manual.js');
 const plan=await planNativePreparation(root,hosts,input),description=describeNativePreparation(plan);
 const ready=plan.entries.every(entry=>entry.status==='ready'),hasAction=plan.entries.some(entry=>entry.action);
 const nextCommand=nativePreparationCommand(root,hosts);
 const write=(message:string)=>ui.write(terminalText(message)+'\n');
 const writeBlockers=(blockers:Blocker[])=>{
  for(const blocker of blockers){
   write(t('native.blocker',{host:blocker.host,code:blocker.code,reason:blocker.reason}));
   for(const path of blocker.evidence)write('  '+t('native.evidence',{path}));
   for(const command of blocker.suggest)write('  '+t('native.suggest',{command}));
  }
  if(blockers.length)write(t('native.agentNote'));
 };
 const report=(exitCode:RunCode,outcome=describeOutcome(description,[]),pending:string[]=[])=>
  ui.report?.({phase:'native-preparation',installStatus:ui.inspect?'not-applicable':exitCode===0?(ready?'up-to-date':'complete'):exitCode===3?'pending':'failed',
   nativePreparation:outcome,pending,...(!ready&&exitCode!==0&&(hasAction||outcome.blockers.length)?{nextCommand}:{})});
 const writeStep=(step:Step,target?:ClaudeTarget)=>{
  const pin=step.id==='marketplace'?t('native.marketplacePin'):target?
   target.version?t('native.superpowersPin',{version:target.version,sha:target.sha}):t('native.shaOnlyPin',{sha:target.sha}):step.pin;
  write('  '+step.command+' ('+pin+')');
  for(const item of step.writes)write('    '+t(`native.${item.level}`)+': '+item.path+
   (item.level==='project'?t('native.sharedSettings'):''));
 };
 const compactGate=ui.isTTY===false&&!ui.inspect&&!ready&&hasAction&&!ui.canPrompt&&!input.signal?.aborted;
 const writeApprovalRequired=()=>{
  write(t('native.approvalRequired'));
  write(nextCommand);
 };
 if(compactGate)writeApprovalRequired();
 if(!compactGate||ui.verbose)for(const entry of description.hosts){
  write(entry.host+': '+(entry.status==='ready'?t('native.ready'):entry.reason??entry.status));
  if(entry.launcher)write('  '+t('native.verifyCli',{version:entry.launcher.verifiedVersion,command:entry.launcher.versionCommand,
   work:entry.launcher.temporaryUnder,state:entry.launcher.writerState}));
  const action=plan.entries.find(({host})=>host===entry.host)?.action;
  for(const step of entry.steps)writeStep(step,action?.host==='claude'?action.recipe.target:undefined);
  if(entry.envReport){
   const {files,pathKeys,unreadable}=entry.envReport;
   for(const file of new Set([...files,...pathKeys.map(item=>item.file)])){
    const keys=pathKeys.filter(item=>item.file===file).map(item=>item.key);
    if(unreadable.includes(file))write('  '+t('native.envUnreadable',{file}));
    else if(keys.length)write('  '+t('native.envPathKeys',{file,keys:keys.join(', ')}));
    else write('  '+t('native.envChecked',{file}));
   }
  }
  if(entry.conditional)write('  '+t(entry.host==='claude'?'native.marketplaceConditional':'native.conditional'));
  if(entry.manual)write('  '+t('native.manual',{command:nativeManualText(entry.host)}));
 }
 writeBlockers(description.blockers);
 if(hasAction&&(!compactGate||ui.verbose))write(t('native.actionNotice'));
 if(input.signal?.aborted){report(130);return 130;}
 if(ui.inspect||ready){report(0);return 0;}
 if(!hasAction){report(3,undefined,['Some native workflow prerequisites need manual preparation.']);return 3;}
 if(!ui.canPrompt){
  if(!compactGate)writeApprovalRequired();
  report(3,undefined,[translate('en','native.approvalRequired')]);return 3;
 }
 const approvals=[choice('Cancel',t('choice.cancel')),choice('Approve',t('choice.approve'))];
 const answer=await ui.ask({message:t('native.approvePrompt'),choices:approvals,back:ui.back});
 if(answer==='back'&&ui.back)return 'back';
 if(!Array.isArray(answer)||answer.length!==1||answer[0]!=='Approve'||input.signal?.aborted){report(130);return 130;}
 const result=await executeNativePreparation(plan,input,async (step,target)=>{
  writeStep(step,target);
  const answer=await ui.ask({message:t('native.approveClaude'),choices:approvals});
  return Array.isArray(answer)&&answer.length===1&&answer[0]==='Approve';
 });
 ui.onEffects?.(result.effects);
 for(const item of result.progress){
  write(item.host+': '+nativeProgressMessage(item)+(item.code!==undefined?t('native.exit',{code:item.code??t('native.unknownExit')}):''));
  for(const path of item.changes??[])write('  '+t('native.observed',{path}));
  if(item.undo)write('  '+t('native.manualRemove',{command:item.undo}));
  if(item.status==='manual'||item.status==='stopped'||item.status==='uncertain')write('  '+t('native.manual',{command:nativeManualText(item.host)}));
 }
 const outcome=describeOutcome(description,result.progress);
 writeBlockers(outcome.blockers);
 if(result.exitCode!==0)write(t('native.retry',{command:nextCommand}));
 report(result.exitCode,outcome,result.progress.filter(item=>['stopped','manual','uncertain'].includes(item.status)).map(item=>item.message));
 return result.exitCode;
}
