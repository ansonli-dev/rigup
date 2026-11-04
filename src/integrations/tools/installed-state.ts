import {readFile,lstat,realpath} from 'node:fs/promises';
import {join,isAbsolute,posix} from 'node:path';
import {targetPath} from '../../installer/ownership.js';
import {digest} from '../../analyzer/evidence.js';
export interface InstalledToolState {status:'done'|'unknown';message:string;receipt?:{version:string;packageLockDigest:string}}
export async function queryInstalledTool(root:string,input:{prefix:string;id:string;name:string;version:string;integrity?:string;lockDigest?:string}):Promise<InstalledToolState>{
 try {
  const q={packageJson:input.prefix+'/node_modules/'+input.name+'/package.json',packageLock:input.prefix+'/package-lock.json',name:input.name,version:input.version,integrity:input.integrity};
  const pkg=JSON.parse(await readFile(await targetPath(root,q.packageJson),'utf8'));const raw=await readFile(await targetPath(root,q.packageLock));const lock=JSON.parse(raw.toString());
  if(input.lockDigest&&digest(raw)!==input.lockDigest)return {status:'unknown',message:'Installed lock no longer matches trusted receipt'};
  const resolved=lock.packages?.['node_modules/'+q.name];
  if(pkg.name!==q.name||pkg.version!==q.version||lock.packages?.['']?.dependencies?.[q.name]!==q.version||resolved?.version!==q.version||q.integrity&&resolved?.integrity!==q.integrity)return {status:'unknown',message:'Installed state does not match pinned receipt; manual reconciliation required'};
  const bin=await targetPath(root,input.prefix+'/node_modules/'+q.name+'/package.json');const installed=JSON.parse(await readFile(bin,'utf8'));
  if(installed.name!==q.name||installed.version!==q.version)return {status:'unknown',message:'Installed package metadata mismatch'};
  for(const [path,metadata] of Object.entries(lock.packages??{}) as [string,{version?:string;optional?:boolean}][]) {
   if(!path)continue;
   try{const dependency=JSON.parse(await readFile(await targetPath(root,input.prefix+'/'+path+'/package.json'),'utf8'));if(dependency.version!==metadata.version)throw new Error('version mismatch');}
   catch(e){if(metadata.optional&&(e as NodeJS.ErrnoException).code==='ENOENT')continue;return {status:'unknown',message:'Installed dependency tree incomplete; manual reconciliation required'};}
  }
  const binaryName=input.id;const relativeBin=typeof installed.bin==='string'?installed.bin:installed.bin?.[binaryName];
  if(typeof relativeBin!=='string')return {status:'unknown',message:'Expected installed binary missing'};
  if(isAbsolute(relativeBin)||relativeBin.split('/').includes('..'))return {status:'unknown',message:'Installed binary path escapes package'};
  const binary=await targetPath(root,input.prefix+'/node_modules/'+q.name+'/'+posix.normalize(relativeBin));
  const executable=await lstat(binary);if(!executable.isFile()||!(executable.mode&0o111))return {status:'unknown',message:'Installed binary is not executable'};
  const launcher=await realpath(join(root,input.prefix,'node_modules/.bin',binaryName));
  if(launcher!==await realpath(binary))return {status:'unknown',message:'Native binary launcher does not match installed package'};
  return {status:'done',message:'Pinned installation verified',receipt:{version:q.version,packageLockDigest:digest(raw)}};
 }catch{return {status:'unknown',message:'Cannot prove external operation result; query or manual reconciliation required'};}
}
