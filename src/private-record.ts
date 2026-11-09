import {lstat,open,readFile,rename} from 'node:fs/promises';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {assertPrivateAccess} from './private-access.js';
import {syncDirectory} from './sync-directory.js';
export function isRecord(value:unknown):value is Record<string,unknown> {
 return !!value&&typeof value==='object'&&!Array.isArray(value);
}

export async function readPrivateJson<T>(path:string):Promise<T|undefined> {
 let raw:string;
 try {
  const st=await lstat(path);
  if(st.isSymbolicLink()||!st.isFile())throw new Error('cache file not private');
  await assertPrivateAccess(path,st,'cache file not private');
  raw=await readFile(path,'utf8');
 }catch(error){
  if((error as NodeJS.ErrnoException).code==='ENOENT')return;
  throw error;
 }
 return JSON.parse(raw);
}

export class InvalidDurableRecord extends Error {
 constructor(record:string){super(record+' is corrupt; reconciliation required');}
}

export async function readDurableRecord<T>(path:string,record:string,valid?:(value:T)=>boolean):Promise<T|undefined> {
 let value:T|undefined;
 try{value=await readPrivateJson<T>(path);}catch(error){
  if(error instanceof SyntaxError)throw new InvalidDurableRecord(record);
  throw error;
 }
 if(value===undefined)return;
 if(!isRecord(value)||valid&&!valid(value))throw new InvalidDurableRecord(record);
 return value;
}

export async function saveDurable(path:string,content:string):Promise<void>{
 const temp=path+'.'+randomUUID()+'.tmp';const file=await open(temp,'wx',0o600);
 try{await file.writeFile(content);await file.sync();}finally{await file.close();}
 await rename(temp,path);
 await syncDirectory(dirname(path));
}
