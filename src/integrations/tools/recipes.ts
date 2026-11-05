import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {signature} from '../../generator/cache.js';
import type {SetupOperation} from '../../types.js';
import type {Recipe} from '../upstream.js';

export type NativeTool='openwiki'|'codegraph';
export type ToolPin=Pick<Recipe,'version'|'packageIntegrity'>;

export function isNativeTool(id:string):id is NativeTool {
 return id==='openwiki'||id==='codegraph';
}

export function toolPackage(id:NativeTool) {
 return {id,prefix:'.rigup/tools/'+id,name:id==='openwiki'?'openwiki':'@colbymchenry/codegraph'};
}

export function softwareInstallRecipe(root:string,id:NativeTool,version:string,integrity?:string):SetupOperation {
 const {prefix,name}=toolPackage(id);
 return {id:'install:'+id,integrationId:id,kind:'install',parameters:{executable:'npm',args:['install','--prefix',resolve(root,prefix),'--cache',resolve(root,prefix,'.npm-cache'),'--ignore-scripts','--save-exact','--no-audit','--no-fund','--userconfig',resolve(root,prefix,'.npmrc.user'),'--globalconfig',resolve(root,prefix,'.npmrc.global'),'--registry','https://registry.npmjs.org/',name+'@'+version],cwd:'.',envRefs:[]},prerequisiteIds:[],declaredWrites:[prefix],version,timeoutMs:300000,protection:{kind:'new-empty-scope',target:prefix},query:{kind:'npm-package',packageJson:prefix+'/node_modules/'+name+'/package.json',packageLock:prefix+'/package-lock.json',name,version,integrity}};
}

export function initializationRecipe(root:string,id:NativeTool,version:string,integrity?:string,prerequisiteIds:string[]=[]):SetupOperation {
 const target=id==='openwiki'?'openwiki':'.codegraph';
 const control='.rigup/native/'+id;
 const staging=id==='openwiki'?control+'/repository':'.codegraph-rigup-init';
 const {prefix,name}=toolPackage(id);
 const worker=new URL('./native-worker.mjs',import.meta.url),workerDigest=createHash('sha256').update(readFileSync(worker)).digest('hex');
 return {id:'initialize:'+id,integrationId:id,kind:'initialize',parameters:{executable:process.execPath,args:['--liftoff-only','--disable-warning=ExperimentalWarning',fileURLToPath(worker),'initialize',root,id,staging,control,workerDigest],cwd:root,envRefs:[]},prerequisiteIds,declaredWrites:[target,control,...(id==='codegraph'?[staging]:[])],version,timeoutMs:300000,protection:{kind:'native-staging',target,staging,control},query:{kind:'native-initialization',packageJson:prefix+'/node_modules/'+name+'/package.json',packageLock:prefix+'/package-lock.json',name,version,integrity}};
}

export function assertToolOperationRecipe(root:string,operation:SetupOperation,pin:ToolPin,prerequisites:string[]):void {
 const id=operation.integrationId;
 if(!isNativeTool(id)||!['install','initialize'].includes(operation.kind))throw Error('External operation has no verified adapter');
 if(operation.version!==pin.version||operation.query.integrity!==pin.packageIntegrity)throw Error('Operation version/integrity is not verified');
 const expected=operation.kind==='install'
  ?softwareInstallRecipe(root,id,pin.version,pin.packageIntegrity)
  :initializationRecipe(root,id,pin.version,pin.packageIntegrity,prerequisites);
 if(signature(expected)!==signature(operation))throw Error('Operation differs from verified recipe');
}
