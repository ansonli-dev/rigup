import {verifyToolInstallReceipt,type ToolInstallReceipt} from './installed-state.js';
import {softwareInstallRecipe,toolPackage,type NativeTool} from './recipes.js';
import {lstat,readdir,realpath} from 'node:fs/promises';
import {resolve} from 'node:path';
import type {SetupOperation} from '../../types.js';
export async function prepareSoftwareInstall(root:string,id:NativeTool,version:string,integrity?:string,receipt?:ToolInstallReceipt):Promise<SetupOperation|{pending:string}|{reused:true;version:string}>{
 root=await realpath(root);
 const {prefix}=toolPackage(id);
 let current=root;
 for(const part of prefix.split('/')) {
  current=resolve(current,part);
  try {const info=await lstat(current);if(info.isSymbolicLink() || !info.isDirectory()) return {pending:'existing tool scope is not a safe directory'};}
  catch(error){if((error as NodeJS.ErrnoException).code === 'ENOENT') break;throw error;}
 }
 try {if((await readdir(resolve(root,prefix))).length) {
   if(integrity&&await verifyToolInstallReceipt(root,id,{version,packageIntegrity:integrity},receipt))return {reused:true,version};
   return {pending:'existing non-empty tool scope requires reconciliation; no automatic overwrite'};
  }}
 catch(error){if((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
 return softwareInstallRecipe(root,id,version,integrity);
}
