import {readFile,lstat,realpath} from 'node:fs/promises';
import {join,isAbsolute,posix} from 'node:path';
import {targetPath} from '../../installer/ownership.js';
import {digest} from '../../analyzer/evidence.js';
import {isNativeTool,toolPackage,type NativeTool} from './recipes.js';
import {normalizeNpmIntegrity} from '../../npm-integrity.mjs';
import {isStableNpmVersion,type NpmPackageIdentity} from './npm-resolution.js';
export interface ToolInstallReceipt {version:string;packageLockDigest:string;packageIntegrity?:string}
export interface InstalledToolState {status:'done'|'unknown';message:string;receipt?:ToolInstallReceipt}
export function queryToolPackage(root:string,id:NativeTool,identity:NpmPackageIdentity):Promise<InstalledToolState> {
 return queryInstalledTool(root,{...toolPackage(id),version:identity.version,integrity:identity.packageIntegrity});
}
export async function readVerifiedToolInstall(root:string,id:NativeTool,receipt?:ToolInstallReceipt):Promise<NpmPackageIdentity|undefined>{
 if(!receipt||!isStableNpmVersion(receipt.version)||!/^[a-f0-9]{64}$/.test(receipt.packageLockDigest))return;
 const {receipt:verified}=await queryInstalledTool(root,{...toolPackage(id),version:receipt.version,integrity:receipt.packageIntegrity,lockDigest:receipt.packageLockDigest});
 if(verified?.packageIntegrity)return {version:verified.version,packageIntegrity:verified.packageIntegrity};
}
export async function queryInstalledTool(root:string,input:{prefix:string;id:string;name:string;version:string;integrity?:string;lockDigest?:string}):Promise<InstalledToolState>{
 try {
  const q={packageJson:input.prefix+'/node_modules/'+input.name+'/package.json',packageLock:input.prefix+'/package-lock.json',name:input.name,version:input.version,integrity:input.integrity};
  const pkg=JSON.parse(await readFile(await targetPath(root,q.packageJson),'utf8'));const raw=await readFile(await targetPath(root,q.packageLock));const lock=JSON.parse(raw.toString());
  const packageLockDigest=digest(raw);
  if(input.lockDigest!==undefined&&packageLockDigest!==input.lockDigest)return {status:'unknown',message:'Installed lock no longer matches trusted receipt'};
  const resolved=lock.packages?.['node_modules/'+q.name];
  const packageIntegrity=normalizeNpmIntegrity(resolved?.integrity);
  if(!packageIntegrity||q.integrity!==undefined&&packageIntegrity!==normalizeNpmIntegrity(q.integrity)||pkg.name!==q.name||pkg.version!==q.version||
   lock.packages?.['']?.dependencies?.[q.name]!==q.version||resolved?.version!==q.version)return {status:'unknown',message:'Installed state does not match approved package identity; manual reconciliation required'};
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
  if(!isNativeTool(binaryName)||toolPackage(binaryName).entry!==entry)return {status:'unknown',message:'Installed binary differs from expected Node launcher'};
  const binary=await targetPath(root,input.prefix+'/node_modules/'+q.name+'/'+entry);
  const executable=await lstat(binary);if(!executable.isFile()||!windows&&!(executable.mode&0o111))return {status:'unknown',message:'Installed binary is not executable'};
  if(!windows){
   const directory=await targetPath(root,input.prefix+'/node_modules/.bin');
   const launcher=await realpath(join(directory,binaryName));
   if(launcher!==await realpath(binary))return {status:'unknown',message:'Native binary launcher does not match installed package'};
  }
  return {status:'done',message:'Installation verified',receipt:{version:q.version,packageLockDigest,packageIntegrity}};
 }catch{return {status:'unknown',message:'Cannot prove external operation result; query or manual reconciliation required'};}
}
