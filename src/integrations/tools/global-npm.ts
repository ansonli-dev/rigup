import {createHash,randomUUID} from 'node:crypto';
import {readFile,lstat,realpath,unlink} from 'node:fs/promises';
import {constants,createReadStream} from 'node:fs';
import {normalizeNpmIntegrity} from '../../npm-integrity.mjs';
import {readManagedGlobalInstall,resolveExternalTool,verifyCodeGraphPayload} from '../../npm-command.mjs';
import {join} from 'node:path';
import {signature,privateDirectory} from '../../generator/cache.js';
import {isRecord,readDurableRecord,saveDurable} from '../../private-record.js';
import {acquireLock,defaultStateRoot} from '../../installer/lock.js';
import {targetPath} from '../../installer/ownership.js';
import {selectedNpmRegistry} from '../../runtime-inputs.js';
import {quoteShell} from '../../shell-command.js';
import {assertNpmNode,isStableNpmVersion,effectiveNpmRegistry,normalizeNpmRegistry,npmEnvironment,npmRegistryFlags,resolveNpmLatest,type NpmView,type ResolvedNpmPackage} from './npm-resolution.js';
import {available,consumerPath,exists,findProgram,globalPackage,globalNpmOutput,npmPrefix,userNode,programIdentity,prefixIdentity,packageDirectory,windowsNpmCommand,type GlobalTool} from './global-npm-runtime.js';
import type {SetupOperation} from '../../types.js';
import {protectedOperationCommand,writerAlive,type OperationResult} from '../../installer/operations.js';
import {clearInstallStage,createInstallStage,ownedInstallStage,validInstallStage,type InstallStage} from '../../installer/install-staging.js';
export interface GlobalNpmApproval {root:string;id:GlobalTool;name:string;bin:string;prefix:string;prefixIdentity?:string;npmIdentity?:string;install:ResolvedNpmPackage}
export interface GlobalNpmReceipt {version:string;packageIntegrity:string;registry:string;prefix:string;launcher?:string;launcherIdentity?:string;approval:string}
export async function inspectGlobalNpm(root:string,id:GlobalTool,signal?:AbortSignal){
 root=await realpath(root);const path=await consumerPath(root),pkg=globalPackage(id);
 const npm=await findProgram('npm',root,path),node=await userNode(root,path,signal);
 const prefix=npm&&await npmPrefix(npm,root,path,signal,pkg.name);
 if(!npm||!node||!prefix)throw Error('Global installation requires npm, Node and a writable user prefix on PATH');
 return {root,path,npm,node,prefix};
}
export async function planGlobalNpmInstall(root:string,id:GlobalTool,input:{stateRoot?:string;signal?:AbortSignal;view?:NpmView}={}):Promise<GlobalNpmApproval>{
 const setup=await inspectGlobalNpm(root,id,input.signal),pkg=globalPackage(id);
 const approval={root:setup.root,id,...pkg,prefix:setup.prefix,
 install:await resolveNpmLatest(pkg.name,{...input,root:setup.root,stateRoot:input.stateRoot??defaultStateRoot(),registry:await selectedNpmRegistry(root),nodeVersion:setup.node.version,npm:globalNpmOutput(setup.npm,setup.path)})};
 await assertGlobalDestination(approval);return approval;
}
export function globalNpmInstallOperation(approval:GlobalNpmApproval):SetupOperation{
 return {id:'install-global:'+approval.id,integrationId:approval.id,kind:'install',global:approval,registry:approval.install.registry,
 parameters:{executable:'npm',args:['install','--global','--prefix',approval.prefix,approval.name+'@'+approval.install.version],cwd:approval.root,envRefs:[]},
 prerequisiteIds:[],declaredWrites:[],version:approval.install.version,timeoutMs:300000,protection:{kind:'global-npm',target:approval.prefix},
 query:{kind:'npm-package',packageJson:packageDirectory(approval.name)+'/package.json',packageLock:'',name:approval.name,version:approval.install.version,integrity:approval.install.packageIntegrity,enginesNode:approval.install.enginesNode}};
}
export function assertGlobalOperation(root:string,operation:SetupOperation){
 const approval=operation.global;
 if(!approval||!['openwiki','codegraph','openspec'].includes(approval.id)||globalPackage(approval.id).name!==approval.name||globalPackage(approval.id).bin!==approval.bin||
  !isStableNpmVersion(approval.install.version)||!normalizeNpmIntegrity(approval.install.packageIntegrity)||normalizeNpmIntegrity(approval.install.packageIntegrity)!==approval.install.packageIntegrity||
  !approval.install.registry||normalizeNpmRegistry(approval.install.registry)!==approval.install.registry)throw Error('Global package differs from its approved integration recipe');
 if(!operation.global||operation.global.root!==root||signature(globalNpmInstallOperation(operation.global))!==signature(operation))throw Error('Global operation differs from its approved recipe');
}
export async function assertGlobalDestination(approval:GlobalNpmApproval){
 await assertGlobalPrefix(approval);
 const targets=[packageDirectory(approval.name),...(process.platform==='win32'?[approval.bin,approval.bin+'.cmd',approval.bin+'.ps1',approval.bin+'.exe']:['bin/'+approval.bin])];
 for(const target of targets){const path=await targetPath(approval.prefix,target);if(await lstat(path).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;}))throw Error('Global installation target already exists; resume the original approval or reconcile '+path);}
}
async function assertGlobalPrefix(approval:GlobalNpmApproval){
 if(approval.prefixIdentity){
  if(await prefixIdentity(approval.prefix)!==approval.prefixIdentity)throw Error('Global npm prefix changed after approval');
 }else if(await realpath(approval.prefix)!==approval.prefix||!(await lstat(approval.prefix)).isDirectory()){
  throw Error('Global npm prefix changed after approval');
 }
}
async function globalLauncher(approval:GlobalNpmApproval){
 const {root,prefix,name,bin}=approval;
 await assertGlobalPrefix(approval);
 const packageRoot=await targetPath(prefix,packageDirectory(name));
 const metadata=JSON.parse(await readFile(await targetPath(packageRoot,'package.json'),'utf8'));
 if(metadata.name!==name||metadata.version!==approval.install.version)throw Error('Installed global package differs from approval');
 if(approval.id==='codegraph')await verifyCodeGraphPayload(packageRoot,metadata);
 const entry=typeof metadata.bin==='string'?metadata.bin:metadata.bin?.[bin];
 if(typeof entry!=='string'||!entry)throw Error('Installed global entry missing');
 const canonical=await realpath(await targetPath(packageRoot,entry.replace(/^\.\//,'')));
 const launcher=join(prefix,process.platform==='win32'?bin+'.cmd':'bin/'+bin),path=await consumerPath(root);
 if(!await available(launcher,constants.X_OK)||!(await lstat(canonical)).isFile())throw Error('Global launcher unavailable');
 const program=process.platform==='win32'?await windowsNpmCommand(bin,prefix,root,path):{file:launcher};
 if((process.platform==='win32'?program.args?.[0]:await realpath(launcher))!==canonical)throw Error('Global launcher differs from approved package');
 return {launcher,path,program};
}
function receiptPath(stateRoot:string,approval:GlobalNpmApproval){return join(stateRoot,'global-npm-'+signature({prefix:approval.prefix,name:approval.name})+'.json');}
export async function queryGlobalNpmInstall(approval:GlobalNpmApproval,stateRoot=defaultStateRoot()):Promise<OperationResult>{
 try{
  const receipt=await readDurableRecord<GlobalNpmReceipt>(receiptPath(stateRoot,approval),'Global npm receipt');
  const unknown={status:'unknown' as const,message:'Global installation requires its original approval and verified receipt'};
  if(!receipt||receipt.approval!==signature(approval)||receipt.version!==approval.install.version||receipt.packageIntegrity!==approval.install.packageIntegrity||receipt.registry!==approval.install.registry||receipt.prefix!==approval.prefix)return unknown;
  const {launcher,program,path}=await globalLauncher(approval);
  if(receipt.launcher!==launcher&&(!receipt.launcherIdentity||receipt.launcherIdentity!==await programIdentity(program,approval.root,path)))return unknown;
  return {status:'done',message:approval.name+'@'+receipt.version+' installed globally at '+approval.prefix,globalReceipt:receipt};
 }catch{return {status:'unknown',message:'Global installation cannot be verified; preserve files and resume original approval'};}
}
interface GlobalRecord {
 approval:GlobalNpmApproval;authorizationRef:string;stage:'prepared'|'dispatching'|'terminal';
 identity?:Parameters<typeof writerAlive>[0];result?:OperationResult;scratch?:InstallStage;installing?:true;
}
const globalRecordsPath=(stateRoot:string,prefix:string)=>join(stateRoot,'global-npm-'+signature({prefix})+'.operations.json');
function readGlobalRecords(path:string,prefix:string){
 return readDurableRecord<{records:GlobalRecord[]}>(path,'Global npm operations',value=>{
  if(!Array.isArray(value.records))return false;
  return value.records.every(record=>{
   if(!isRecord(record)||!isRecord(record.approval)||!isRecord(record.approval.install)||!['prepared','dispatching','terminal'].includes(record.stage))return false;
   const approval=record.approval;
   if(!['openwiki','codegraph','openspec'].includes(approval.id)||approval.prefix!==prefix||typeof approval.root!=='string'||
    globalPackage(approval.id).name!==approval.name||globalPackage(approval.id).bin!==approval.bin||
    (approval.prefixIdentity!==undefined&&typeof approval.prefixIdentity!=='string')||(approval.npmIdentity!==undefined&&typeof approval.npmIdentity!=='string')||
    typeof approval.install.version!=='string'||typeof approval.install.packageIntegrity!=='string'||typeof approval.install.registry!=='string'||typeof record.authorizationRef!=='string')return false;
   if(record.scratch!==undefined&&!validInstallStage(record.scratch))return false;
   if(record.installing!==undefined&&(record.installing!==true||!record.scratch?.identity))return false;
   if(record.stage==='dispatching'&&!record.identity)return false;
   if(record.identity!==undefined&&(!isRecord(record.identity)||!Number.isSafeInteger(record.identity.pid)||record.identity.pid<1))return false;
   if(record.stage==='terminal'&&(!isRecord(record.result)||!['done','failed','pending','unknown'].includes(record.result.status)))return false;
   return record.result?.status!=='done'||isRecord(record.result.globalReceipt)&&record.result.globalReceipt.approval===signature(approval);
  });
 });
}
export async function managedGlobalNpmProblem(id:GlobalTool,launcher:string,stateRoot=defaultStateRoot()){
 try{
  const state=await readManagedGlobalInstall(id,launcher,stateRoot);
  if(!state||state.published&&(await queryGlobalNpmInstall(state.approval,stateRoot)).status==='done')return;
  return id+' global installation is unverified at '+quoteShell(state.prefix)+'. Resume the original approval in '+quoteShell(state.approval.root)+' or reconcile the prefix.';
 }catch{return 'Cannot safely read the global npm operation record for '+id+'. Reconcile the prefix before using it.';}
}
export async function detectExternalTool(root:string,id:Exclude<GlobalTool,'openspec'>,path:string,stateRoot?:string){
 const tool=await resolveExternalTool(root,id,path);
 if(tool.state!=='available')return tool;
 const reason=await managedGlobalNpmProblem(id,tool.program.launcher,stateRoot);
 return reason?{state:'repair' as const,reason}:tool;
}

async function matchesArchive(archive:string,integrity:string,signal?:AbortSignal){
 if(!await exists(archive))return false;
 if(!(await lstat(archive)).isFile())throw Error('Global npm archive is not a regular file');
 const digests=integrity.split(' '),algorithm=digests[0].split('-')[0],hash=createHash(algorithm);
 for await(const chunk of createReadStream(archive,{signal}))hash.update(chunk);
 return digests.includes(algorithm+'-'+hash.digest('base64'));
}

export async function runGlobalNpmInstall(operation:SetupOperation,input:{stateRoot?:string;signal?:AbortSignal;authorizationRef:string;recover?:boolean;beforeInstall?:()=>Promise<void>}):Promise<OperationResult>{
 const approval=operation.global!;assertGlobalOperation(approval.root,operation);
 const stateRoot=await privateDirectory(input.stateRoot??defaultStateRoot(),approval.root);
 const path=globalRecordsPath(stateRoot,approval.prefix);
 // All packages and projects share the historical OpenSpec lock identity.
 const lock=await acquireLock(approval.root,{stateRoot,resource:'openspec:'+approval.prefix,recover:input.recover});
 try{
  const state=await readGlobalRecords(path,approval.prefix)??{records:[]};
  const persist=()=>saveDurable(path,JSON.stringify(state));
  const id=signature(approval),stageName=(stage:InstallStage)=>'global-npm-'+stage.token;
  let record=state.records.find(item=>signature(item.approval)===id);
  for(const prior of state.records){
   if(prior.identity&&await writerAlive(prior.identity))throw Error('Previous global writing process still active; prefix blocked');
   if(prior===record||prior.stage==='prepared'||prior.result?.status==='done')continue;
   const result=await queryGlobalNpmInstall(prior.approval,stateRoot);
   if(result.status!=='done')await assertGlobalDestination(prior.approval);
  }
  const terminal=async(result:OperationResult)=>{
   if(!record)throw Error('Global receipt has no original operation record. Reconcile the prefix.');
   if(record.stage!=='terminal'||signature(record.result)!==signature(result)){
    record.stage='terminal';record.result=result;
    await persist();
   }
   if(result.status==='done'&&record.scratch)await clearInstallStage(stateRoot,stageName(record.scratch),record.scratch);
   return result;
  };
  const complete=await queryGlobalNpmInstall(approval,stateRoot);
  if(complete.status==='done')return await terminal(complete);
  const accept=async()=>{
   const {launcher,program,path}=await globalLauncher(approval);
   const selected=approval.npmIdentity||approval.prefixIdentity
    ?{launcherIdentity:await programIdentity(program,approval.root,path)}:{launcher};
   const receipt:GlobalNpmReceipt={version:approval.install.version,packageIntegrity:approval.install.packageIntegrity,
    registry:approval.install.registry!,prefix:approval.prefix,...selected,approval:id};
   await saveDurable(receiptPath(stateRoot,approval),JSON.stringify(receipt));
   return terminal(await queryGlobalNpmInstall(approval,stateRoot));
  };
  if(record?.scratch&&record.authorizationRef!==input.authorizationRef)throw Error('Resume the original global npm approval in '+approval.root);
  let stage=record?.scratch&&await ownedInstallStage(stateRoot,stageName(record.scratch),record.scratch);
  const successPath=()=>targetPath(stage!,'installed.json');
  if(stage&&record?.installing){
   const result=await readDurableRecord<{code:number}>(await successPath(),'Global npm exit receipt',value=>value.code===0);
   if(result)return await accept();
  }
  await assertGlobalDestination(approval);
  const validate=async()=>{
   const setup=await inspectGlobalNpm(approval.root,approval.id,input.signal);
   if(setup.prefix!==approval.prefix||approval.npmIdentity&&await programIdentity(setup.npm,approval.root,setup.path)!==approval.npmIdentity)throw Error('Global installation scope or npm launcher changed after approval');
   await assertGlobalDestination(approval);
   const registry=await effectiveNpmRegistry(approval.root,approval.name,await selectedNpmRegistry(approval.root),input.signal,globalNpmOutput(setup.npm,setup.path));
   if(registry!==approval.install.registry)throw Error('Npm registry selection changed after approval');
   if(await findProgram(approval.bin,approval.root,setup.path))throw Error('A PATH installation appeared after approval; review the existing '+approval.id+' launcher before installing');
   assertNpmNode(approval.name,approval.install.version,approval.install.enginesNode,setup.node.version);return setup;
  };
  await validate();
  if(!record){record={approval,authorizationRef:input.authorizationRef,stage:'prepared'};state.records.push(record);}
  if(input.signal?.aborted)return {status:'pending',message:'Cancelled before global dispatch'};
  if(!stage){
   const scratch:InstallStage={token:randomUUID()};
   record.scratch=scratch;record.stage='prepared';delete record.identity;delete record.installing;delete record.result;
   await persist();
   scratch.identity=await createInstallStage(stateRoot,stageName(scratch));
   await persist();
   stage=await targetPath(stateRoot,stageName(scratch));
  }
  const archive=await targetPath(stage,approval.name.replace(/^@/,'').replace(/\//g,'-')+'-'+approval.install.version+'.tgz');
  const matches=()=>matchesArchive(archive,approval.install.packageIntegrity,input.signal);
  const integrityError=()=>Error((approval.id==='openspec'?'OpenSpec':'Global')+' package integrity mismatch');
  const flags=[...npmRegistryFlags(approval.name,approval.install.registry!),'--ignore-scripts','--no-audit','--no-fund'];
  const dispatch=async(args:string[],installing:boolean,finish:(code:number|null,cancelled:boolean)=>Promise<OperationResult>)=>{
   const current=await validate();
   const command={executable:current.npm.file,args:[...current.npm.args??[],...args],env:npmEnvironment(current.path),
    ...(installing?{successRecord:await successPath()}:{})};
   return protectedOperationCommand(command,approval.root,operation.timeoutMs,{signal:input.signal,
    markDispatching:async identity=>{
     record!.identity=identity;record!.stage='dispatching';delete record!.result;
     if(installing)record!.installing=true;else delete record!.installing;
     await persist();
    },
    registryPending:async()=>{
     try{await validate();if(installing&&!await matches())throw integrityError();}
     catch(error){return {status:'pending',message:(error as Error).message};}
    },
    restoreUndispatched:async()=>{
     record!.stage='prepared';delete record!.identity;delete record!.installing;
     await persist();return {status:'pending',message:'Cancelled before global dispatch'};
    },finish});
  };
  const failed=(cancelled:boolean):OperationResult=>({status:cancelled?'unknown':'failed',message:'Global installation did not complete; resume the original approved preview'});
  if(!await matches()){
   if(await exists(archive))await unlink(archive);
   const packed=await dispatch(['pack','--pack-destination',stage,...flags,approval.name+'@'+approval.install.version],false,
    async(code,cancelled)=>code===0&&!cancelled?{status:'done',message:'Download complete'}:terminal(failed(cancelled)));
   if(packed.status!=='done')return packed;
   if(!await matches())throw integrityError();
  }
  await input.beforeInstall?.();
  return await dispatch(['install','--global','--prefix',approval.prefix,...flags,archive],true,
   async(code,cancelled)=>code===0&&!cancelled?accept():terminal(failed(cancelled)));
 }finally{await lock.release();}
}
