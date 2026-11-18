import {assertGlobalOperation} from './global-npm.js';
import {basename,isAbsolute,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {lstatSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {signature} from '../../generator/cache.js';
import type {SetupOperation} from '../../types.js';
import {defaultNpmRegistry,isStableNpmVersion,normalizeNpmRegistry,npmRegistryFlags,type NpmPackageIdentity} from './npm-resolution.js';
import {normalizeNpmIntegrity} from '../../npm-integrity.mjs';
import {openspecPackage} from '../sdd/openspec.js';

export type NativeTool='openwiki'|'codegraph';
export type SoftwareTool=NativeTool|'openspec';

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

export const isSoftwareTool=(id:string):id is SoftwareTool=>id==='openspec'||isNativeTool(id);
export function toolPackage(id:SoftwareTool) {
 return {id,prefix:'.rigup/tools/'+id,name:id==='openspec'?openspecPackage:id==='openwiki'?'openwiki':'@colbymchenry/codegraph',entry:id==='openspec'?'bin/openspec.js':id==='openwiki'?'dist/cli/cli.js':'npm-shim.js'} as const;
}

export function softwareInstallRecipe(root:string,id:SoftwareTool,version:string,integrity?:string,prefix=toolPackage(id).prefix,registry?:string,enginesNode?:string):SetupOperation {
 const {name}=toolPackage(id);
 if(registry!==undefined&&normalizeNpmRegistry(registry)!==registry)throw Error('Operation registry must use its normalized credential-free identity');
 const args=['install','--prefix',resolve(root,prefix),'--ignore-scripts','--save-exact','--no-audit','--no-fund',...npmRegistryFlags(name,registry??defaultNpmRegistry),name+'@'+version];
 return {id:'install:'+id,integrationId:id,kind:'install',...(registry?{registry}:{}),parameters:{executable:'npm',args,cwd:'.',envRefs:[]},prerequisiteIds:[],declaredWrites:[prefix],version,timeoutMs:300000,protection:{kind:'new-empty-scope',target:prefix},query:{kind:'npm-package',packageJson:prefix+'/node_modules/'+name+'/package.json',packageLock:prefix+'/package-lock.json',name,version,integrity,enginesNode}};
}

export function nativeInitializationPaths(id:NativeTool){
 const target=id==='openwiki'?'openwiki':'.codegraph';
 const control='.rigup/native/'+id;
 const staging=id==='openwiki'?control+'/repository':'.codegraph-rigup-init';
 return {target,control,staging,declaredWrites:[target,control,...(id==='codegraph'?[staging]:[])]};
}

export function initializationRecipe(root:string,id:NativeTool,version:string,integrity?:string,prerequisiteIds:string[]=[]):SetupOperation {
 const {target,control,staging,declaredWrites}=nativeInitializationPaths(id);
 const {prefix,name}=toolPackage(id);
 const worker=new URL('./native-worker.mjs',import.meta.url),workerDigest=createHash('sha256').update(readFileSync(worker)).digest('hex');
 return {id:'initialize:'+id,integrationId:id,kind:'initialize',parameters:{executable:process.execPath,args:['--liftoff-only','--disable-warning=ExperimentalWarning',fileURLToPath(worker),'initialize',root,id,staging,control,workerDigest,version],cwd:root,envRefs:[]},prerequisiteIds,declaredWrites,version,timeoutMs:300000,protection:{kind:'native-staging',target,staging,control},query:{kind:'native-initialization',packageJson:prefix+'/node_modules/'+name+'/package.json',packageLock:prefix+'/package-lock.json',name,version,integrity}};
}

export function toolOperationPrerequisites(operations:SetupOperation[],operation:SetupOperation):string[]{
 const previous=operations.slice(0,operations.indexOf(operation));
 if(operations.filter(op=>op.id===operation.id).length!==1||operation.prerequisiteIds.some(id=>!previous.some(op=>op.id===id)))
  throw Error('Missing, duplicate or reordered operation prerequisite');
 if(operation.kind!=='initialize')return [];
 const installs=operations.filter(op=>op.kind==='install'&&op.integrationId===operation.integrationId);
 if(installs.some(op=>op.version!==operation.version||op.query.integrity!==operation.query.integrity))throw Error('Initialization differs from its approved install');
 return installs.map(op=>op.id);
}

export function toolOperationIdentity(operation:SetupOperation):NpmPackageIdentity{
 const version=operation.version,packageIntegrity=normalizeNpmIntegrity(operation.query?.integrity);
 if(!isStableNpmVersion(version)||version!==operation.query?.version||!packageIntegrity)throw Error('Operation version/integrity is not verified');
 return {version,packageIntegrity};
}

function expectedToolOperation(root:string,operation:SetupOperation,prerequisites:string[]):SetupOperation {
 const id=operation.integrationId;
 const {version,packageIntegrity}=toolOperationIdentity(operation);
 if(operation.kind==='install'&&isSoftwareTool(id))return softwareInstallRecipe(root,id,version,packageIntegrity,undefined,operation.registry,operation.query.enginesNode);
 if(operation.kind==='initialize'&&isNativeTool(id))return initializationRecipe(root,id,version,packageIntegrity,prerequisites);
 throw Error('External operation has no verified adapter');
}

export function assertToolOperationRecipe(root:string,operation:SetupOperation,prerequisites:string[]):void {
 if(operation.global){assertGlobalOperation(root,operation);return;}
 const expected=expectedToolOperation(root,operation,prerequisites);
 if(signature(expected)!==signature(operation))throw Error('Operation differs from verified recipe');
}

// Reconcile an exact prior recipe with the current adapter.
// Dispatchers must separately prove this operation was previously approved.
export function verifiedToolOperationForResume(root:string,operation:SetupOperation,prerequisites:string[]):SetupOperation {
 if(operation.global){assertGlobalOperation(root,operation);return operation;}
 const expected=expectedToolOperation(root,operation,prerequisites);
 const actual=signature(operation);
 if(signature(expected)===actual)return expected;
 if(expected.kind==='install'){
  const prefix=resolve(root,expected.protection.target);
  const args=['install','--prefix',prefix,'--cache',resolve(prefix,'.npm-cache'),'--ignore-scripts','--save-exact','--no-audit','--no-fund',
   '--userconfig',resolve(prefix,'.npmrc.user'),'--globalconfig',resolve(prefix,'.npmrc.global'),'--registry',expected.registry??defaultNpmRegistry,expected.query.name+'@'+expected.version];
  if(signature({...expected,parameters:{...expected.parameters,args}})===actual)return expected;
 }
 const digest=operation.parameters?.args?.[8];
 const legacy=v024WorkerDigests.has(digest)&&expected.version===(operation.integrationId==='openwiki'?'0.7.3':'1.6.2');
 if(expected.kind==='initialize'&&(digest===expected.parameters.args[8]||legacy)){
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
  if(legacy)args.pop();
  if(signature({...expected,parameters:{...expected.parameters,executable,args}})===actual)return expected;
 }
 throw Error('Operation differs from verified recipe');
}
