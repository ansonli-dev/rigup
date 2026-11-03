import {mkdir,lstat,realpath,readFile,writeFile,rename} from 'node:fs/promises';
import {resolve,relative,isAbsolute,parse,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {digest} from '../analyzer/evidence.js';
export function stable(value:unknown):string {
 if(Array.isArray(value)) return '['+value.map(stable).join(',')+']';
 if(value && typeof value==='object') return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).filter(([,v])=>v!==undefined).map(([k,v])=>JSON.stringify(k)+':'+stable(v)).join(',')+'}';
 return JSON.stringify(value);
}
export const signature=(value:unknown)=>digest(stable(value));
export async function privateDirectory(path:string,project:string):Promise<string>{
 path=resolve(path);project=await realpath(project);const rel=relative(project,path);
 if(rel===''||(!rel.startsWith('..')&&!isAbsolute(rel))) throw new Error('cache must stay outside project');
 let current=parse(path).root;
 for(const part of relative(current,path).split('/').filter(Boolean)) {current=join(current,part);try {const st=await lstat(current);if(st.isSymbolicLink()||!st.isDirectory()) throw new Error('cache symlink or non-directory denied');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;await mkdir(current,{mode:0o700});}}
 if((await realpath(path))!==path||((await lstat(path)).mode&0o077))throw new Error('cache requires private permissions');return path;
}
export async function readCache<T>(path:string):Promise<T|undefined>{try {const st=await lstat(path);if(st.isSymbolicLink()||!st.isFile()||(st.mode&0o077))throw new Error('cache file not private');return JSON.parse(await readFile(path,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT'||e instanceof SyntaxError)return;throw e;}}
export async function saveCache(path:string,content:string):Promise<void>{const tmp=path+'.'+randomUUID()+'.tmp';await writeFile(tmp,content,{flag:'wx',mode:0o600});await rename(tmp,path);}
