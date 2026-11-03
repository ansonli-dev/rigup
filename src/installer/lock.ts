import {homedir} from 'node:os';
import {join} from 'node:path';
import {realpath,writeFile,readFile,unlink,lstat,open} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {privateDirectory,signature} from '../generator/cache.js';
const exec=promisify(execFile);
export interface ProcessIdentity {pid:number;started:string}
export async function processIdentity(pid:number):Promise<ProcessIdentity>{const started=(await exec('ps',['-p',String(pid),'-o','lstart='])).stdout.trim();if(!started)throw new Error('process identity unavailable');return {pid,started};}
export async function isAlive(identity:ProcessIdentity):Promise<boolean>{try{process.kill(identity.pid,0);}catch(e){if((e as NodeJS.ErrnoException).code==='ESRCH')return false;throw new Error('process exit cannot be confirmed');}try{return (await processIdentity(identity.pid)).started===identity.started;}catch{throw new Error('process identity cannot be confirmed');}}
export interface ProjectLock {root:string;id:string;stateRoot:string;release():Promise<void>}
export const defaultStateRoot=()=>join(homedir(),'.local','state','rigup');
export async function acquireLock(root:string,options:{stateRoot?:string;recover?:boolean}={}):Promise<ProjectLock>{
 root=await realpath(root);const stateRoot=await privateDirectory(options.stateRoot??defaultStateRoot(),root);const path=join(stateRoot,signature(root)+'.lock');
 const identity=await processIdentity(process.pid);const id=randomUUID();
 const take=async()=>{const handle=await open(path,'wx',0o600);try{await handle.writeFile(JSON.stringify({root,id,identity}));await handle.sync();}finally{await handle.close();}const directory=await open(stateRoot,'r');try{await directory.sync();}finally{await directory.close();}};
 try{await take();}catch(e){
  if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;
  if((await lstat(path)).isSymbolicLink())throw new Error('lock path symlink denied');
  const existing=JSON.parse(await readFile(path,'utf8'));
  if(!options.recover||!existing.identity||await isAlive(existing.identity))throw new Error('project locked/occupied; do not steal an active lock');
  // Explicit recovery only after the old controller is proven dead. Pending writers are checked separately before dispatch.
  await unlink(path);await take();
 }
 return {root,id,stateRoot,release:async()=>{const existing=JSON.parse(await readFile(path,'utf8'));if(existing.id!==id)throw new Error('lock identity changed');await unlink(path);}};
}
