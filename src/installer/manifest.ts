import {mkdir,rename,open,link,rm,lstat} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {renameWithRetry} from '../atomic-rename.js';
import {targetPath} from './ownership.js';
import {syncDirectory} from '../sync-directory.js';
import {assertPrivateAccess,createWindowsPrivateDirectory} from '../private-access.js';
import {platformFileMode} from './file-state.js';
export async function atomicProjectWrite(root:string,target:string,content:Buffer,mode?:number,exclusive=false,verifyCurrent?:()=>Promise<void>):Promise<void>{
 const path=await targetPath(root,target);
 const directory=dirname(path);
 const verifyPath=async()=>{
  if(await targetPath(root,target)!==path)throw new Error('target path changed during write');
 };
 await mkdir(directory,{recursive:true});
 await verifyPath();
 const parent=await lstat(directory,{bigint:true});
 if(!parent.isDirectory()||parent.ino===0n)throw new Error('target parent identity unavailable');
 const verifyParent=async()=>{
  const current=await lstat(directory,{bigint:true});
  if(!current.isDirectory()||current.dev!==parent.dev||current.ino!==parent.ino)throw new Error('target parent changed during write');
 };
 const verify=async()=>{
  await verifyPath();
  await verifyCurrent?.();
  await verifyParent();
 };
 const suffix='.rigup-'+randomUUID()+'.tmp';
 const temporary=path+suffix;
 const privateStaging=process.platform==='win32'&&(mode??0o600)===0o600;
 const staged=privateStaging?join(temporary,'content'):temporary;
 const removeTemporary=async()=>{
  if(await targetPath(root,target.replace(/\/$/,'')+suffix)!==temporary)throw new Error('temporary path changed during write');
  await verifyParent();
  await rm(temporary,{recursive:privateStaging,force:true});
 };
 try{
  if(privateStaging)await createWindowsPrivateDirectory(temporary,'Cannot create a private project record');
  const handle=await open(staged,'wx',mode??0o600);
  try{
   if(mode!==undefined)await handle.chmod(mode);
   const info=await handle.stat();
   if((info.mode&0o777)!==platformFileMode(mode??0o600))throw Error('Target filesystem did not retain the requested file mode');
   if(privateStaging)await assertPrivateAccess(staged,info,'Cannot protect a private project record');
   await handle.writeFile(content);await handle.sync();
  }finally{await handle.close();}
  if(exclusive){await verify();await link(staged,path);}
  else await renameWithRetry(()=>rename(staged,path),verify);
 }catch(error){
  // A failed write may have discovered a moved or redirected parent.
  await removeTemporary().catch(()=>{});
  throw error;
 }
 if(exclusive||privateStaging)await removeTemporary();
 await syncDirectory(directory);
}
