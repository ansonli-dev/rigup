import {spawn} from 'node:child_process';
import {Socket} from 'node:net';
import {win32} from 'node:path';
import {createInterface} from 'node:readline';
import {setTimeout as delay} from 'node:timers/promises';
import {windowsPowerShellExecutable} from './windows-powershell.js';

const denialReasons:Record<string,string>={
 'unexpected-type':'unexpected file type or reparse point',
 'untrusted-owner':'untrusted owner',
 'missing-dacl':'missing DACL',
 'unsupported-rule':'unsupported access rule',
 'untrusted-grant':'untrusted access grant',
 'missing-user-access':'missing user access',
 'missing-inherited-access':'missing inheritable user access',
};
const sid=/^S-1-(?:\d{1,15}|0x[0-9a-f]{12})(?:-\d{1,10}){0,15}$/i;

type Result={status:'ok'|'io-error'|'busy'}|
 {status:'denied';reason:string;path:string;principal?:string;account?:string};

interface Request {
 path:string;
 ancestorsOnly:boolean;
 resolve:(result:Result)=>void;
 reject:(error:Error)=>void;
 timeout:NodeJS.Timeout;
}

export class WindowsAclCheckError extends Error {}

let worker:ReturnType<typeof startWorker>|undefined;

function parseResponse(line:string):{id:number;result:Result}|undefined{
 // A Windows path has at most 32,767 UTF-16 units, each possibly JSON escaped.
 if(line.length>200_000)return;
 let response;
 try{response=JSON.parse(line);}catch{return;}
 if(!Number.isSafeInteger(response?.id))return;
 const {id,status}=response;
 if(status==='ok'||status==='io-error'||status==='busy')return {id,result:{status}};
 const {reason,path,principal,account}=response;
 if(status!=='denied'||typeof reason!=='string'||!Object.hasOwn(denialReasons,reason)||typeof path!=='string'||
  (principal!==undefined&&principal!==''&&(typeof principal!=='string'||!sid.test(principal))))return;
 return {id,result:{status,reason:denialReasons[reason],path,principal:principal||undefined,account:typeof account==='string'&&account.length<=256?account:undefined}};
}

function checkedPath({path,ancestorsOnly}:Request,reported:string):string|undefined{
 const reportedLower=reported.toLowerCase();
 let candidate=ancestorsOnly?win32.dirname(path):path;
 if(ancestorsOnly&&candidate===path)return;
 while(true){
  if(candidate.toLowerCase()===reportedLower)return candidate;
  const parent=win32.dirname(candidate);
  if(parent===candidate)return;
  candidate=parent;
 }
}

function describePath(path:string):string{
 const bounded=path.length>1024?`${path.slice(0,512)}…${path.slice(-512)}`:path;
 return '"'+bounded.replace(/["\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g,
  char=>'\\u'+char.charCodeAt(0).toString(16).padStart(4,'0'))+'"';
}

function startWorker(check:string){
 const command=[
  "$ErrorActionPreference = 'Stop'",
  '[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)',
  '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
  'function Test-RigupAcl([string]$path, [bool]$directory, [bool]$ancestorsOnly, [bool]$create) {',
  check,
  '}',
  'while ($null -ne ($line = [Console]::ReadLine())) {',
  ' $request = ConvertFrom-Json -InputObject $line',
  ' try {',
  '  $response = Test-RigupAcl $request.path $request.directory $request.ancestorsOnly $request.create',
  "  if ($null -eq $response) { $response = @{status = 'ok'} }",
  ' } catch {',
  "  $status = 'io-error'",
  '  for ($cause = $_.Exception; $null -ne $cause; $cause = $cause.InnerException) {',
  '   # HRESULT_FROM_WIN32(ERROR_SHARING_VIOLATION / ERROR_LOCK_VIOLATION).',
  '   if ($cause.HResult -in @(-2147024864, -2147024863) -or',
  '       ($cause -is [ComponentModel.Win32Exception] -and $cause.NativeErrorCode -in @(32, 33))) {',
  "    $status = 'busy'",
  '    break',
  '   }',
  '  }',
  '  $response = @{status = $status}',
  ' }',
  ' $response["id"] = $request.id',
  ' [Console]::WriteLine((ConvertTo-Json -InputObject $response -Compress))',
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
 let stopped=false;

 function stop(error?:Error){
  if(stopped)return;
  stopped=true;
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
  if(stopped)return;
  const response=parseResponse(line);
  const request=response&&pending.get(response.id);
  if(!request||!response){stop(new Error('Invalid Windows ACL response'));return;}
  const {id,result}=response;
  if(result.status==='denied'){
   const path=checkedPath(request,result.path);
   if(!path){stop(new Error('Invalid Windows ACL denial path'));return;}
   result.path=path;
  }
  pending.delete(id);
  clearTimeout(request.timeout);
  request.resolve(result);
  if(!reusable&&!pending.size)idle=setTimeout(()=>stop(),750);
 });
 child.on('error',stop);
 child.stdin.on('error',stop);
 child.stdout.on('error',stop);
 child.on('exit',()=>stop(new Error('Windows ACL process exited')));

 const client={
  request(path:string,directory:boolean,ancestorsOnly:boolean,create:boolean,timeoutMs:number):Promise<Result>{
   clearTimeout(idle);
   const id=++sequence;
   return new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>stop(new Error('Windows ACL check timed out')),timeoutMs);
    pending.set(id,{path,ancestorsOnly,resolve,reject,timeout});
    child.stdin.write(JSON.stringify({id,path,directory,ancestorsOnly,create})+'\n');
   });
  },
 };
 return client;
}

// Every request re-reads the ACL. Reusing the process only avoids PowerShell startup.
export async function checkWindowsAccess(check:string,path:string,directory:boolean,ancestorsOnly:boolean,create:boolean):Promise<void>{
 const deadline=performance.now()+30_000;
 for(const wait of [0,25,50,100]){
  if(performance.now()+wait>=deadline)break;
  if(wait)await delay(wait);
  const remaining=Math.ceil(deadline-performance.now());
  if(remaining<=0)break;
  let result:Result;
  try{
   worker??=startWorker(check);
   result=await worker.request(path,directory,ancestorsOnly,create,remaining);
  }catch(cause){
   throw new WindowsAclCheckError(`Windows ACL worker unavailable checking ${describePath(path)}`,{cause});
  }
  if(result.status==='ok')return;
  if(result.status==='io-error')throw new WindowsAclCheckError(`Windows ACL I/O failed checking ${describePath(path)}`);
  if(result.status==='denied'){
   const principal=result.principal
    ? ` for ${result.account?describePath(result.account)+' ('+result.principal+')':result.principal}`
    : '';
   throw new WindowsAclCheckError(`Windows ACL denied ${result.reason}${principal} at ${describePath(result.path)}`);
  }
 }
 throw new WindowsAclCheckError(`Windows ACL I/O failed (sharing or lock violation) checking ${describePath(path)}`);
}
