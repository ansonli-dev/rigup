import {homedir} from 'node:os';
import {join} from 'node:path';
import {realpath,readFile,unlink,lstat,open} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {privateDirectory,signature} from '../generator/cache.js';
import {readPrivateJson} from '../private-record.js';
import {syncDirectory} from '../sync-directory.js';
import {runWindowsPowerShell} from '../windows-powershell.js';
const exec=promisify(execFile);
const windowsStartPattern=/^win32:[1-9]\d{17,18}$/;

export interface ProcessIdentity {pid:number;started:string}

function validPid(pid:unknown):pid is number {
 return typeof pid==='number'&&Number.isInteger(pid)&&pid>0&&pid<=0x7fffffff;
}

async function windowsProcessStart(pid:number):Promise<string>{
 const command=[
  "$ErrorActionPreference = 'Stop'",
  `$owner = [System.Diagnostics.Process]::GetProcessById(${pid})`,
  '[Console]::WriteLine($owner.StartTime.ToUniversalTime().Ticks.ToString([System.Globalization.CultureInfo]::InvariantCulture))',
 ].join('; ');
 const {stdout}=await runWindowsPowerShell(command,{timeout:10_000,maxBuffer:4096});
 const started='win32:'+stdout.trim();
 if(!windowsStartPattern.test(started))throw new Error('process identity unavailable');
 return started;
}

let currentWindowsStart:Promise<string>|undefined;
function windowsStart(pid:number):Promise<string>{
 if(pid!==process.pid)return windowsProcessStart(pid);
 return currentWindowsStart??=windowsProcessStart(pid).catch(error=>{
  currentWindowsStart=undefined;
  throw error;
 });
}

export async function processIdentity(pid:number):Promise<ProcessIdentity>{
 if(!validPid(pid))throw new Error('process identity unavailable');
 const started=process.platform==='win32'
  ?await windowsStart(pid)
  :(await exec('ps',['-p',String(pid),'-o','lstart='])).stdout.trim();
 if(!started)throw new Error('process identity unavailable');
 return {pid,started};
}

export async function isAlive(identity:ProcessIdentity):Promise<boolean>{
 if(!validPid(identity?.pid)||typeof identity.started!=='string'||!identity.started.trim()||
    (process.platform==='win32'&&!windowsStartPattern.test(identity.started)))throw new Error('process identity cannot be confirmed');
 try{process.kill(identity.pid,0);}catch(e){if((e as NodeJS.ErrnoException).code==='ESRCH')return false;throw new Error('process exit cannot be confirmed');}
 try{return (await processIdentity(identity.pid)).started===identity.started;}catch{throw new Error('process identity cannot be confirmed');}
}
export interface ProjectLock {root:string;id:string;stateRoot:string;release():Promise<void>}
export const defaultStateRoot=()=>join(homedir(),'.local','state','rigup');

async function readLock(path:string):Promise<{id:string;identity?:ProcessIdentity}|undefined>{
 if(process.platform==='win32')return readPrivateJson(path);
 return JSON.parse(await readFile(path,'utf8'));
}

export async function acquireLock(root:string,options:{stateRoot?:string;recover?:boolean;resource?:string}={}):Promise<ProjectLock>{
 root=await realpath(root);const stateRoot=await privateDirectory(options.stateRoot??defaultStateRoot(),root);const path=join(stateRoot,signature(options.resource?{resource:options.resource}:root)+'.lock');
 const identity=await processIdentity(process.pid);const id=randomUUID();
 const take=async()=>{const handle=await open(path,'wx',0o600);try{await handle.writeFile(JSON.stringify({root,id,identity}));await handle.sync();}finally{await handle.close();}await syncDirectory(stateRoot);};
 try{await take();}catch(e){
  if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;
  if(!options.recover)throw new Error('project locked/occupied; do not steal an active lock');
  const recoveryPath=path+'.recovery';
  const guard=await open(recoveryPath,'wx',0o600).catch(error=>{
   if(error.code==='EEXIST')throw new Error('project lock recovery in progress or interrupted; reconcile its controller before retry');
   throw error;
  });
  try{
   await guard.writeFile(JSON.stringify({root,id,identity}));
   if((await lstat(path)).isSymbolicLink())throw new Error('lock path symlink denied');
   const existing=await readLock(path);
   if(!existing?.identity||await isAlive(existing.identity))throw new Error('project locked/occupied; do not steal an active lock');
   // Read and replace under the recovery guard so another recovery cannot unlink a new lock.
   await unlink(path);await take();
  }finally{await guard.close();await unlink(recoveryPath);}
 }
 return {root,id,stateRoot,release:async()=>{const existing=await readLock(path);if(existing?.id!==id)throw new Error('lock identity changed');await unlink(path);}};
}
