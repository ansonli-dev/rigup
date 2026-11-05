import {lstat,readdir,realpath} from 'node:fs/promises';
import {targetPath} from '../../installer/ownership.js';
import type {SetupOperation,NativeInitializationReceipt} from '../../types.js';
import {verifyToolInitializationReceipt} from './native-state.js';
import {initializationRecipe,type NativeTool} from './recipes.js';
export {initializationRecipe,type NativeTool} from './recipes.js';

export async function assertEmptyNativeScope(root:string,target:string):Promise<void> {
 const path=await targetPath(root,target);
 try {const st=await lstat(path);if(!st.isDirectory()||(await readdir(path)).length)throw new Error('existing non-empty native scope requires reconciliation; no overwrite');}
 catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
}
export async function assertEmptyToolScopes(root:string,operation:SetupOperation):Promise<void> {
 for(const target of operation.declaredWrites)await assertEmptyNativeScope(root,target);
}

export async function prepareNativeInitialization(root:string,id:NativeTool,version:string,integrity:string|undefined,input:{installed:boolean;prerequisiteIds?:string[];receipt?:NativeInitializationReceipt}):Promise<SetupOperation|{pending:string}|{reused:true}> {
 root=await realpath(root);
 if(!input.installed&&!input.prerequisiteIds?.length)return {pending:'Initialization requires a verified pinned project installation; enable project installation first'};
 const operation=initializationRecipe(root,id,version,integrity,input.prerequisiteIds);
 if(input.receipt)return await verifyToolInitializationReceipt(root,id,{version,packageIntegrity:integrity},input.receipt)?{reused:true}:{pending:'Existing initialization changed; native state reconciliation required'};
 try {await assertEmptyToolScopes(root,operation);}
 catch{return {pending:'Existing or unsafe native state/staging scope requires reconciliation; user content preserved'};}
 return operation;
}
