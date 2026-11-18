import {mkdir,rename,open,link,rm,lstat} from 'node:fs/promises';
import {basename,dirname} from 'node:path';
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
 verifyCurrent?:()=>Promise<void>,recordMode?:(mode:number,stage?:string)=>Promise<void>,afterLink?:()=>Promise<void>,stageDirectory?:string):Promise<void>{
 const path=await targetPath(root,target);
 const directory=dirname(path);
 const verifyPath=async()=>{
  if(await targetPath(root,target)!==path)throw new Error('target path changed during write');
 };
 await mkdir(directory,{recursive:true});
 await verifyPath();
 const parent=await lstat(directory,{bigint:true});
 if(!parent.isDirectory())throw Error('Target parent is not a directory: '+directory);
 const suffix='.rigup-'+randomUUID()+'.tmp';
 const stageTarget=stageDirectory?stageDirectory+'/'+basename(path)+suffix:target.replace(/\/$/,'')+suffix;
 if(stageDirectory)await mkdir(await targetPath(root,stageDirectory),{recursive:true});
 const temporary=stageDirectory?await targetPath(root,stageTarget):path+suffix;
 const stageParentPath=dirname(temporary);
 const stageParent=stageDirectory?await lstat(stageParentPath,{bigint:true}):parent;
 if(!stageParent.isDirectory()||stageParent.dev!==parent.dev)throw Error('Project write staging must be on the target filesystem');
 const verifyDirectory=async(dir:string,expected:typeof parent)=>{
  const current=await lstat(dir,{bigint:true});
  if(!current.isDirectory()||expected.ino!==0n&&current.ino!==0n&&(current.dev!==expected.dev||current.ino!==expected.ino))throw Error('target parent changed during write');
 };
 const verifyStage=async()=>{
  if(await targetPath(root,stageTarget)!==temporary)throw Error('staging path changed during write');
  await verifyDirectory(stageParentPath,stageParent);
 };
 const verify=async()=>{
  await verifyPath();
  await verifyCurrent?.();
  await verifyDirectory(directory,parent);
  if(stageDirectory)await verifyStage();
 };
 let created=false,keepStage=false;
 try{
  const handle=await open(temporary,'wx',mode);
  created=true;
  let observed:number;
  try{
   observed=await stagedFileMode(handle,mode,target);
   await handle.writeFile(content);await handle.sync();
  }finally{await handle.close();}
  await recordMode?.(observed,exclusive?stageTarget:undefined);
  if(exclusive){
   await verify();
   try{await link(temporary,path);}catch(error){
    throw new ExclusiveLinkError(target,error);
   }
   keepStage=!!afterLink;
   if(afterLink){
    await syncDirectory(directory);
    await afterLink();
   }
   keepStage=false;
  }else{
   await renameWithRetry(()=>rename(temporary,path),verify);
   created=false;
  }
 }finally{
  if(created&&!keepStage){
   try{
    await verifyStage();
    await rm(temporary,{force:true});
   }catch{/* A replaced parent may contain a different temporary file. */}
  }
 }
 await syncDirectory(directory);
 if(stageParentPath!==directory)await syncDirectory(stageParentPath);
}
