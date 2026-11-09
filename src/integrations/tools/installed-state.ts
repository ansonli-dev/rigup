import {readFile,lstat,realpath} from 'node:fs/promises';
import {join,isAbsolute,posix} from 'node:path';
import {targetPath} from '../../installer/ownership.js';
import {digest} from '../../analyzer/evidence.js';
import {isNativeTool,toolPackage,type NativeTool,type ToolPin} from './recipes.js';
export interface ToolInstallReceipt {version:string;packageLockDigest:string}
export interface InstalledToolState {status:'done'|'unknown';message:string;receipt?:ToolInstallReceipt}
export function queryPinnedTool(root:string,id:NativeTool,pin:ToolPin,lockDigest?:string):Promise<InstalledToolState> {
 return queryInstalledTool(root,{...toolPackage(id),version:pin.version,integrity:pin.packageIntegrity,lockDigest});
}
export async function verifyToolInstallReceipt(root:string,id:NativeTool,pin:ToolPin,receipt?:ToolInstallReceipt):Promise<boolean> {
 if(!receipt||receipt.version!==pin.version||!/^[a-f0-9]{64}$/.test(receipt.packageLockDigest))return false;
 return (await queryPinnedTool(root,id,pin,receipt.packageLockDigest)).status==='done';
}
export async function queryInstalledTool(root:string,input:{prefix:string;id:string;name:string;version:string;integrity?:string;lockDigest?:string}):Promise<InstalledToolState>{
 try {
  const q={packageJson:input.prefix+'/node_modules/'+input.name+'/package.json',packageLock:input.prefix+'/package-lock.json',name:input.name,version:input.version,integrity:input.integrity};
  const pkg=JSON.parse(await readFile(await targetPath(root,q.packageJson),'utf8'));const raw=await readFile(await targetPath(root,q.packageLock));const lock=JSON.parse(raw.toString());
  if(input.lockDigest&&digest(raw)!==input.lockDigest)return {status:'unknown',message:'Installed lock no longer matches trusted receipt'};
  const resolved=lock.packages?.['node_modules/'+q.name];
  if(pkg.name!==q.name||pkg.version!==q.version||lock.packages?.['']?.dependencies?.[q.name]!==q.version||resolved?.version!==q.version||q.integrity&&resolved?.integrity!==q.integrity)return {status:'unknown',message:'Installed state does not match pinned receipt; manual reconciliation required'};
  for(const [path,metadata] of Object.entries(lock.packages??{}) as [string,{version?:string;optional?:boolean}][]) {
   if(!path)continue;
   try{const dependency=JSON.parse(await readFile(await targetPath(root,input.prefix+'/'+path+'/package.json'),'utf8'));if(dependency.version!==metadata.version)throw new Error('version mismatch');}
   catch(e){if(metadata.optional&&(e as NodeJS.ErrnoException).code==='ENOENT')continue;return {status:'unknown',message:'Installed dependency tree incomplete; manual reconciliation required'};}
  }
  const binaryName=input.id;const relativeBin=typeof pkg.bin==='string'?pkg.bin:pkg.bin?.[binaryName];
  if(typeof relativeBin!=='string')return {status:'unknown',message:'Expected installed binary missing'};
  if(isAbsolute(relativeBin)||relativeBin.includes('\\')||relativeBin.split('/').includes('..'))return {status:'unknown',message:'Installed binary path escapes package'};
  const entry=posix.normalize(relativeBin);
  const windows=process.platform==='win32';
  if(windows&&(!isNativeTool(binaryName)||toolPackage(binaryName).entry!==entry))return {status:'unknown',message:'Installed binary differs from pinned Node launcher'};
  const binary=await targetPath(root,input.prefix+'/node_modules/'+q.name+'/'+entry);
  const executable=await lstat(binary);if(!executable.isFile()||!windows&&!(executable.mode&0o111))return {status:'unknown',message:'Installed binary is not executable'};
  if(!windows){
   const directory=await targetPath(root,input.prefix+'/node_modules/.bin');
   const launcher=await realpath(join(directory,binaryName));
   if(launcher!==await realpath(binary))return {status:'unknown',message:'Native binary launcher does not match installed package'};
  }
  return {status:'done',message:'Pinned installation verified',receipt:{version:q.version,packageLockDigest:digest(raw)}};
 }catch{return {status:'unknown',message:'Cannot prove external operation result; query or manual reconciliation required'};}
}
