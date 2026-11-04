import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {lstat,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import type {SetupOperation} from '../../types.js';
import {targetPath} from '../../installer/ownership.js';
import {queryInstalledTool} from './installed-state.js';
import {signature} from '../../generator/cache.js';
import type {OperationResult} from '../../installer/operations.js';
import {initializationRecipe,emptyNativeScope,type NativeTool} from './initialization.js';
const exec=promisify(execFile);
async function verifiedNativeOperation(operation:SetupOperation):Promise<boolean>{
 if(operation.kind!=='initialize'||operation.protection.kind!=='native-staging'||!['openwiki','codegraph'].includes(operation.integrationId))return false;
 const {loadUpstreamLock}=await import('../registry.js');const recipe=(await loadUpstreamLock()).find(r=>r.integrationId===operation.integrationId)!;
 return signature(initializationRecipe(operation.parameters.cwd,operation.integrationId as NativeTool,recipe.version,recipe.packageIntegrity,operation.prerequisiteIds))===signature(operation);
}
export function nativeEnvironment(operation:SetupOperation):NodeJS.ProcessEnv {
 if(operation.protection.kind!=='native-staging')throw Error('Native staging required');
 const path=resolve(operation.parameters.cwd,operation.protection.control);
 const env:NodeJS.ProcessEnv={PATH:process.env.PATH,LANG:'C.UTF-8',HOME:path+'/home',TMPDIR:path+'/tmp',XDG_CONFIG_HOME:path+'/config',XDG_CACHE_HOME:path+'/cache',XDG_DATA_HOME:path+'/data',DO_NOT_TRACK:'1',OPENWIKI_TELEMETRY_DISABLED:'1',CODEGRAPH_TELEMETRY:'0',CODEGRAPH_NO_DAEMON:'1',CODEGRAPH_NO_DOWNLOAD:'1',CODEGRAPH_INSTALL_DIR:path+'/cache',CODEGRAPH_NO_FAST_INIT:'1',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_OPTIONAL_LOCKS:'0'};
 if(process.env.SystemRoot)env.SystemRoot=process.env.SystemRoot;return env;
}
export async function queryNativeInitialization(operation:SetupOperation):Promise<OperationResult>{
 if(!await verifiedNativeOperation(operation))return {status:'unknown',message:'Native query differs from the pinned adapter'};
 const root=operation.parameters.cwd;
 const installed=await queryInstalledTool(root,{prefix:'.rigup/tools/'+operation.integrationId,id:operation.integrationId,...operation.query});
 if(installed.status!=='done')return installed;
 try {
  for(const target of operation.declaredWrites)await targetPath(root,target);
  const args=[...operation.parameters.args];args[3]='query';
  const result=await exec(operation.parameters.executable,args,{cwd:root,env:nativeEnvironment(operation),timeout:30000,maxBuffer:64000});
  const parsed=JSON.parse(result.stdout.trim().split('\n').at(-1)!);
  if(parsed.status!=='done'||!parsed.nativeReceipt)throw Error('Invalid native query response');return parsed;
 }catch{return {status:'unknown',message:'Native initialization is absent, incomplete, or changed; reconcile protected staging before retry'};}
}
export async function safeNativeTree(root:string,target:string):Promise<void>{
 const path=await targetPath(root,target);const stat=await lstat(path).catch(e=>{if(e.code==='ENOENT')return undefined;throw e;});if(!stat)return;
 if(!stat.isDirectory()&&!stat.isFile())throw Error('Unsafe native staging entry');
 if(stat.isDirectory())for(const name of await readdir(path))await safeNativeTree(root,target+'/'+name);
}
export async function resumableNativeOperation(operation:SetupOperation):Promise<boolean>{
 if(!await verifiedNativeOperation(operation)||operation.protection.kind!=='native-staging')return false;
 try {await emptyNativeScope(operation.parameters.cwd,operation.protection.target);for(const scope of operation.declaredWrites)await safeNativeTree(operation.parameters.cwd,scope);return true;}catch{return false;}
}
