import {mkdir,realpath,writeFile,rename} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {renameWithRetry} from '../atomic-rename.js';
import {digest} from '../analyzer/evidence.js';
import {readPrivateJson} from '../private-record.js';
import {directoryLocation} from '../path-location.js';
import {withinPath} from '../npm-command.mjs';
export function stable(value:unknown):string {
 if(Array.isArray(value)) return '['+value.map(stable).join(',')+']';
 if(value && typeof value==='object') return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).filter(([,v])=>v!==undefined).map(([k,v])=>JSON.stringify(k)+':'+stable(v)).join(',')+'}';
 return JSON.stringify(value);
}
export const signature=(value:unknown)=>digest(stable(value));
export async function privateDirectory(path:string,project:string):Promise<string>{
 const root=await realpath(project),directory=await directoryLocation(path);
 if(withinPath(root,directory))throw Error('cache must stay outside project: '+directory);
 await mkdir(directory,{recursive:true,mode:0o700});
 const actual=await realpath(directory);
 if(withinPath(root,actual))throw Error('cache must stay outside project: '+actual);
 return actual;
}
export async function readCache<T>(path:string):Promise<T|undefined>{
 try{return await readPrivateJson<T>(path);}catch(error){if(error instanceof SyntaxError)return;throw error;}
}
export async function saveCache(path:string,content:string):Promise<void>{
 const tmp=path+'.'+randomUUID()+'.tmp';
 await writeFile(tmp,content,{flag:'wx',mode:0o600});
 await renameWithRetry(()=>rename(tmp,path));
}
