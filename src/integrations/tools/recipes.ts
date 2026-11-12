import {basename,isAbsolute,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {lstatSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {signature} from '../../generator/cache.js';
import type {SetupOperation} from '../../types.js';
import type {Recipe} from '../upstream.js';
import {validateProviderBaseURL} from '../../analyzer/provider-url.js';

export type NativeTool='openwiki'|'codegraph';
export type ToolPin=Pick<Recipe,'version'|'packageIntegrity'>;

// Exact bytes of the v0.2.4 adapter (cf7cd0a) in source and tsc output,
// including CRLF variants for Windows checkouts and builds.
const v024WorkerDigests=new Set([
 '6cf421b0ba225d9f371a7dd67b083475fed40bacd30aee838a7d4bfb18cbf5b8',
 '4cedd2d4e9de317a10d60e82a7211aa20837d4f1f250704fde9b9141a3d32c19',
 '7a9e129185bd1c91eb6985ba3cb63d30e0c5c3b9a8a2ac9d93354d3ae43589a7',
 '3bb951b931d7218fb70247d579c8b702ca0dd19a57c4ec68321bf5b6dc5debb3',
]);

export function isNativeTool(id:string):id is NativeTool {
 return id==='openwiki'||id==='codegraph';
}

export function toolPackage(id:NativeTool) {
 return {id,prefix:'.rigup/tools/'+id,name:id==='openwiki'?'openwiki':'@colbymchenry/codegraph',entry:id==='openwiki'?'dist/cli/cli.js':'npm-shim.js'};
}

export function softwareInstallRecipe(root:string,id:NativeTool,version:string,integrity?:string,prefix=toolPackage(id).prefix,registry?:string):SetupOperation {
 const {name}=toolPackage(id);
 if(registry!==undefined&&validateProviderBaseURL(registry).href.replace(/\/?$/,'/')!==registry)throw Error('Operation registry must use its normalized credential-free identity');
 return {id:'install:'+id,integrationId:id,kind:'install',...(registry?{registry}:{}),parameters:{executable:'npm',args:['install','--prefix',resolve(root,prefix),'--cache',resolve(root,prefix,'.npm-cache'),'--ignore-scripts','--save-exact','--no-audit','--no-fund','--userconfig',resolve(root,prefix,'.npmrc.user'),'--globalconfig',resolve(root,prefix,'.npmrc.global'),'--registry',registry??'https://registry.npmjs.org/',name+'@'+version],cwd:'.',envRefs:[]},prerequisiteIds:[],declaredWrites:[prefix],version,timeoutMs:300000,protection:{kind:'new-empty-scope',target:prefix},query:{kind:'npm-package',packageJson:prefix+'/node_modules/'+name+'/package.json',packageLock:prefix+'/package-lock.json',name,version,integrity}};
}

export function initializationRecipe(root:string,id:NativeTool,version:string,integrity?:string,prerequisiteIds:string[]=[]):SetupOperation {
 const target=id==='openwiki'?'openwiki':'.codegraph';
 const control='.rigup/native/'+id;
 const staging=id==='openwiki'?control+'/repository':'.codegraph-rigup-init';
 const {prefix,name}=toolPackage(id);
 const worker=new URL('./native-worker.mjs',import.meta.url),workerDigest=createHash('sha256').update(readFileSync(worker)).digest('hex');
 return {id:'initialize:'+id,integrationId:id,kind:'initialize',parameters:{executable:process.execPath,args:['--liftoff-only','--disable-warning=ExperimentalWarning',fileURLToPath(worker),'initialize',root,id,staging,control,workerDigest],cwd:root,envRefs:[]},prerequisiteIds,declaredWrites:[target,control,...(id==='codegraph'?[staging]:[])],version,timeoutMs:300000,protection:{kind:'native-staging',target,staging,control},query:{kind:'native-initialization',packageJson:prefix+'/node_modules/'+name+'/package.json',packageLock:prefix+'/package-lock.json',name,version,integrity}};
}

function expectedToolOperation(root:string,operation:SetupOperation,pin:ToolPin,prerequisites:string[]):SetupOperation {
 const id=operation.integrationId;
 if(!isNativeTool(id)||!['install','initialize'].includes(operation.kind))throw Error('External operation has no verified adapter');
 if(operation.version!==pin.version||operation.query.integrity!==pin.packageIntegrity)throw Error('Operation version/integrity is not verified');
 return operation.kind==='install'
  ?softwareInstallRecipe(root,id,pin.version,pin.packageIntegrity,undefined,operation.registry)
  :initializationRecipe(root,id,pin.version,pin.packageIntegrity,prerequisites);
}

export function assertToolOperationRecipe(root:string,operation:SetupOperation,pin:ToolPin,prerequisites:string[]):void {
 const expected=expectedToolOperation(root,operation,pin,prerequisites);
 if(signature(expected)!==signature(operation))throw Error('Operation differs from verified recipe');
}

// Reconcile an exact prior recipe with the current adapter.
// Dispatchers must separately prove this operation was previously approved.
export function verifiedToolOperationForResume(root:string,operation:SetupOperation,pin:ToolPin,prerequisites:string[]):SetupOperation {
 const expected=expectedToolOperation(root,operation,pin,prerequisites);
 const actual=signature(operation);
 if(signature(expected)===actual)return expected;
 const digest=operation.parameters?.args?.[8];
 if(expected.kind==='initialize'&&(digest===expected.parameters.args[8]||v024WorkerDigests.has(digest))){
  const executable=operation.parameters.executable,worker=operation.parameters.args[2];
  if(!isAbsolute(executable)||!/^node(?:\.exe)?$/i.test(basename(executable)))throw Error('Prior native operation executable is unverified');
  if(worker!==expected.parameters.args[2]){
   try{
    if(!isAbsolute(worker)||basename(worker)!=='native-worker.mjs')throw Error();
    const info=lstatSync(worker);
    if(!info.isFile()||info.size>128_000||createHash('sha256').update(readFileSync(worker)).digest('hex')!==digest)throw Error();
   }catch{throw Error('Prior native adapter is unavailable. Resume from the Rigup installation that prepared the operation.');}
  }
  const args=[...expected.parameters.args];args[2]=worker;args[8]=digest;
  if(signature({...expected,parameters:{...expected.parameters,executable,args}})===actual)return expected;
 }
 throw Error('Operation differs from verified recipe');
}
