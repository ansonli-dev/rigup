import {lstat,readdir,realpath} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {targetPath} from '../../installer/ownership.js';
import type {SetupOperation,NativeInitializationReceipt} from '../../types.js';
import {queryNativeInitialization} from './native-state.js';
import {signature} from '../../generator/cache.js';

export type NativeTool='openwiki'|'codegraph';
export function initializationRecipe(root:string,id:NativeTool,version:string,integrity?:string,prerequisiteIds:string[]=[]):SetupOperation {
 const target=id==='openwiki'?'openwiki':'.codegraph';
 const control='.rigup/native/'+id;
 const staging=id==='openwiki'?control+'/repository':'.codegraph-rigup-init';
 const prefix='.rigup/tools/'+id;const name=id==='openwiki'?'openwiki':'@colbymchenry/codegraph';
 const worker=new URL('./native-worker.mjs',import.meta.url),workerDigest=createHash('sha256').update(readFileSync(worker)).digest('hex');
 return {id:'initialize:'+id,integrationId:id,kind:'initialize',parameters:{executable:process.execPath,args:['--liftoff-only','--disable-warning=ExperimentalWarning',fileURLToPath(worker),'initialize',root,id,staging,control,workerDigest],cwd:root,envRefs:[]},prerequisiteIds,declaredWrites:[target,control,...(id==='codegraph'?[staging]:[])],version,timeoutMs:300000,protection:{kind:'native-staging',target,staging,control},query:{kind:'native-initialization',packageJson:prefix+'/node_modules/'+name+'/package.json',packageLock:prefix+'/package-lock.json',name,version,integrity}};
}
export async function emptyNativeScope(root:string,target:string):Promise<'missing'|'empty'> {
 const path=await targetPath(root,target);
 try {const st=await lstat(path);if(!st.isDirectory()||(await readdir(path)).length)throw new Error('existing non-empty native scope requires reconciliation; no overwrite');return 'empty';}
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return 'missing';throw error;}
}
export async function prepareNativeInitialization(root:string,id:NativeTool,version:string,integrity:string|undefined,input:{installed:boolean;prerequisiteIds?:string[];receipt?:NativeInitializationReceipt}):Promise<SetupOperation|{pending:string}|{reused:true}> {
 root=await realpath(root);
 if(!input.installed&&!input.prerequisiteIds?.length)return {pending:'Initialization requires a verified pinned project installation; enable project installation first'};
 const operation=initializationRecipe(root,id,version,integrity,input.prerequisiteIds);
 if(input.receipt){const state=await queryNativeInitialization(operation);return state.status==='done'&&signature(state.nativeReceipt)===signature(input.receipt)?{reused:true}:{pending:'Existing initialization changed; native state reconciliation required'};}
 try {for(const target of operation.declaredWrites)await emptyNativeScope(root,target);}
 catch{return {pending:'Existing or unsafe native state/staging scope requires reconciliation; user content preserved'};}
 return operation;
}
