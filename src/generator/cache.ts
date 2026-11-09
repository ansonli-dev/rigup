import {mkdir,lstat,realpath,writeFile,rename} from 'node:fs/promises';
import {resolve,relative,isAbsolute,parse,join,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {digest} from '../analyzer/evidence.js';
import {readPrivateJson} from '../private-record.js';
import {assertPrivateAccess,assertSafeWindowsAncestors} from '../private-access.js';
export function stable(value:unknown):string {
 if(Array.isArray(value)) return '['+value.map(stable).join(',')+']';
 if(value && typeof value==='object') return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).filter(([,v])=>v!==undefined).map(([k,v])=>JSON.stringify(k)+':'+stable(v)).join(',')+'}';
 return JSON.stringify(value);
}
export const signature=(value:unknown)=>digest(stable(value));
export async function privateDirectory(path:string,project:string):Promise<string>{
 path=resolve(path);project=await realpath(project);const rel=relative(project,path);
 if(rel!=='..'&&!rel.startsWith('..'+sep)&&!isAbsolute(rel))throw new Error('cache must stay outside project');
 let current=parse(path).root;
 for(const part of relative(current,path).split(sep).filter(Boolean)){
  current=join(current,part);
  let stat=await lstat(current).catch(error=>{
   if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
  });
  if(!stat){
   await assertSafeWindowsAncestors(current,'cache requires private permissions');
   try{await mkdir(current,{mode:0o700});}catch(error){
    if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
   }
   stat=await lstat(current);
  }
  if(stat.isSymbolicLink()||!stat.isDirectory())throw new Error('cache symlink or non-directory denied');
 }
 if(await realpath(path)!==path)throw new Error('cache requires private permissions');
 await assertPrivateAccess(path,await lstat(path),'cache requires private permissions');
 return path;
}
export async function readCache<T>(path:string):Promise<T|undefined>{
 try{return await readPrivateJson<T>(path);}catch(error){if(error instanceof SyntaxError)return;throw error;}
}
export async function saveCache(path:string,content:string):Promise<void>{const tmp=path+'.'+randomUUID()+'.tmp';await writeFile(tmp,content,{flag:'wx',mode:0o600});await rename(tmp,path);}
