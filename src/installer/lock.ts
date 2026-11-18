import {homedir} from 'node:os';
import {join} from 'node:path';
import {realpath,unlink,open} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {privateDirectory,signature} from '../generator/cache.js';
import {readPrivateJson} from '../private-record.js';
import {syncDirectory} from '../sync-directory.js';

export interface ProcessIdentity {pid:number;started?:string}

export function validPid(pid:unknown):pid is number {
 return typeof pid==='number'&&Number.isInteger(pid)&&pid>0&&pid<=0x7fffffff;
}

export function processIdentity(pid:number):ProcessIdentity{
 if(!validPid(pid))throw Error('Invalid process ID');
 return {pid};
}

export function isAlive(identity:ProcessIdentity):boolean{
 if(!validPid(identity?.pid))throw Error('Invalid process ID');
 try{process.kill(identity.pid,0);return true;}
 catch(error){return (error as NodeJS.ErrnoException).code!=='ESRCH';}
}

export interface ProjectLock {root:string;id:string;stateRoot:string;release():Promise<void>}
export const defaultStateRoot=()=>join(homedir(),'.local','state','rigup');
type LockRecord={root:string;id:string;pid?:number;identity?:ProcessIdentity};
const readLock=(path:string)=>readPrivateJson<LockRecord>(path);

export async function acquireLock(root:string,options:{stateRoot?:string;recover?:boolean;resource?:string}={}):Promise<ProjectLock>{
 root=await realpath(root);
 const stateRoot=await privateDirectory(options.stateRoot??defaultStateRoot(),root);
 const path=join(stateRoot,signature(options.resource?{resource:options.resource}:root)+'.lock');
 const id=randomUUID(),record={root,id,pid:process.pid};
 const take=async()=>{
  const file=await open(path,'wx',0o600);
  try{
   try{await file.writeFile(JSON.stringify(record));await file.sync();}finally{await file.close();}
   await syncDirectory(stateRoot);
  }catch(error){
   await unlink(path).catch(()=>{});
   throw error;
  }
 };
 try{await take();}catch(error){
  if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
  if(!options.recover)throw Error('Project or resource locked: '+path);
  const recoveryPath=path+'.recovery';
  const guard=await open(recoveryPath,'wx',0o600).catch(error=>{
   if(error.code==='EEXIST')throw Error('Lock recovery in progress or interrupted: '+recoveryPath);
   throw error;
  });
  try{
   await guard.writeFile(JSON.stringify(record));
   const prior=await readLock(path);
   if(prior){
    const pid=prior.pid??prior.identity?.pid;
    if(!validPid(pid))throw Error('Invalid lock owner process ID: '+path);
    if(isAlive({pid}))throw Error('Project or resource locked: '+path);
    await unlink(path);
   }
   await take();
  }catch(error){
   if((error as NodeJS.ErrnoException).code==='EEXIST')throw Error('Project or resource locked: '+path);
   throw error;
  }finally{await guard.close();await unlink(recoveryPath);}
 }
 return {root,id,stateRoot,release:async()=>{
  const existing=await readLock(path);
  if(existing?.id!==id)throw Error('Lock owner changed: '+path);
  await unlink(path);
 }};
}
