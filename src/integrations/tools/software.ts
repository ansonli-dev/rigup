import {digest,safePath} from '../../analyzer/evidence.js';
import {lstat,readdir,realpath,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import type {SetupOperation} from '../../types.js';
export async function prepareSoftwareInstall(root:string,id:'openwiki'|'codegraph',version:string,integrity?:string,receipt?:{version:string;packageLockDigest:string}):Promise<SetupOperation|{pending:string}|{reused:true;version:string}>{
 root=await realpath(root);
 const prefix='.rigup/tools/'+id;
 const name=id === 'codegraph' ? '@colbymchenry/codegraph' : 'openwiki';
 let current=root;
 for(const part of prefix.split('/')) {
  current=resolve(current,part);
  try {const info=await lstat(current);if(info.isSymbolicLink() || !info.isDirectory()) return {pending:'existing tool scope is not a safe directory'};}
  catch(error){if((error as NodeJS.ErrnoException).code === 'ENOENT') break;throw error;}
 }
 try {if((await readdir(resolve(root,prefix))).length) {
   if(receipt && receipt.version === version && integrity) {
    try {
     const lockBytes=await readFile(await safePath(root,prefix+'/package-lock.json'));
     const lock=JSON.parse(lockBytes.toString('utf8'));
     const pkg=JSON.parse(await readFile(await safePath(root,prefix+'/node_modules/'+name+'/package.json'),'utf8'));
     if(digest(lockBytes) === receipt.packageLockDigest && pkg.name === name && pkg.version === version && lock.packages?.['node_modules/'+name]?.integrity === integrity) return {reused:true,version};
    }catch {/* Failed reconciliation leaves the existing scope untouched. */}
   }
   return {pending:'existing non-empty tool scope requires reconciliation; no automatic overwrite'};
  }}
 catch(error){if((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
 return {id:'install:'+id,integrationId:id,kind:'install',parameters:{executable:'npm',args:['install','--prefix',resolve(root,prefix),'--cache',resolve(root,prefix,'.npm-cache'),'--ignore-scripts','--save-exact','--no-audit','--no-fund','--userconfig',resolve(root,prefix,'.npmrc.user'),'--globalconfig',resolve(root,prefix,'.npmrc.global'),'--registry','https://registry.npmjs.org/',name+'@'+version],cwd:'.',envRefs:[]},prerequisiteIds:[],declaredWrites:[prefix],version,timeoutMs:300000,protection:{kind:'new-empty-scope',target:prefix},query:{kind:'npm-package',packageJson:prefix+'/node_modules/'+name+'/package.json',packageLock:prefix+'/package-lock.json',name,version,integrity}};
}
