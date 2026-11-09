import {spawn} from 'node:child_process';
import {Socket} from 'node:net';
import {win32} from 'node:path';
import {createInterface} from 'node:readline';
import {windowsPowerShellExecutable} from './windows-powershell.js';

interface Request {
 resolve:()=>void;
 reject:(error:Error)=>void;
 timeout:NodeJS.Timeout;
}

let worker:ReturnType<typeof startWorker>|undefined;

function startWorker(check:string){
 const command=[
  "$ErrorActionPreference = 'Stop'",
  '[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)',
  '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
  'function Test-RigupAcl([string]$path, [bool]$directory, [bool]$ancestorsOnly) {',
  check,
  '}',
  'while ($null -ne ($line = [Console]::ReadLine())) {',
  ' $request = ConvertFrom-Json -InputObject $line',
  ' try {',
  '  [void](Test-RigupAcl $request.path $request.directory $request.ancestorsOnly)',
  '  [Console]::WriteLine([string]$request.id + ":ok")',
  ' } catch {',
  '  [Console]::WriteLine([string]$request.id + ":denied")',
  ' }',
  '}',
 ].join('\n');
 const executable=windowsPowerShellExecutable();
 const child=spawn(executable,['-NoLogo','-NoProfile','-NonInteractive','-Command',command],{
  cwd:win32.dirname(executable),windowsHide:true,stdio:['pipe','pipe','ignore'],
 });
 // Pending request timers keep Node alive. Once the CLI exits, EOF stops
 // the worker even when the caller is interrupted.
 child.unref();
 const reusable=child.stdin instanceof Socket&&child.stdout instanceof Socket;
 if(child.stdin instanceof Socket)child.stdin.unref();
 if(child.stdout instanceof Socket)child.stdout.unref();
 const pending=new Map<number,Request>();
 let sequence=0;
 let idle:NodeJS.Timeout|undefined;

 function stop(error?:Error){
  if(worker===client)worker=undefined;
  clearTimeout(idle);
  for(const request of pending.values()){
   clearTimeout(request.timeout);
   request.reject(error??new Error('ACL check stopped'));
  }
  pending.clear();
  if(error)child.kill();
  else child.stdin.end();
 }

 const lines=createInterface({input:child.stdout,crlfDelay:Infinity});
 lines.on('line',line=>{
  const match=/^(\d+):(ok|denied)$/.exec(line);
  const id=Number(match?.[1]);
  const request=pending.get(id);
  if(!request||!match){stop(new Error('Invalid Windows ACL response'));return;}
  pending.delete(id);
  clearTimeout(request.timeout);
  if(match[2]==='ok')request.resolve();
  else request.reject(new Error('Windows ACL denied'));
  if(!reusable&&!pending.size)idle=setTimeout(()=>stop(),750);
 });
 child.on('error',stop);
 child.stdin.on('error',stop);
 child.on('exit',()=>stop(new Error('Windows ACL process exited')));

 const client={
  request(path:string,directory:boolean,ancestorsOnly:boolean):Promise<void>{
   clearTimeout(idle);
   const id=++sequence;
   return new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>stop(new Error('Windows ACL check timed out')),30_000);
    pending.set(id,{resolve,reject,timeout});
    child.stdin.write(JSON.stringify({id,path,directory,ancestorsOnly})+'\n');
   });
  },
 };
 return client;
}

// Every request re-reads the ACL. Reusing the process only avoids PowerShell startup.
export function checkWindowsAccess(check:string,path:string,directory:boolean,ancestorsOnly:boolean):Promise<void>{
 worker??=startWorker(check);
 return worker.request(path,directory,ancestorsOnly);
}
