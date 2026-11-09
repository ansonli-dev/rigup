import {lstat,mkdir,rename,rm,rmdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {targetPath} from './ownership.js';
import {assertEmptyNativeScope} from '../integrations/tools/initialization.js';
import {softwareInstallRecipe,type NativeTool} from '../integrations/tools/recipes.js';
import {renameWithRetry} from '../atomic-rename.js';
import {syncDirectory} from '../sync-directory.js';
import type {SetupOperation} from '../types.js';

export interface InstallStage {token:string;identity?:string}
export function validInstallStage(value:unknown):value is InstallStage {
 if(!value||typeof value!=='object')return false;
 const stage=value as Partial<InstallStage>;
 return typeof stage.token==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(stage.token)&&
  (stage.identity===undefined||typeof stage.identity==='string'&&/^\d+:[1-9]\d*$/.test(stage.identity));
}

export function stagedInstall(root:string,operation:SetupOperation,stage:InstallStage):SetupOperation {
 const id=operation.integrationId as NativeTool;
 return softwareInstallRecipe(root,id,operation.version,operation.query.integrity,'.rigup/tools/.install-'+id+'-'+stage.token);
}

export async function installDirectoryIdentity(root:string,target:string):Promise<string|undefined>{
 const path=await targetPath(root,target);
 try{
  const info=await lstat(path,{bigint:true});
  if(!info.isDirectory()||info.ino===0n)throw Error('Installation directory identity unavailable at '+target);
  return info.dev+':'+info.ino;
 }catch(error){
  if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
 }
}

export async function ownedInstallStage(root:string,target:string,stage:InstallStage):Promise<string|undefined>{
 const identity=await installDirectoryIdentity(root,target);
 if(!identity)return;
 if(!stage.identity){
  // A crash between mkdir and journaling the identity can leave an empty
  // directory. A new attempt gets a different scope and leaves it alone.
  try{await assertEmptyNativeScope(root,target);return;}catch{}
 }
 if(identity!==stage.identity)throw Error('Installation staging identity changed at '+target+'; preserve the directory before resuming');
 return targetPath(root,target);
}

export async function createInstallStage(root:string,target:string):Promise<string>{
 const path=await targetPath(root,target);
 await mkdir(dirname(path),{recursive:true});
 await mkdir(await targetPath(root,target),{mode:0o700});
 const identity=await installDirectoryIdentity(root,target);
 if(!identity)throw Error('Installation staging disappeared at '+target);
 await syncDirectory(dirname(path));
 return identity;
}

export async function clearInstallStage(root:string,target:string,stage:InstallStage):Promise<void>{
 const path=await ownedInstallStage(root,target,stage);
 if(path)await rm(path,{recursive:true,force:true,maxRetries:3,retryDelay:50});
}

export async function assertInstallDestination(root:string,operation:SetupOperation):Promise<void>{
 try{await assertEmptyNativeScope(root,operation.protection.target);}
 catch(error){throw Error(operation.id+' has unverified content at '+operation.protection.target+'; preserve it outside the tool scope before resuming',{cause:error});}
}

export async function publishInstallStage(root:string,operation:SetupOperation,staged:SetupOperation,stage:InstallStage):Promise<void>{
 const staging=await ownedInstallStage(root,staged.protection.target,stage);
 if(!staging)throw Error('Verified installation staging is unavailable at '+staged.protection.target);
 await assertInstallDestination(root,operation);
 const destination=await targetPath(root,operation.protection.target);
 // Only a directory proven empty can be removed. Windows cannot rename over it.
 try{await rmdir(destination);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 await renameWithRetry(()=>rename(staging,destination),async()=>{
  if(await ownedInstallStage(root,staged.protection.target,stage)!==staging)throw Error('Installation staging changed before publication');
  await assertInstallDestination(root,operation);
 });
 await syncDirectory(dirname(destination));
}
