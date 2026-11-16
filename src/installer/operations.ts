import {runGlobalNpmInstall,queryGlobalNpmInstall,type GlobalNpmReceipt} from '../integrations/tools/global-npm.js';
import {queryInstalledTool,queryToolPackage,type ToolInstallReceipt} from '../integrations/tools/installed-state.js';
import {isRecord,readDurableRecord,saveDurable} from '../private-record.js';
import {join,resolve,isAbsolute} from 'node:path';
import {readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import type {SetupOperation} from '../types.js';
import {privateDirectory,signature} from '../generator/cache.js';
import {defaultStateRoot,processIdentity,isAlive,type ProcessIdentity} from './lock.js';
import {assertEmptyToolScopes} from '../integrations/tools/initialization.js';
import {assertToolOperationRecipe,isNativeTool,isSoftwareTool,toolOperationIdentity,verifiedToolOperationForResume} from '../integrations/tools/recipes.js';
import {queryNativeInitialization,resumableNativeOperation,nativeEnvironment} from '../integrations/tools/native-state.js';
import {openwikiInitializationGuide} from '../integrations/tools/openwiki.js';
import {startWindowsProcess,windowsJobActive} from '../integrations/tools/windows-process.mjs';
import {assertNpmNode,defaultNpmRegistry,resolveProjectNpm} from '../integrations/tools/npm-resolution.js';
import {assertInstallDestination,clearInstallStage,createInstallStage,installDirectoryIdentity,ownedInstallStage,publishInstallStage,stagedInstall,validInstallStage,type InstallStage} from './install-staging.js';
import {essentialEnvironment,selectedNpmRegistry} from '../runtime-inputs.js';
import {targetPath} from './ownership.js';
import type {PreviewData} from './preview.js';
export interface OperationResult {globalReceipt?:GlobalNpmReceipt;status:'done'|'failed'|'pending'|'unknown';message:string;receipt?:ToolInstallReceipt;nativeReceipt?:import('../types.js').NativeInitializationReceipt}
type WriterIdentity=ProcessIdentity&{windowsJob?:string};
interface PendingOperation {authorizationRef:string;root:string;operation:SetupOperation;parametersDigest:string;stage:'prepared'|'dispatching'|'terminal';identity?:WriterIdentity;result?:OperationResult;installStage?:InstallStage}
export interface OperationDependencies {stateRoot?:string;save?:(path:string,content:string)=>Promise<void>;signal?:AbortSignal;verifyInstallScope?:(target:string)=>Promise<void>;launch?:(operation:SetupOperation)=>Promise<OperationResult>}
export function operationRoot(operation:SetupOperation):string {if(operation.kind==='initialize'&&isAbsolute(operation.parameters.cwd))return operation.parameters.cwd;const i=operation.parameters.args.indexOf('--prefix');const prefix=operation.parameters.args[i+1];if(i<0||!prefix||!isAbsolute(prefix))throw new Error('operation project root unavailable');return resolve(prefix,'../../..');}
export async function queryOperation(operation:SetupOperation,stateRoot?:string):Promise<OperationResult>{
 if(operation.global)return queryGlobalNpmInstall(operation.global,stateRoot);
 try{if(operation.kind==='initialize')return await queryNativeInitialization(operation);return await queryInstalledTool(operationRoot(operation),{prefix:operation.protection.target,id:operation.integrationId,name:operation.query.name,version:operation.query.version,integrity:operation.query.integrity});}catch{return {status:'unknown',message:'Cannot prove external operation result; manual reconciliation required'};}
}
async function queryPublishedInstall(root:string,operation:SetupOperation,stage?:InstallStage):Promise<OperationResult>{
 const result=await queryOperation(operation);
 if(result.status==='done'&&stage&&(!stage.identity||await installDirectoryIdentity(root,operation.protection.target)!==stage.identity))throw Error(operation.id+' installation directory identity changed at '+operation.protection.target);
 return result;
}
async function readOperationRecord(path:string,root:string):Promise<{operations:PendingOperation[]}>{
 const record=await readDurableRecord<{operations:PendingOperation[]}>(path,'Durable operation record',value=>{
  if(!Array.isArray(value.operations))return false;
  const keys=new Set<string>();
  return value.operations.every(item=>{
   if(!isRecord(item)||!isRecord(item.operation)||!['prepared','dispatching','terminal'].includes(item.stage))return false;
   if(item.root!==root||typeof item.authorizationRef!=='string'||!item.authorizationRef)return false;
   if(item.installStage!==undefined&&(item.operation.kind!=='install'||!validInstallStage(item.installStage)))return false;
   if(item.parametersDigest!==signature(item.operation)||keys.has(item.parametersDigest))return false;
   keys.add(item.parametersDigest);
   if(item.identity!==undefined&&(!isRecord(item.identity)||!Number.isSafeInteger(item.identity.pid)||item.identity.pid<1||typeof item.identity.started!=='string'||!item.identity.started||
    (item.identity.windowsJob!==undefined&&typeof item.identity.windowsJob!=='string')))return false;
   if(item.stage==='dispatching'&&!item.identity)return false;
   if(item.stage!=='terminal')return item.result===undefined;
   if(!isRecord(item.result)||!['done','failed','pending','unknown'].includes(item.result.status)||typeof item.result.message!=='string')return false;
   if(item.result.status!=='done')return true;
   const receipt=item.operation.kind==='initialize'?item.result.nativeReceipt:item.result.receipt;
   return isRecord(receipt)&&receipt.version===item.operation.version;
  });
 });
 return record??{operations:[]};
}
export async function pendingOperations(root:string,stateRoot=defaultStateRoot()):Promise<PendingOperation[]>{
 const state=await privateDirectory(stateRoot,root);
 return (await readOperationRecord(join(state,signature(root)+'.operations.json'),root)).operations;
}
export async function writerAlive(identity:WriterIdentity):Promise<boolean>{
 if(await isAlive(identity))return true;
 if(process.platform==='win32'){
  if(!identity.windowsJob)throw Error('Previous Windows writer process tree cannot be verified; reconcile before retrying');
  return windowsJobActive(identity.windowsJob);
 }
 try{process.kill(-identity.pid,0);throw new Error('writer process group exit cannot be confirmed');}catch(e){if((e as NodeJS.ErrnoException).code==='ESRCH')return false;throw e;}}
export async function assertNoUnknownWriters(root:string,stateRoot=defaultStateRoot()):Promise<void>{
 for(const item of await pendingOperations(root,stateRoot)){
  if(item.identity&&await writerAlive(item.identity))throw new Error('previous writing process still active; project blocked');
  if(item.stage==='prepared'&&!item.installStage||item.result?.status==='done')continue;
  const operation=item.operation;
  if(operation.kind==='install'){
   if(operationRoot(operation)!==root)throw Error('Interrupted installation project root changed');
   assertToolOperationRecipe(root,operation,[]);
   if((await queryPublishedInstall(root,operation,item.installStage)).status==='done')continue;
   await assertInstallDestination(root,operation);
   if(item.installStage)await ownedInstallStage(root,stagedInstall(root,operation,item.installStage).protection.target,item.installStage);
  }else if((await queryOperation(operation)).status!=='done'&&!await resumableNativeOperation(operation))throw new Error('Unresolved native operation. Resume from the Rigup installation that prepared it, or reconcile the protected scope before preparing a new preview.');
 }
}
const bootstrap=`const {spawn}=require('node:child_process');let started=false,child;for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{if(!started)process.exit(1);if(child)child.kill(signal);});process.stdin.once('data',()=>{started=true;const spec=JSON.parse(process.argv[1]);child=spawn(spec.executable,spec.args,{cwd:spec.cwd,stdio:'ignore',shell:false,env:spec.env??process.env});child.once('error',()=>process.exit(1));child.once('exit',(code)=>process.exit(code??1));});process.stdin.once('end',()=>{if(!started)process.exit(1)});`;
async function openOperationJournal(root:string,dependencies:OperationDependencies){
 const stateRoot=await privateDirectory(dependencies.stateRoot??defaultStateRoot(),root);
 const path=join(stateRoot,signature(root)+'.operations.json');
 const state=await readOperationRecord(path,root);
 const save=dependencies.save??saveDurable;
 let writes=Promise.resolve();
 return {records:state.operations,persist(){
  const snapshot=JSON.stringify(state);
  // Each child waits for its own durable intent, even when another child is running.
  writes=writes.then(()=>save(path,snapshot));
  return writes;
 }};
}
type OperationJournal=Awaited<ReturnType<typeof openOperationJournal>>;
export function operationExecutor(approved:PreviewData,dependencies:OperationDependencies,restoringApproval=false){
 if(!approved.preview.executable)throw Error('Preview is blocked; prepare a new preview');
 const {root,operations}=approved.plan;
 const authorizationRef=approved.preview.previewId;
 let journal:Promise<OperationJournal>|undefined;
 return async(operationId:string):Promise<OperationResult>=>{
  const matches=operations.filter(operation=>operation.id===operationId);
  if(matches.length!==1)return {status:'pending',message:'Operation ID must identify exactly one approved operation'};
  if(matches[0].global)return runGlobalNpmInstall(matches[0],{...dependencies,authorizationRef,recover:restoringApproval});
  return runOperation(matches[0],{...dependencies,authorizationRef,restoringApproval},actualRoot=>{
   if(actualRoot!==root)throw Error('operation project root differs from approved preview');
   return journal??=openOperationJournal(root,dependencies);
  });
 };
}
export async function installStandaloneOpenSpec(root:string,operation:SetupOperation,authorizationRef:string,dependencies:OperationDependencies,restoringApproval=false){
 if(operation.kind!=='install'||operation.integrationId!=='openspec'||operationRoot(operation)!==root)throw Error('Invalid OpenSpec software operation');
 return runOperation(operation,{...dependencies,authorizationRef,restoringApproval},()=>openOperationJournal(root,dependencies));
}
async function assertInstalledNode(root:string,operation:SetupOperation):Promise<void>{
 const {name,version,packageJson}=operation.query;
 const pkg=await readFile(await targetPath(root,packageJson),'utf8').then(text=>JSON.parse(text)).catch(()=>undefined);
 if(pkg?.name!==name||pkg.version!==version)throw Error('Cannot confirm Node requirements for '+name+'@'+version);
 assertNpmNode(name,version,pkg.engines?.node,process.versions.node);
}
async function runOperation(operation:SetupOperation,dependencies:OperationDependencies&{authorizationRef:string;restoringApproval:boolean},getJournal:(root:string)=>Promise<OperationJournal>):Promise<OperationResult>{
 if(!(operation.kind==='install'&&isSoftwareTool(operation.integrationId)||operation.kind==='initialize'&&isNativeTool(operation.integrationId)))return {status:'pending',message:'No verified executable adapter; manual operation required'};
 const root=operationRoot(operation);
 let dispatched=operation;
 try{
  if(dependencies.restoringApproval)dispatched=verifiedToolOperationForResume(root,operation,operation.prerequisiteIds);
  else assertToolOperationRecipe(root,operation,operation.prerequisiteIds);
 }
 catch(error){return {status:'pending',message:(error as Error).message};}
 const registryPending=async():Promise<OperationResult|undefined>=>{
  if(operation.kind!=='install')return;
  try{if((await selectedNpmRegistry(root)??defaultNpmRegistry)===(operation.registry??defaultNpmRegistry))return;}
  catch{return {status:'pending',message:'Correct the private npm registry input before installing'};}
  return {status:'pending',message:'Npm registry selection changed after review; restore the approved registry before resuming installation'};
 };
 const {records,persist}=await getJournal(root);
 const key=signature(operation);let record=records.find(r=>r.parametersDigest===key);
 if(record){
  if(record.identity&&await writerAlive(record.identity))return {status:'unknown',message:'Previous writing process has not exited; project remains blocked'};
  if(record.stage!=='prepared'||record.installStage) {
   const result=operation.kind==='install'?await queryPublishedInstall(root,operation,record.installStage):await queryOperation(operation);
   if(result.status==='done'){record.stage='terminal';record.result=result;await persist();return result;}
   if(operation.kind!=='install'&&!await resumableNativeOperation(operation))return {status:'unknown',message:'Prior dispatch may have happened; manual reconciliation required before retry'};
  }
 }
 // Previously accepted OpenWiki effects can still be queried above. Starting
 // or repeating its generation belongs to the user's separate native session.
 if(operation.kind==='initialize'&&operation.integrationId==='openwiki')return {status:'pending',message:openwikiInitializationGuide};
 try{
  if(operation.kind==='initialize'){
   const installed=await queryToolPackage(root,operation.integrationId,toolOperationIdentity(operation));
   if(installed.status!=='done')return {status:'pending',message:'Installation must be verified before native initialization'};
   await assertInstalledNode(root,operation);
  }else assertNpmNode(operation.query.name,operation.version,operation.query.enginesNode,process.versions.node);
 }catch(error){return {status:'pending',message:(error as Error).message+'; resume the original approval with a compatible Node'};}
 const staged=record?.installStage?stagedInstall(root,operation,record.installStage):undefined;
 const ownedStage=staged&&record?.installStage&&await ownedInstallStage(root,staged.protection.target,record.installStage);
 const stagedResult=ownedStage&&staged?await queryOperation(staged):undefined;
 if(stagedResult?.status!=='done'){const changed=await registryPending();if(changed)return changed;}
 if(operation.kind==='install'){
  try{await assertInstallDestination(root,operation);}
  catch(error){return {status:'pending',message:(error as Error).message};}
 }else if(!record||record.stage==='prepared'){
  try{await assertEmptyToolScopes(root,operation);}
  catch{return {status:'pending',message:'Tool scope changed before dispatch; preserve content and re-preview'};}
 }
 if(!record){record={authorizationRef:dependencies.authorizationRef,root,operation,parametersDigest:key,stage:'prepared'};records.push(record);}
 else record.authorizationRef=dependencies.authorizationRef;
 await persist(); // Durable intent exists BEFORE any child can perform writes.
 const cancelledBeforeDispatch={status:'pending',message:'Cancelled before dispatch'} as const;
 if(dependencies.signal?.aborted)return cancelledBeforeDispatch;
 const terminal=async(result:OperationResult)=>{
  record.stage='terminal';record.result=result;await persist();return result;
 };
 const acceptInstall=async(staged:SetupOperation,stage:InstallStage,verified:OperationResult):Promise<OperationResult>=>{
  if(verified.status!=='done')return verified;
  await dependencies.verifyInstallScope?.(staged.protection.target);
  await dependencies.verifyInstallScope?.(operation.protection.target);
  try{await assertInstalledNode(root,staged);}
  catch(error){return {status:'pending',message:(error as Error).message+'; resume the original approval with a compatible Node'};}
  await publishInstallStage(root,operation,staged,stage);
  const published=await queryPublishedInstall(root,operation,stage);
  if(published.status!=='done'||published.receipt?.packageLockDigest!==verified.receipt?.packageLockDigest)throw Error('Published installation differs from verified staging');
  return published;
 };
 let stage=record.installStage;
 if(operation.kind==='install'){
  if(stage&&staged&&ownedStage){
   if(stagedResult?.status==='done')return terminal(await acceptInstall(staged,stage,stagedResult));
   const changed=await registryPending();if(changed)return changed;
   await clearInstallStage(root,staged.protection.target,stage);
  }
  stage={token:randomUUID()};
  dispatched=stagedInstall(root,operation,stage);
  await dependencies.verifyInstallScope?.(dispatched.protection.target);
  await dependencies.verifyInstallScope?.(operation.protection.target);
  record.stage='prepared';delete record.identity;delete record.result;record.installStage=stage;
  await persist(); // Reserve a unique scope before touching the project.
  stage.identity=await createInstallStage(root,dispatched.protection.target);
  await persist();
 }
 const previous={stage:record.stage,result:record.result,identity:record.identity};
 const markDispatching=async(identity:WriterIdentity)=>{
  record.identity=identity;record.stage='dispatching';delete record.result;await persist();
 };
 const restoreUndispatched=async()=>{Object.assign(record,previous);await persist();return cancelledBeforeDispatch;};
 if(dependencies.launch){
  // The injected test adapter completes its writes within this process.
  const changed=await registryPending();
  if(dependencies.signal?.aborted)return cancelledBeforeDispatch;
  if(changed)return changed;
  const result=await dependencies.launch(dispatched);
  return terminal(stage&&result.status==='done'?await acceptInstall(dispatched,stage,await queryOperation(dispatched)):result);
 }
 const finish=async(code:number|null,cancelled:boolean):Promise<OperationResult>=>{
  if(cancelled)return terminal({status:'unknown',message:'Operation cancelled or timed out. Resume the approved preview after confirming writer exit.'});
  if(code!==0)return terminal({status:'failed',message:'External operation failed. Review the approved preview before retrying.'});
  const verified=await queryOperation(dispatched);
  return terminal(stage?await acceptInstall(dispatched,stage,verified):verified);
 };
 const command=dispatched.parameters.executable==='npm'?await resolveProjectNpm(root,dispatched.parameters.args):
  {...dispatched.parameters,env:operation.kind==='initialize'?nativeEnvironment(dispatched):essentialEnvironment()};
 return protectedOperationCommand(command,root,operation.timeoutMs,{signal:dependencies.signal,markDispatching,registryPending,restoreUndispatched,finish,identity:()=>record.identity});
}

export async function protectedOperationCommand(command:{executable:string;args:string[];env?:NodeJS.ProcessEnv},root:string,timeoutMs:number,dependencies:{
 signal?:AbortSignal;markDispatching:(identity:WriterIdentity)=>Promise<void>;registryPending:()=>Promise<OperationResult|undefined>;
 restoreUndispatched:()=>Promise<OperationResult>;finish:(code:number|null,cancelled:boolean)=>Promise<OperationResult>;identity:()=>WriterIdentity|undefined;
}):Promise<OperationResult>{
 const {markDispatching,registryPending,restoreUndispatched,finish,identity}=dependencies;
 if(process.platform==='win32'){
  const child=startWindowsProcess({...command,cwd:root,captureOutput:false});
  let timeout:ReturnType<typeof setTimeout>|undefined;
  try{
   if(!child.pid)throw Error('Cannot start protected operation process');
   await markDispatching({...await processIdentity(child.pid),windowsJob:child.job});
   const changed=await registryPending();
   if(dependencies.signal?.aborted){child.stop();await child.completed;return restoreUndispatched();}
   if(changed){child.stop();await child.completed;await restoreUndispatched();return changed;}
   timeout=setTimeout(child.stop,timeoutMs);
   dependencies.signal?.addEventListener('abort',child.stop,{once:true});
   child.start();
   const outcome=await child.completed;
   if((outcome.remaining||outcome.unavailable)&&await windowsJobActive(child.job))throw Error('Writing process exit unconfirmed; persistent record keeps project blocked');
   return finish(outcome.code,outcome.interrupted||outcome.unavailable);
  }finally{
   if(timeout)clearTimeout(timeout);
   dependencies.signal?.removeEventListener('abort',child.stop);
   child.stop();await child.completed;
  }
 }
 const child=spawn(process.execPath,['-e',bootstrap,JSON.stringify({...command,cwd:root})],{detached:true,stdio:['pipe','ignore','ignore']});
 if(!child.pid)throw new Error('Cannot start protected operation process');
 const completed=new Promise<{code:number|null;signal:NodeJS.Signals|null}>(resolve=>{child.once('error',()=>resolve({code:1,signal:null}));child.once('exit',(code,signal)=>resolve({code,signal}));});
 try{await markDispatching(await processIdentity(child.pid));}catch(e){child.stdin.end();await completed;throw e;}
 const changedBeforeDispatch=await registryPending();
 if(dependencies.signal?.aborted){child.stdin.end();await completed;return restoreUndispatched();}
 if(changedBeforeDispatch){child.stdin.end();await completed;await restoreUndispatched();return changedBeforeDispatch;}
 let cancelled=false,timedOut=false;let forceTimer:ReturnType<typeof setTimeout>|undefined;
 const terminate=()=>{cancelled=true;try{process.kill(-child.pid!,'SIGTERM');}catch{};forceTimer??=setTimeout(()=>{try{process.kill(-child.pid!,'SIGKILL');}catch{}},3000);};
 const timeout=setTimeout(()=>{timedOut=true;terminate();},timeoutMs);
 const hardKill=setTimeout(()=>{if(cancelled)try{process.kill(-child.pid!,'SIGKILL');}catch{}},timeoutMs+3000);
 dependencies.signal?.addEventListener('abort',terminate,{once:true});
 child.stdin.write('go\n');child.stdin.end();
 const outcome=await completed;clearTimeout(timeout);clearTimeout(hardKill);if(forceTimer)clearTimeout(forceTimer);dependencies.signal?.removeEventListener('abort',terminate);
 if(identity()){
  // The process-group leader and native worker do not exit at the same instant.
  // Keep the durable intent unresolved until every possible writer is gone.
  const deadline=Date.now()+3000;let alive=true;
  do {try{alive=await writerAlive(identity()!);}catch{alive=true;}if(!alive)break;if(Date.now()<deadline)await new Promise(done=>setTimeout(done,50));}while(Date.now()<deadline);
  if(alive)throw new Error('writing process exit unconfirmed; persistent record keeps project blocked');
 }
 return finish(outcome.code,cancelled||timedOut);
}
