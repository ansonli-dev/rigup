import {mkdir,rename,open,link,unlink} from 'node:fs/promises';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {renameWithRetry} from '../atomic-rename.js';
import {targetPath} from './ownership.js';
import {syncDirectory} from '../sync-directory.js';
export async function atomicProjectWrite(root:string,target:string,content:Buffer,mode?:number,exclusive=false):Promise<void>{
 const path=await targetPath(root,target);
 const verify=async()=>{
  if(await targetPath(root,target)!==path)throw new Error('target path changed during write');
 };
 await mkdir(dirname(path),{recursive:true});
 await verify();
 const suffix='.rigup-'+randomUUID()+'.tmp';
 const temporary=path+suffix;
 const removeTemporary=async()=>{
  if(await targetPath(root,target.replace(/\/$/,'')+suffix)!==temporary)throw new Error('temporary path changed during write');
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
 await syncDirectory(dirname(path));
}
