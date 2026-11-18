import {open,readFile,rename,rm} from 'node:fs/promises';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {renameWithRetry} from './atomic-rename.js';
import {syncDirectory} from './sync-directory.js';
export function isRecord(value:unknown):value is Record<string,unknown> {
 return !!value&&typeof value==='object'&&!Array.isArray(value);
}

export async function readPrivateJson<T>(path:string):Promise<T|undefined> {
 let raw:string;
 try {
  raw=await readFile(path,'utf8');
 }catch(error){
  if((error as NodeJS.ErrnoException).code==='ENOENT')return;
  throw error;
 }
 try{return JSON.parse(raw);}catch{throw new SyntaxError('Invalid JSON in private record: '+path);}
}

export class InvalidDurableRecord extends Error {
 constructor(record:string,path?:string){super(record+' is corrupt; reconciliation required'+(path?' ('+path+')':''));}
}

export async function readDurableRecord<T>(path:string,record:string,valid?:(value:T)=>boolean):Promise<T|undefined> {
 let value:T|undefined;
 try{value=await readPrivateJson<T>(path);}catch(error){
  if(error instanceof SyntaxError)throw new InvalidDurableRecord(record,path);
  throw error;
 }
 if(value===undefined)return;
 if(!isRecord(value)||valid&&!valid(value))throw new InvalidDurableRecord(record,path);
 return value;
}

export async function saveDurable(path:string,content:string):Promise<void>{
 const temp=path+'.'+randomUUID()+'.tmp';const file=await open(temp,'wx',0o600);
 try{
  try{await file.writeFile(content);await file.sync();}finally{await file.close();}
  await renameWithRetry(()=>rename(temp,path));
 }catch(error){
  await rm(temp,{force:true}).catch(()=>{});
  throw error;
 }
 await syncDirectory(dirname(path));
}
