import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import {isAbsolute,join,relative} from 'node:path';
import {scanNativeEntries,type ProjectProfile} from '../../analyzer/repository.js';
import {privateDirectory} from '../../generator/cache.js';
import {loadOptions} from '../../config.js';
import {loadManifest} from '../../installer/baseline.js';
import {interruptedInstallApplyId,interruptedSeedApplyId} from '../../installer/apply.js';
import {acquireLock,defaultStateRoot} from '../../installer/lock.js';
import {assertNoUnknownWriters} from '../../installer/operations.js';
import {agents as hostInfo,projectCommandRoots} from '../agents/index.js';
import {quoteShell} from '../../shell-command.js';
import type {Agent} from '../../types.js';
import {claudeArgs,claudeCommand,claudeRecognized,inspectClaude,prepareClaudeScratch,type ClaudeStep} from './claude.js';
import {stamp,statIfPresent,withinPath} from './host-files.js';
import {claudePlugin,ompPackage,superpowersManual,superpowersReadiness,supportedHost} from './manual.js';
import {ompConfigOverlay} from './omp-locations.js';
import {storePackage} from './omp-archive.js';
import {downloadOmp,inspectOmp,installOmpStore,ompArgs,ompCommand,ompRecognized} from './omp.js';
import {claudeCliVersion,claudeSha,claudeVersion,ompCliVersion,ompIntegrity,ompTarball,ompVersion} from './pins.js';
import {bindingFrom} from './receipt.js';
import {consumerEnvironment,hostGit,inspectHostLocations,inspectHostRuntime,nativeChildEnv,nativeHome,withHostWriter,type HostCommand,type HostRuntime,type NativeInputs,type SetupHost} from './runtime.js';

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
 host:'omp';runtime:HostRuntime;recipe:Awaited<ReturnType<typeof inspectOmp>>;steps:Step[];
};
type Entry={
 host:Agent;status:'ready'|'manual'|'action';reason?:string;action?:Planned;
};
const explain=(error:unknown,fallback:string)=>{
 if(!(error instanceof Error)||(error as NodeJS.ErrnoException).code||error instanceof SyntaxError||error.message.length>500||
    /[\x00-\x1f\x7f-\x9f]/.test(error.message))return fallback;
 return error.message;
};

const executionOrder:Agent[]=['claude','omp','codex','opencode'];
const scan=async(root:string,hosts:Agent[],input:NativeInputs)=>{
 const env=consumerEnvironment(input.env??(input.home?{}:process.env));
 const home=nativeHome(input,env);
 return scanNativeEntries(root,{agents:hosts,sdd:'superpowers',backend:'host',
  scope:hosts.flatMap(agent=>[hostInfo[agent].skillDirectory,...projectCommandRoots[agent]])},{home,env});
};
async function verifiedExisting(profile:ProjectProfile,host:Agent,input:NativeInputs){
 const ready=superpowersReadiness(profile,host);
 if(ready.status!=='ready'||host!=='omp')return ready;
 const env=consumerEnvironment(input.env??(input.home?{}:process.env)),home=nativeHome(input,env);
 const overlay=ompConfigOverlay(env);
 if(overlay)return {status:'manual' as const,reason:overlay+' selects an OMP config overlay; confirm the effective native entry in OMP.'};
 const stateRoot=input.stateRoot??(input.home?join(home,'.local','state','rigup'):defaultStateRoot());
 const store=storePackage({stateRoot});
 if(!profile.skillSources?.omp?.some(source=>source.packageName===ompPackage&&isAbsolute(source.identity)&&withinPath(store,source.identity)))return ready;
 try{
  const receipt=await inspectOmp({root:profile.root,home,env,stateRoot},{forWrite:false});
  if(ompRecognized(receipt,profile))return ready;
 }catch{/* A Rigup-managed link needs its verified store on every reuse. */}
 return {status:'manual' as const,reason:'The existing OMP link no longer matches the verified package; reconcile it manually.'};
}
const commandLine=(runtime:HostRuntime,args:string[])=>[runtime.program.file,...runtime.program.args,...args].map(quoteShell).join(' ');
async function planHost(root:string,host:SetupHost,input:NativeSetupServices):Promise<Planned>{
 const runtime=await inspectHostRuntime(root,host,input);
 if(host==='claude'){
  await hostGit(runtime);
  const recipe=await inspectClaude(runtime);
  const writes:Write[]=[
   {level:'project',path:recipe.project},
   {level:'cache',path:recipe.configFile},{level:'cache',path:recipe.backups},
  ];
  const steps:Step[]=[];
  if(recipe.market==='missing'||!recipe.declared)steps.push({id:'marketplace',command:commandLine(runtime,claudeArgs('marketplace')),
   pin:'Current official marketplace metadata',writes:[...writes,{level:'cache',path:recipe.known},{level:'cache',path:recipe.catalogRoot}]});
  steps.push({id:'install',command:commandLine(runtime,claudeArgs('install')),pin:'Superpowers '+claudeVersion+' at '+claudeSha,
   writes:[...writes,{level:'cache',path:recipe.registry},{level:'cache',path:recipe.install}],
   undo:'claude plugin uninstall '+claudePlugin+' --scope project --keep-data'});
  return {host,runtime,recipe,steps};
 }
 const recipe=await inspectOmp(runtime);
 return {host,runtime,recipe,steps:[{id:'link',command:commandLine(runtime,ompArgs(recipe.store)),
  pin:ompTarball+' '+ompIntegrity,
  writes:[{level:'config',path:recipe.plugins},{level:'config',path:recipe.lock},{level:'config',path:recipe.manifest},
   {level:'config',path:recipe.target},{level:'config',path:recipe.locations.state},{level:'config',path:recipe.locations.cache},
   {level:'state',path:recipe.store}],undo:'omp plugin uninstall '+ompPackage}]};
}

export async function nativePreparationProblem(root:string,host:SetupHost,input:NativeInputs={}){
 try{await planHost(root,host,input);return;}
 catch(error){return explain(error,'Native prerequisites could not be verified; prepare manually');}
}

async function currentReviewPolicy(root:string){
 const manifest=await loadManifest(root);
 return (await loadOptions(root,{},undefined,{fallback:manifest?.options})).executionPolicy?.mode==='review';
}

export async function planNativePreparation(root:string,hosts:Agent[],input:NativeSetupServices={}){
 const profile=await scan(root,hosts,input);
 const entries:Entry[]=[];
 for(const host of executionOrder.filter(host=>hosts.includes(host))){
  const readiness=await verifiedExisting(profile,host,input);
  if(readiness.status==='ready'){entries.push({host,status:'ready'});continue;}
  if(!supportedHost(host)||readiness.status==='manual'){entries.push({host,status:'manual',reason:readiness.reason});continue;}
  try{
   const action=await planHost(root,host,input);
   entries.push({host,status:'action',action,reason:readiness.reason});
  }catch(error){entries.push({host,status:'manual',reason:explain(error,'Native setup prerequisites could not be verified; prepare manually')});}
 }
 return {root,hosts,entries};
}
export type NativePreparation=Awaited<ReturnType<typeof planNativePreparation>>;
export function describeNativePreparation(plan:NativePreparation){
 return {kind:'superpowers',hosts:plan.entries.map(({host,status,reason,action})=>({
  host,status,reason,...(status==='ready'?{}:{manual:superpowersManual[host]}),steps:action?.steps??[],
  ...(action?{launcher:{requiredVersion:host==='claude'?claudeCliVersion:ompCliVersion,
    versionCommand:commandLine(action.runtime,['--version']),temporaryUnder:action.runtime.stateRoot,writerState:action.runtime.writerRoot}}:{}),
  ...(host==='omp'&&status!=='ready'&&plan.entries.some(entry=>entry.host==='claude'&&entry.action)?{conditional:'Skip the user plugin link if the approved Claude project install supplies the full OMP workflow.'}:{}),
 }))};
}

export type NativeProgress={host:Agent;status:'recognized'|'ready'|'manual'|'stopped'|'uncertain';message:string;
 step?:Step['id']; code?:number|null;changes?:string[];undo?:string};
type RunResult={exitCode:0|1|3|130;progress:NativeProgress[]};
const versionMatches=(host:SetupHost,text:string)=>{
 const version=host==='claude'?claudeCliVersion:ompCliVersion;
 return text.trim()===version||text.trim()===(host==='claude'?version+' (Claude Code)':'omp/'+version);
};
function compareDestinations(expected:string[],current:string[]){
 const changed=expected.findIndex((path,index)=>relative(path,current[index])!=='');
 if(changed!==-1)throw Error('Native preparation destination changed from '+expected[changed]+' to '+current[changed]+'; review a fresh plan.');
}

function targetChanged(expected:Planned,current:Planned){
 if(expected.host==='claude'&&current.host==='claude'){
  const before=expected.recipe,after=current.recipe;
  return before.market!==after.market||before.declared!==after.declared||before.installed!==after.installed;
 }
 return expected.host==='omp'&&current.host==='omp'&&expected.recipe.status!==current.recipe.status;
}

async function visibleChanges(paths:Write[]){
 return new Map(await Promise.all(paths.map(async ({path})=>{
  try{const info=await statIfPresent(path);return [path,info&&stamp(info)] as const;}
  catch{return [path,'unavailable'] as const;}
 })));
}

export async function executeNativePreparation(plan:NativePreparation,input:NativeSetupServices={}):Promise<RunResult>{
 const {root}=plan,progress:NativeProgress[]=[];
 const end=(exitCode:RunResult['exitCode']):RunResult=>({exitCode,progress});
 if(input.signal?.aborted)return end(130);
 const initial=plan.entries.find(entry=>entry.action)?.action;
 if(!initial)return end(plan.entries.every(entry=>entry.status==='ready')?0:3);
 let currentHost:Agent=initial.host,attempted=false;
 const fail=(fallback:string,exitCode:1|3|130=1)=>{
  progress.push({host:currentHost,status:attempted?'uncertain':'stopped',message:fallback});return end(exitCode);
 };
 const stateRoot=input.stateRoot??initial.runtime.stateRoot??defaultStateRoot();
 try{
  const lock=await acquireLock(root,{stateRoot,recover:true});
  try{
   await assertNoUnknownWriters(root,lock.stateRoot);
   if(await currentReviewPolicy(root))return fail('The project now requires review; native preparation needs a fresh plan.',3);
   if(await interruptedInstallApplyId(root,lock.stateRoot)||await interruptedSeedApplyId(root,lock.stateRoot))
    return fail('Reconcile the interrupted Rigup installation before native preparation.',3);
   let pending=false,claudePath:string|undefined;
   for(const entry of plan.entries){
    currentHost=entry.host;attempted=false;
    if(input.signal?.aborted)return end(130);
    const profile=await scan(root,[currentHost],input),ready=await verifiedExisting(profile,currentHost,input);
    if(ready.status==='ready'){
     const imported=currentHost==='omp'&&claudePath&&bindingFrom(profile,'omp',claudePath,'superpowers');
     progress.push({host:currentHost,status:imported?'recognized':'ready',message:imported?
      'recognized via the Claude project plugin; reopen the host to pick it up. No OMP user plugin was linked.':
      'Native Superpowers sources are already recognized; no setup needed.'});
     continue;
    }
    if(!entry.action){
     pending=true;progress.push({host:currentHost,status:'manual',message:entry.reason??ready.reason});continue;
    }
    const {host}=entry.action,approved=entry.action;
    const result=await withHostWriter<RunResult|undefined>(lock,host,async runner=>{
     const readTarget=async ():Promise<Planned>=>{
      const current=await inspectHostLocations(root,host,input);
      const {root:project,home,stateRoot,writerRoot}=approved.runtime;
      compareDestinations([project,home,stateRoot,writerRoot],[current.root,current.home,current.stateRoot,current.writerRoot]);
      const observed:Planned=approved.host==='claude'
       ?{...approved,recipe:await inspectClaude(current)}
       :{...approved,recipe:await inspectOmp(current)};
      compareDestinations(approved.recipe.paths,observed.recipe.paths);
      return observed;
     };
     let state:Planned;
     try{state=await readTarget();}catch(error){return fail(explain(error,'Native prerequisites changed; review a fresh plan.'),3);}
     if(targetChanged(approved,state))return fail('Native targets changed after approval; review a fresh plan.',3);
     const scratch=await mkdtemp(join(await privateDirectory(lock.stateRoot,root),'native-'));
     const work=join(scratch,'work');
     try{
      await mkdir(work,{mode:0o700});
      if(host==='claude')await prepareClaudeScratch(scratch);
      // Establish the package pin before invoking OMP, including its version probe.
      const bytes=state.host==='omp'&&!state.recipe.stored?await downloadOmp(input.signal,input.fetch):undefined;
      const guard=async()=>{
       if(input.signal?.aborted)return 'Native preparation canceled before dispatch.';
       try{
        if(await currentReviewPolicy(root))return 'The project now requires review; native preparation needs a fresh plan.';
        const observed=await readTarget();
        if(superpowersReadiness(await scan(root,[host],input),host).status!=='missing')return 'Native entry sources changed after approval; review a fresh plan.';
        if(targetChanged(state,observed))return 'Native targets changed after approval; review a fresh plan.';
       }catch(error){return explain(error,'Native prerequisites changed after approval; review a fresh plan.');}
      };
      const run=async(command:HostCommand,cwd:string,timeout:number,capture?:(bytes:Buffer)=>void)=>{
       if(!input.launch)return runner.run(command,cwd,timeout,guard,capture);
       const blocked=await guard();
       if(blocked)return {code:null,blocked,dispatched:false,cancelled:!!input.signal?.aborted};
       const result=await input.launch(command,cwd);
       if(capture&&result.output)capture(Buffer.from(result.output));
       return {code:result.code,blocked:undefined,dispatched:true,cancelled:!!input.signal?.aborted};
      };
      let version='';
      const program=state.runtime.program;
      const probe=await run({executable:program.file,args:[...program.args,'--version'],env:nativeChildEnv(state.runtime,scratch)},work,20_000,
       bytes=>{version=(version+bytes.toString('utf8').slice(0,4097)).slice(0,4097);});
      if(probe.blocked||probe.cancelled)return fail(probe.blocked??'Native version check was interrupted.',input.signal?.aborted?130:probe.dispatched?1:3);
      if(probe.code!==0)return fail('Cannot verify the supported '+host+' CLI version.',1);
      if(!versionMatches(host,version))return fail('The detected '+host+' version is not supported for automatic preparation; use the displayed manual command.',3);
      if(state.host==='omp'&&bytes){
       const unchanged=await guard();
       if(unchanged)return fail(unchanged,input.signal?.aborted?130:3);
       await installOmpStore(state.runtime,bytes);
       progress.push({host,status:'ready',message:'Verified OMP package stored at '+state.recipe.store});
      }
      for(const step of approved.steps){
       const before=await visibleChanges(step.writes);
       const command=state.host==='claude'?claudeCommand(state.runtime,scratch,step.id as ClaudeStep):ompCommand(state.runtime,state.recipe.store,scratch);
       attempted=true;
       const outcome=await run(command,state.host==='claude'?root:work,900_000);
       attempted=false;
       if(!outcome.dispatched)return fail(outcome.blocked??'Native preparation stopped before dispatch.',input.signal?.aborted?130:3);
       let verified=false,after:Planned|undefined,latest:ProjectProfile|undefined;
       try{
        after=await readTarget();
        latest=await scan(root,[host],input);
        if(after.host==='claude'){
         if(step.id==='marketplace')verified=after.recipe.market==='ready'&&after.recipe.declared;
         else if(claudeRecognized(after.recipe,latest)){verified=true;claudePath=after.recipe.installed;}
        }else verified=ompRecognized(after.recipe,latest);
       }catch{/* A malformed partial receipt is not an installed source. */}
       const changed=[...await visibleChanges(step.writes)].filter(([path,value])=>value!==before.get(path)).map(([path])=>path);
       progress.push({host,step:step.id,status:verified?'recognized':'stopped',code:outcome.code,changes:changed,
        message:verified?(step.id==='marketplace'?'Official marketplace and its project declaration verified.':
         'recognized; reopen the host to pick it up.'):('Could not verify '+host+' '+step.id+'; inspect the observed destinations and retry or prepare manually.'),
        ...(verified&&step.undo?{undo:step.undo}:{})});
       if(!verified||outcome.code!==0||outcome.cancelled)
        return end(input.signal?.aborted?130:1);
       if(step.id==='marketplace'&&after)state=after;
      }
      return;
     }finally{if(!attempted)await rm(scratch,{recursive:true,force:true,maxRetries:3});}
    },input.signal,approved.runtime.writerRoot);
    if(result)return result;
   }
   return end(pending?3:0);
  }finally{await lock.release();}
 }catch(error){
  const message=attempted?'Host process termination or its effects could not be established; inspect its destinations before retrying.':
   explain(error,'Native preparation failed before a host command could be dispatched.');
  return fail(message,input.signal?.aborted?130:1);
 }
}

export async function nativeSetupInteraction(root:string,hosts:Agent[],input:NativeSetupServices,ui:{
 write:(message:string)=>void;report?:(value:Record<string,unknown>)=>void;
 ask:import('../../prompt.js').Ask;inspect:boolean;canPrompt:boolean;back?:boolean;
}):Promise<0|1|3|130|'back'>{
 const {sessionReloadNotice}=await import('../../installer/session.js');
 const {nativePreparationCommand}=await import('./manual.js');
 const plan=await planNativePreparation(root,hosts,input),description=describeNativePreparation(plan);
 const ready=plan.entries.every(entry=>entry.status==='ready'),hasAction=plan.entries.some(entry=>entry.action);
 const nextCommand=nativePreparationCommand(root,hosts);
 const write=(message:string)=>ui.write(message+'\n');
 const report=(exitCode:0|1|3|130,progress:NativeProgress[]=[],pending:string[]=[])=>
  ui.report?.({phase:'native-preparation',installStatus:ui.inspect?'not-applicable':exitCode===0?(ready?'up-to-date':'complete'):exitCode===3?'pending':'failed',
   nativePreparation:{...description,progress},pending,...(!ready&&exitCode!==0&&hasAction?{nextCommand}:{})});
 for(const entry of description.hosts){
  write(entry.host+': '+(entry.status==='ready'?'Native Superpowers sources are already recognized; no setup needed.':entry.reason??entry.status));
  if(entry.launcher)write('  Verify CLI '+entry.launcher.requiredVersion+': '+entry.launcher.versionCommand+' (private work directory under '+entry.launcher.temporaryUnder+'; writer guard under '+entry.launcher.writerState+')');
  for(const step of entry.steps){
   write('  '+step.command+' ('+step.pin+')');
   for(const item of step.writes)write('    '+item.level+': '+item.path+
    (item.level==='project'?' (shared project settings)':''));
  }
  if(entry.conditional)write('  '+entry.conditional);
  if(entry.manual)write('  Manual: '+entry.manual);
 }
 if(hasAction)write('Native commands can also write temporary files and host state within the displayed directories. A terminal prompt prevents accidental approval; it does not authenticate who is typing.');
 if(ui.inspect||ready){report(0);return 0;}
 if(input.signal?.aborted){report(130);return 130;}
 if(!hasAction){report(3,[],['Some native workflow prerequisites need manual preparation.']);return 3;}
 if(!ui.canPrompt){
  const message='Native preparation requires approval with terminal input and output.';
  write(message);write(nextCommand);report(3,[],[message]);return 3;
 }
 const answer=await ui.ask({message:'Approve native Superpowers preparation?',choices:['Cancel','Approve'],back:ui.back});
 if(answer==='back'&&ui.back)return 'back';
 if(!Array.isArray(answer)||answer.length!==1||answer[0]!=='Approve'||input.signal?.aborted){report(130);return 130;}
 const reload=await sessionReloadNotice(root);
 if(reload)write(reload);
 const result=await executeNativePreparation(plan,input);
 for(const item of result.progress){
  write(item.host+': '+item.message+(item.code!==undefined?' (exit '+(item.code??'unknown')+')':''));
  for(const path of item.changes??[])write('  Observed change: '+path);
  if(item.undo)write('  Manual removal: '+item.undo);
  if(item.status==='manual'||item.status==='stopped'||item.status==='uncertain')write('  Manual: '+superpowersManual[item.host]);
 }
 if(result.exitCode!==0)write('Review the current state before retrying: '+nextCommand);
 report(result.exitCode,result.progress,result.progress.filter(item=>['stopped','manual','uncertain'].includes(item.status)).map(item=>item.message));
 return result.exitCode;
}
