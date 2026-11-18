import {mkdir,rename,open,link,rm,lstat} from 'node:fs/promises';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {renameWithRetry} from '../atomic-rename.js';
import {targetPath} from './ownership.js';
import {syncDirectory} from '../sync-directory.js';
import {stagedFileMode} from './filesystem-modes.js';
export class ExclusiveLinkError extends Error{
 constructor(target:string,cause:unknown){
  const exists=(cause as NodeJS.ErrnoException).code==='EEXIST';
  super(exists?'Target already exists: '+target:'Cannot create '+target+' exclusively. Use a filesystem that supports hard links for this target, then resume the original approval.',{cause});
 }
}
export async function atomicProjectWrite(root:string,target:string,content:Buffer,mode=0o600,exclusive=false,
 verifyCurrent?:()=>Promise<void>,recordMode?:(mode:number,stage?:string)=>Promise<void>,afterLink?:()=>Promise<void>):Promise<void>{
 const path=await targetPath(root,target);
 const directory=dirname(path);
 const verifyPath=async()=>{
  if(await targetPath(root,target)!==path)throw new Error('target path changed during write');
 };
 await mkdir(directory,{recursive:true});
 await verifyPath();
 const parent=await lstat(directory,{bigint:true});
 if(!parent.isDirectory())throw Error('Target parent is not a directory: '+directory);
 const verifyParent=async()=>{
  const current=await lstat(directory,{bigint:true});
  if(!current.isDirectory()||parent.ino!==0n&&current.ino!==0n&&(current.dev!==parent.dev||current.ino!==parent.ino))throw new Error('target parent changed during write');
 };
 const verify=async()=>{
  await verifyPath();
  await verifyCurrent?.();
  await verifyParent();
 };
 const suffix='.rigup-'+randomUUID()+'.tmp';
 const temporary=path+suffix;
 let created=false,keepStage=false;
 try{
  const handle=await open(temporary,'wx',mode);
  created=true;
  let observed:number;
  try{
   observed=await stagedFileMode(handle,mode,target);
   await handle.writeFile(content);await handle.sync();
  }finally{await handle.close();}
  await recordMode?.(observed,exclusive?target+suffix:undefined);
  if(exclusive){
   await verify();
   try{await link(temporary,path);}catch(error){
    throw new ExclusiveLinkError(target,error);
   }
   keepStage=!!afterLink;
   await afterLink?.();
   keepStage=false;
  }else{
   await renameWithRetry(()=>rename(temporary,path),verify);
   created=false;
  }
 }finally{
  if(created&&!keepStage){
   try{
    if(await targetPath(root,target.replace(/\/$/,'')+suffix)===temporary){
     await verifyParent();await rm(temporary,{force:true});
    }
   }catch{/* A replaced parent may contain a different temporary file. */}
  }
 }
 await syncDirectory(directory);
}
