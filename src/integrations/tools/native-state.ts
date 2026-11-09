import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {lstat,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import type {NativeInitializationReceipt,SetupOperation} from '../../types.js';
import {targetPath} from '../../installer/ownership.js';
import {queryPinnedTool} from './installed-state.js';
import {loadUpstreamLock} from '../upstream.js';
import {signature} from '../../generator/cache.js';
import type {OperationResult} from '../../installer/operations.js';
import {assertEmptyNativeScope} from './initialization.js';
import {assertToolOperationRecipe,initializationRecipe,isNativeTool,type NativeTool,type ToolPin} from './recipes.js';
const exec=promisify(execFile);
async function verifiedNativeOperation(operation:SetupOperation):Promise<boolean>{
 if(operation.kind!=='initialize'||operation.protection.kind!=='native-staging')return false;
 const recipe=(await loadUpstreamLock()).find(r=>r.integrationId===operation.integrationId);
 if(!recipe)return false;
 try{assertToolOperationRecipe(operation.parameters.cwd,operation,recipe,operation.prerequisiteIds);return true;}
 catch{return false;}
}
export function nativeEnvironment(operation:SetupOperation):NodeJS.ProcessEnv {
 if(operation.protection.kind!=='native-staging')throw Error('Native staging required');
 const path=resolve(operation.parameters.cwd,operation.protection.control);
 const home=join(path,'home'),temp=join(path,'tmp'),cache=join(path,'cache');
 const env:NodeJS.ProcessEnv={PATH:process.env.PATH,LANG:'C.UTF-8',HOME:home,TMPDIR:temp,XDG_CONFIG_HOME:join(path,'config'),XDG_CACHE_HOME:cache,XDG_DATA_HOME:join(path,'data'),DO_NOT_TRACK:'1',OPENWIKI_TELEMETRY_DISABLED:'1',CODEGRAPH_TELEMETRY:'0',CODEGRAPH_NO_DAEMON:'1',CODEGRAPH_NO_DOWNLOAD:'1',CODEGRAPH_INSTALL_DIR:cache,CODEGRAPH_NO_FAST_INIT:'1',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_OPTIONAL_LOCKS:'0'};
 if(process.platform==='win32')Object.assign(env,{USERPROFILE:home,TEMP:temp,TMP:temp});
 if(process.env.SystemRoot)env.SystemRoot=process.env.SystemRoot;return env;
}
export async function queryNativeInitialization(operation:SetupOperation):Promise<OperationResult>{
 if(!isNativeTool(operation.integrationId)||!await verifiedNativeOperation(operation))return {status:'unknown',message:'Native query differs from the pinned adapter'};
 const root=operation.parameters.cwd;
 const installed=await queryPinnedTool(root,operation.integrationId,{version:operation.version,packageIntegrity:operation.query.integrity});
 if(installed.status!=='done')return installed;
 try {
  for(const target of operation.declaredWrites)await targetPath(root,target);
  const args=[...operation.parameters.args];args[3]='query';
  const result=await exec(operation.parameters.executable,args,{cwd:root,env:nativeEnvironment(operation),timeout:30000,maxBuffer:64000});
  const parsed=JSON.parse(result.stdout.trim().split('\n').at(-1)!);
  if(parsed.status!=='done'||!parsed.nativeReceipt)throw Error('Invalid native query response');return parsed;
 }catch{return {status:'unknown',message:'Native initialization is absent, incomplete, or changed; reconcile protected staging before retry'};}
}
export async function verifyToolInitializationReceipt(root:string,id:NativeTool,pin:ToolPin,receipt?:NativeInitializationReceipt):Promise<OperationResult|undefined> {
 if(!receipt||receipt.version!==pin.version)return;
 const state=await queryNativeInitialization(initializationRecipe(root,id,pin.version,pin.packageIntegrity));
 if(state.status==='done'&&signature(state.nativeReceipt)===signature(receipt))return state;
}

export async function safeNativeTree(root:string,target:string):Promise<void>{
 const path=await targetPath(root,target);const stat=await lstat(path).catch(e=>{if(e.code==='ENOENT')return undefined;throw e;});if(!stat)return;
 if(!stat.isDirectory()&&!stat.isFile())throw Error('Unsafe native staging entry');
 if(stat.isDirectory())for(const name of await readdir(path))await safeNativeTree(root,target+'/'+name);
}
export async function resumableNativeOperation(operation:SetupOperation):Promise<boolean>{
 if(!await verifiedNativeOperation(operation)||operation.protection.kind!=='native-staging')return false;
 try {await assertEmptyNativeScope(operation.parameters.cwd,operation.protection.target);for(const scope of operation.declaredWrites)await safeNativeTree(operation.parameters.cwd,scope);return true;}catch{return false;}
}
