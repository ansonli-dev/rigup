import {queryInstalledTool} from '../integrations/tools/installed-state.js';
import {saveDurable} from './state.js';
import {join,resolve,isAbsolute} from 'node:path';
import {spawn} from 'node:child_process';
import type {SetupOperation} from '../types.js';
import {privateDirectory,signature,readCache} from '../generator/cache.js';
import {defaultStateRoot,processIdentity,isAlive,type ProcessIdentity} from './lock.js';
import {loadUpstreamLock} from '../integrations/registry.js';
import {prepareSoftwareInstall} from '../integrations/tools/software.js';
import {initializationRecipe,emptyNativeScope,type NativeTool} from '../integrations/tools/initialization.js';
import {queryNativeInitialization,resumableNativeOperation,nativeEnvironment} from '../integrations/tools/native-state.js';
import {openwikiInitializationGuide} from '../integrations/tools/openwiki.js';
export interface OperationResult {status:'done'|'failed'|'pending'|'unknown';message:string;receipt?:{version:string;packageLockDigest:string};nativeReceipt?:import('../types.js').NativeInitializationReceipt}
interface PendingOperation {authorizationRef:string;root:string;operation:SetupOperation;parametersDigest:string;stage:'prepared'|'dispatching'|'terminal';identity?:ProcessIdentity;result?:OperationResult}
export interface OperationDependencies {stateRoot?:string;authorizationRef?:string;save?:(path:string,content:string)=>Promise<void>;signal?:AbortSignal;launch?:(operation:SetupOperation)=>Promise<OperationResult>}
export function operationRoot(operation:SetupOperation):string {if(operation.kind==='initialize'&&isAbsolute(operation.parameters.cwd))return operation.parameters.cwd;const i=operation.parameters.args.indexOf('--prefix');const prefix=operation.parameters.args[i+1];if(i<0||!prefix||!isAbsolute(prefix))throw new Error('operation project root unavailable');return resolve(prefix,'../../..');}
export async function queryOperation(operation:SetupOperation):Promise<OperationResult>{
 try{if(operation.kind==='initialize')return await queryNativeInitialization(operation);return await queryInstalledTool(operationRoot(operation),{prefix:operation.protection.target,id:operation.integrationId,name:operation.query.name,version:operation.query.version,integrity:operation.query.integrity});}catch{return {status:'unknown',message:'Cannot prove external operation result; manual reconciliation required'};}
}
export async function pendingOperations(root:string,stateRoot=defaultStateRoot()):Promise<PendingOperation[]>{
 const state=await privateDirectory(stateRoot,root);return (await readCache<{operations:PendingOperation[]}>(join(state,signature(root)+'.operations.json')))?.operations??[];
}
async function writerAlive(identity:ProcessIdentity):Promise<boolean>{if(await isAlive(identity))return true;try{process.kill(-identity.pid,0);throw new Error('writer process group exit cannot be confirmed');}catch(e){if((e as NodeJS.ErrnoException).code==='ESRCH')return false;throw e;}}
export async function assertNoUnknownWriters(root:string,stateRoot=defaultStateRoot()):Promise<void>{
 for(const item of await pendingOperations(root,stateRoot)){
  if(item.identity&&await writerAlive(item.identity))throw new Error('previous writing process still active; project blocked');
  if(item.stage!=='prepared'&&item.result?.status!=='done') {
   const result=await queryOperation(item.operation);if(result.status!=='done'&&!await resumableNativeOperation(item.operation))throw new Error('unresolved durable operation; manual reconciliation required');
  }
 }
}
const bootstrap=`const {spawn}=require('node:child_process');let started=false,child;for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{if(!started)process.exit(1);if(child)child.kill(signal);});process.stdin.once('data',()=>{started=true;const spec=JSON.parse(process.argv[1]);child=spawn(spec.executable,spec.args,{cwd:spec.cwd,stdio:'ignore',shell:false,env:spec.env??process.env});child.once('error',()=>process.exit(1));child.once('exit',(code)=>process.exit(code??1));});process.stdin.once('end',()=>{if(!started)process.exit(1)});`;
export async function executeOperation(operation:SetupOperation,dependencies:OperationDependencies={}):Promise<OperationResult>{
 if(!['install','initialize'].includes(operation.kind)||!['openwiki','codegraph'].includes(operation.integrationId))return {status:'pending',message:'No verified executable adapter; manual operation required'};
 if(!dependencies.authorizationRef)return {status:'pending',message:'Explicit preview authorization reference required before dispatch'};
 const root=operationRoot(operation);
 const recipes=await loadUpstreamLock();const recipe=recipes.find(r=>r.integrationId===operation.integrationId)!;
 if(operation.version!==recipe.version||operation.query.integrity!==recipe.packageIntegrity)return {status:'pending',message:'Operation version/integrity is not verified'};
 if(operation.kind==='initialize'&&signature(initializationRecipe(root,operation.integrationId as NativeTool,recipe.version,recipe.packageIntegrity,operation.prerequisiteIds))!==signature(operation))return {status:'pending',message:'Initialization parameters differ from verified recipe'};
 const stateRoot=await privateDirectory(dependencies.stateRoot??defaultStateRoot(),root);const path=join(stateRoot,signature(root)+'.operations.json');
 const state=await readCache<{operations:PendingOperation[]}>(path)??{operations:[]};const key=signature(operation);let record=state.operations.find(r=>r.parametersDigest===key);
 const save=dependencies.save??saveDurable;const persist=()=>save(path,JSON.stringify(state));
 if(record){
  if(record.identity&&await writerAlive(record.identity))return {status:'unknown',message:'Previous writing process has not exited; project remains blocked'};
  if(record.stage!=='prepared') {
   const result=await queryOperation(operation);if(result.status==='done'){record.stage='terminal';record.result=result;await persist();return result;}
   if(!await resumableNativeOperation(operation))return {status:'unknown',message:'Prior dispatch may have happened; manual reconciliation required before retry'};
  }
 }
 // Previously accepted OpenWiki effects can still be queried above. Starting
 // or repeating its generation belongs to the user's separate native session.
 if(operation.kind==='initialize'&&operation.integrationId==='openwiki')return {status:'pending',message:openwikiInitializationGuide};
 if(operation.kind==='install'){
  const expected=await prepareSoftwareInstall(root,operation.integrationId as NativeTool,recipe.version,recipe.packageIntegrity);
  if('pending' in expected||'reused' in expected||signature(expected)!==key)return {status:'pending',message:'Operation protection or parameters differ from verified recipe'};
 }else{
  const installed=await queryInstalledTool(root,{prefix:'.rigup/tools/'+operation.integrationId,id:operation.integrationId,...operation.query});
  if(installed.status!=='done')return {status:'pending',message:'Pinned installation must be verified before native initialization'};
  if(!record||record.stage==='prepared')try{for(const scope of operation.declaredWrites)await emptyNativeScope(root,scope);}catch{return {status:'pending',message:'Native scope changed before dispatch; preserve content and re-preview'};}
 }
 if(!record){record={authorizationRef:dependencies.authorizationRef,root,operation,parametersDigest:key,stage:'prepared'};state.operations.push(record);}
 await persist(); // Durable intent exists BEFORE any child can perform writes.
 if(dependencies.signal?.aborted)return {status:'pending',message:'Cancelled before dispatch'};
 if(dependencies.launch){record.stage='dispatching';await persist();const result=await dependencies.launch(operation);record.stage='terminal';record.result=result;await persist();return result;}
 const child=spawn(process.execPath,['-e',bootstrap,JSON.stringify({...operation.parameters,cwd:root,...(operation.kind==='initialize'?{env:nativeEnvironment(operation)}:{})})],{detached:true,stdio:['pipe','ignore','ignore']});
 if(!child.pid)throw new Error('Cannot start protected operation process');
 const completed=new Promise<{code:number|null;signal:NodeJS.Signals|null}>(resolve=>{child.once('error',()=>resolve({code:1,signal:null}));child.once('exit',(code,signal)=>resolve({code,signal}));});
 try{record.identity=await processIdentity(child.pid);record.stage='dispatching';await persist();}catch(e){child.stdin.end();await completed;throw e;}
 child.stdin.write('go\n');child.stdin.end();
 let cancelled=false,timedOut=false;let forceTimer:ReturnType<typeof setTimeout>|undefined;
 const terminate=()=>{cancelled=true;try{process.kill(-child.pid!,'SIGTERM');}catch{};forceTimer??=setTimeout(()=>{try{process.kill(-child.pid!,'SIGKILL');}catch{}},3000);};
 const timeout=setTimeout(()=>{timedOut=true;terminate();},operation.timeoutMs);
 const hardKill=setTimeout(()=>{if(cancelled)try{process.kill(-child.pid!,'SIGKILL');}catch{}},operation.timeoutMs+3000);
 dependencies.signal?.addEventListener('abort',terminate,{once:true});
 const outcome=await completed;clearTimeout(timeout);clearTimeout(hardKill);if(forceTimer)clearTimeout(forceTimer);dependencies.signal?.removeEventListener('abort',terminate);
 if(record.identity){
  // The process-group leader and native worker do not exit at the same instant.
  // Keep the durable intent unresolved until every possible writer is gone.
  const deadline=Date.now()+3000;let alive=true;
  do {try{alive=await writerAlive(record.identity);}catch{alive=true;}if(!alive)break;if(Date.now()<deadline)await new Promise(done=>setTimeout(done,50));}while(Date.now()<deadline);
  if(alive)throw new Error('writing process exit unconfirmed; persistent record keeps project blocked');
 }
 const verified=await queryOperation(operation);
 const result:OperationResult=cancelled||timedOut?{status:'unknown',message:'Operation cancelled/timed out; reconcile actual state before retry'}:outcome.code===0?verified:{status:'failed',message:'External installation failed; partial effects require reconciliation'};
 record.stage='terminal';record.result=result;await persist();return result;
}
