import {realpath} from 'node:fs/promises';
import {readVerifiedToolInstall,type ToolInstallReceipt} from './installed-state.js';
import {assertEmptyNativeScope} from './initialization.js';
import {toolPackage,type NativeTool} from './recipes.js';
import type {NpmPackageIdentity} from './npm-resolution.js';

export async function inspectProjectToolInstall(root:string,id:NativeTool,receipt?:ToolInstallReceipt):Promise<{root:string}|{identity:NpmPackageIdentity}|{pending:string}>{
 root=await realpath(root);
 if(receipt!==undefined){
  const identity=await readVerifiedToolInstall(root,id,receipt);
  return identity?{identity}:{pending:'Existing tool installation and receipt require reconciliation; preserve local files'};
 }
 try{await assertEmptyNativeScope(root,toolPackage(id).prefix);}
 catch{return {pending:'Existing non-empty or unsafe tool scope requires reconciliation; preserve local files'};}
 return {root};
}
