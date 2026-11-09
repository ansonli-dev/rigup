import {mkdir,rename,open,link,unlink,lstat} from 'node:fs/promises';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {renameWithRetry} from '../atomic-rename.js';
import {targetPath} from './ownership.js';
import {syncDirectory} from '../sync-directory.js';
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
 const removeTemporary=async()=>{
  if(await targetPath(root,target.replace(/\/$/,'')+suffix)!==temporary)throw new Error('temporary path changed during write');
  await verifyParent();
  await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});
 };
 const handle=await open(temporary,'wx',mode??0o600);
 try{
  try{await handle.writeFile(content);if(mode!==undefined)await handle.chmod(mode);await handle.sync();}finally{await handle.close();}
  if(exclusive){await verify();await link(temporary,path);}
  else await renameWithRetry(()=>rename(temporary,path),verify);
 }catch(error){
  // A failed write may have discovered a moved or redirected parent.
  await removeTemporary().catch(()=>{});
  throw error;
 }
 if(exclusive)await removeTemporary();
 await syncDirectory(directory);
}
