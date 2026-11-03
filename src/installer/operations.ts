import {saveDurable} from './state.js';
import {join,resolve,isAbsolute,posix} from 'node:path';
import {spawn} from 'node:child_process';
import {mkdir,readFile,lstat,realpath} from 'node:fs/promises';
import type {SetupOperation} from '../types.js';
import {privateDirectory,signature,readCache,saveCache} from '../generator/cache.js';
import {digest} from '../analyzer/evidence.js';
import {targetPath} from './ownership.js';
import {defaultStateRoot,processIdentity,isAlive,type ProcessIdentity} from './lock.js';
import {loadUpstreamLock} from '../integrations/registry.js';
import {prepareSoftwareInstall} from '../integrations/tools/software.js';
export interface OperationResult {status:'done'|'failed'|'pending'|'unknown';message:string;receipt?:{version:string;packageLockDigest:string}}
interface PendingOperation {authorizationRef:string;root:string;operation:SetupOperation;parametersDigest:string;stage:'prepared'|'dispatching'|'terminal';identity?:ProcessIdentity;result?:OperationResult}
export interface OperationDependencies {stateRoot?:string;authorizationRef?:string;save?:(path:string,content:string)=>Promise<void>;signal?:AbortSignal;launch?:(operation:SetupOperation)=>Promise<OperationResult>}
export function operationRoot(operation:SetupOperation):string {const i=operation.parameters.args.indexOf('--prefix');const prefix=operation.parameters.args[i+1];if(i<0||!prefix||!isAbsolute(prefix))throw new Error('operation project root unavailable');return resolve(prefix,'../../..');}
export async function queryOperation(operation:SetupOperation):Promise<OperationResult>{
 try {
  const root=operationRoot(operation);const q=operation.query;
  const pkg=JSON.parse(await readFile(await targetPath(root,q.packageJson),'utf8'));const raw=await readFile(await targetPath(root,q.packageLock));const lock=JSON.parse(raw.toString());
  const resolved=lock.packages?.['node_modules/'+q.name];
  if(pkg.name!==q.name||pkg.version!==q.version||lock.packages?.['']?.dependencies?.[q.name]!==q.version||resolved?.version!==q.version||q.integrity&&resolved?.integrity!==q.integrity)return {status:'unknown',message:'Installed state does not match pinned receipt; manual reconciliation required'};
  const bin=await targetPath(root,operation.protection.target+'/node_modules/'+q.name+'/package.json');const installed=JSON.parse(await readFile(bin,'utf8'));
  if(installed.name!==q.name||installed.version!==q.version)return {status:'unknown',message:'Installed package metadata mismatch'};
  for(const [path,metadata] of Object.entries(lock.packages??{}) as [string,{version?:string;optional?:boolean}][]) {
   if(!path)continue;
   try{const dependency=JSON.parse(await readFile(await targetPath(root,operation.protection.target+'/'+path+'/package.json'),'utf8'));if(dependency.version!==metadata.version)throw new Error('version mismatch');}
   catch(e){if(metadata.optional&&(e as NodeJS.ErrnoException).code==='ENOENT')continue;return {status:'unknown',message:'Installed dependency tree incomplete; manual reconciliation required'};}
  }
  const binaryName=operation.integrationId;const relativeBin=typeof installed.bin==='string'?installed.bin:installed.bin?.[binaryName];
  if(typeof relativeBin!=='string')return {status:'unknown',message:'Expected installed binary missing'};
  if(isAbsolute(relativeBin)||relativeBin.split('/').includes('..'))return {status:'unknown',message:'Installed binary path escapes package'};
  const binary=await targetPath(root,operation.protection.target+'/node_modules/'+q.name+'/'+posix.normalize(relativeBin));
  if(!((await lstat(binary)).mode&0o111))return {status:'unknown',message:'Installed binary is not executable'};
  const launcher=await realpath(join(root,operation.protection.target,'node_modules/.bin',binaryName));
  if(launcher!==await realpath(binary))return {status:'unknown',message:'Native binary launcher does not match installed package'};
  return {status:'done',message:'Pinned installation verified',receipt:{version:q.version,packageLockDigest:digest(raw)}};
 }catch{return {status:'unknown',message:'Cannot prove external operation result; query or manual reconciliation required'};}
}
export async function pendingOperations(root:string,stateRoot=defaultStateRoot()):Promise<PendingOperation[]>{
 const state=await privateDirectory(stateRoot,root);return (await readCache<{operations:PendingOperation[]}>(join(state,signature(root)+'.operations.json')))?.operations??[];
}
async function writerAlive(identity:ProcessIdentity):Promise<boolean>{if(await isAlive(identity))return true;try{process.kill(-identity.pid,0);throw new Error('writer process group exit cannot be confirmed');}catch(e){if((e as NodeJS.ErrnoException).code==='ESRCH')return false;throw e;}}
export async function assertNoUnknownWriters(root:string,stateRoot=defaultStateRoot()):Promise<void>{
 for(const item of await pendingOperations(root,stateRoot)){
  if(item.identity&&await writerAlive(item.identity))throw new Error('previous writing process still active; project blocked');
  if(item.stage!=='prepared'&&item.result?.status!=='done') {
   const result=await queryOperation(item.operation);if(result.status!=='done')throw new Error('unresolved durable operation; manual reconciliation required');
  }
 }
}
const bootstrap=`const {spawn}=require('node:child_process');let started=false;process.stdin.once('data',()=>{started=true;const spec=JSON.parse(process.argv[1]);const child=spawn(spec.executable,spec.args,{cwd:spec.cwd,stdio:'ignore',shell:false,env:process.env});child.once('error',()=>process.exit(1));child.once('exit',(code)=>process.exit(code??1));});process.stdin.once('end',()=>{if(!started)process.exit(1)});`;
export async function executeOperation(operation:SetupOperation,dependencies:OperationDependencies={}):Promise<OperationResult>{
 if(operation.kind!=='install'||!['openwiki','codegraph'].includes(operation.integrationId))return {status:'pending',message:'No verified executable adapter; manual operation required'};
 if(!dependencies.authorizationRef)return {status:'pending',message:'Explicit preview authorization reference required before dispatch'};
 const root=operationRoot(operation);
 const recipes=await loadUpstreamLock();const recipe=recipes.find(r=>r.integrationId===operation.integrationId)!;
 if(operation.version!==recipe.version||operation.query.integrity!==recipe.packageIntegrity)return {status:'pending',message:'Operation version/integrity is not verified'};
 const stateRoot=await privateDirectory(dependencies.stateRoot??defaultStateRoot(),root);const path=join(stateRoot,signature(root)+'.operations.json');
 const state=await readCache<{operations:PendingOperation[]}>(path)??{operations:[]};const key=signature(operation);let record=state.operations.find(r=>r.parametersDigest===key);
 const save=dependencies.save??saveDurable;const persist=()=>save(path,JSON.stringify(state));
 if(record){
  if(record.identity&&await writerAlive(record.identity))return {status:'unknown',message:'Previous writing process has not exited; project remains blocked'};
  if(record.stage!=='prepared') {
   const result=await queryOperation(operation);if(result.status==='done'){record.stage='terminal';record.result=result;await persist();return result;}
   return {status:'unknown',message:'Prior dispatch may have happened; manual reconciliation required before retry'};
  }
 }
 const expected=await prepareSoftwareInstall(root,operation.integrationId as 'openwiki'|'codegraph',recipe.version,recipe.packageIntegrity);
 if('pending' in expected||'reused' in expected||signature(expected)!==key)return {status:'pending',message:'Operation protection or parameters differ from verified recipe'};
 if(!record){record={authorizationRef:dependencies.authorizationRef,root,operation,parametersDigest:key,stage:'prepared'};state.operations.push(record);}
 await persist(); // Durable intent exists BEFORE any child can perform writes.
 if(dependencies.signal?.aborted)return {status:'pending',message:'Cancelled before dispatch'};
 if(dependencies.launch){record.stage='dispatching';await persist();const result=await dependencies.launch(operation);record.stage='terminal';record.result=result;await persist();return result;}
 const child=spawn(process.execPath,['-e',bootstrap,JSON.stringify({...operation.parameters,cwd:root})],{detached:true,stdio:['pipe','ignore','ignore']});
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
 if(record.identity&&await writerAlive(record.identity))throw new Error('writing process exit unconfirmed; persistent record keeps project blocked');
 const verified=await queryOperation(operation);
 const result:OperationResult=cancelled||timedOut?{status:'unknown',message:'Operation cancelled/timed out; reconcile actual state before retry'}:outcome.code===0?verified:{status:'failed',message:'External installation failed; partial effects require reconciliation'};
 record.stage='terminal';record.result=result;await persist();return result;
}
