import {spawn} from 'node:child_process';
import {randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {once} from 'node:events';
import {readFileSync,statSync} from 'node:fs';
import {createServer,type Socket} from 'node:net';
import {delimiter,join,resolve} from 'node:path';
import {PassThrough,type Readable,type Writable} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {startWindowsProcess,resolveWindowsExecutable} from '../src/integrations/tools/windows-process.mjs';

export class LiveProcessCleanupError extends Error {}

interface Options {cwd?:string;env?:NodeJS.ProcessEnv}
interface LiveProcess {
 stdout:Readable;
 stderr:Readable;
 completed:Promise<number|null>;
 stop(signal?:NodeJS.Signals):Promise<void>;
}
export type LiveSession=LiveProcess&{stdin:Writable};

async function bounded<T>(work:Promise<T>,ms:number,message:string):Promise<T>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  return await Promise.race([work,new Promise<never>((_,reject)=>{
   timer=setTimeout(()=>reject(new LiveProcessCleanupError(message)),ms);
  })]);
 }finally{clearTimeout(timer);}
}

function signalGroup(pid:number,signal:NodeJS.Signals|0):boolean{
 try{process.kill(-pid,signal);return true;}
 catch(error){
  const {code}=error as NodeJS.ErrnoException;
  if(code==='ESRCH')return false;
  // A group can return EPERM while its last processes are being reaped.
  if(signal===0&&code==='EPERM')return true;
  throw new LiveProcessCleanupError('Could not verify or stop the live probe process group',{cause:error});
 }
}

async function groupExited(pid:number,ms:number):Promise<boolean>{
 const deadline=performance.now()+ms;
 while(signalGroup(pid,0)){
  if(performance.now()>=deadline)return false;
  await delay(25);
 }
 return true;
}

function startPosixSession(executable:string,args:string[],options:Options):LiveSession{
 const child=spawn(executable,args,{...options,detached:true,stdio:['pipe','pipe','pipe']});
 const {stdin,stdout,stderr}=child;
 stdin.on('error',()=>{}); // The command may close stdin while we are writing to it.
 const closed=new Promise<void>(done=>child.once('close',()=>done()));
 const exited=new Promise<{code:number|null;error?:Error}>(done=>{
  child.once('exit',code=>done({code}));
  child.once('error',error=>done({code:null,error}));
 });
 const releasePipes=()=>{stdin.destroy();stdout.destroy();stderr.destroy();child.unref();};
 let stopping:Promise<void>|undefined;
 let treeExited=false;
 const stopTree=(signal:NodeJS.Signals)=>stopping??=(async()=>{
  const pid=child.pid;
  if(!pid||treeExited||!signalGroup(pid,signal))return;
  if(signal!=='SIGKILL'){
   if(await groupExited(pid,3000)||!signalGroup(pid,'SIGKILL'))return;
  }
  if(!await groupExited(pid,5000))throw new LiveProcessCleanupError('Live probe process group did not exit');
 })();
 const completed=exited.then(async({code,error})=>{
  try{
   let leftChildren=false;
   if(!stopping&&child.pid){
    treeExited=await groupExited(child.pid,500);
    if(!treeExited&&!stopping){leftChildren=true;await stopTree('SIGKILL');}
   }
   await stopping;
   treeExited=true;
   await bounded(closed,2000,'Live probe output stayed open after its process group exited');
   if(leftChildren)throw new LiveProcessCleanupError('Live probe exited while descendants were still running. Its process group was stopped.');
   if(error)throw error;
   return code;
  }finally{releasePipes();}
 });
 void completed.catch(()=>{});
 return {stdin,stdout,stderr,completed,async stop(signal='SIGTERM'){
  try{
   await stopTree(signal);
   await bounded(completed,3000,'Live probe did not report its exit after shutdown');
  }finally{releasePipes();}
 }};
}

function windowsCommand(executable:string,args:string[],cwd:string,env:NodeJS.ProcessEnv){
 if(executable!=='codex')return {executable:resolveWindowsExecutable(executable,cwd,env),args};
 const pathKey=Object.keys(env).sort().find(key=>key.toLowerCase()==='path'&&env[key]!==undefined);
 const entries=(pathKey?env[pathKey]??'':'').split(delimiter).filter(Boolean);
 const file=(path:string)=>statSync(path,{throwIfNoEntry:false})?.isFile();
 for(const entry of entries){
  const bin=resolve(cwd,entry.replace(/^"|"$/g,'')),native=join(bin,'codex.exe');
  if(file(native))return {executable:native,args};
  if(!file(join(bin,'codex.cmd')))continue;
  const pkg=join(bin,'node_modules','@openai','codex'),script=join(pkg,'bin','codex.js');
  const manifest=JSON.parse(readFileSync(join(pkg,'package.json'),'utf8'));
  if(manifest.name==='@openai/codex'&&manifest.bin?.codex==='bin/codex.js'&&file(script)){
   return {executable:process.execPath,args:[script,...args]};
  }
  throw Error('Unsupported Windows Codex npm launcher');
 }
 throw Error('Windows Codex executable unavailable');
}

function startWindowsCommand(executable:string,args:string[],{cwd=process.cwd(),env=process.env}:Options,input:string):LiveProcess{
 const child=startWindowsProcess({executable,args,cwd,env});
 const stdout=child.stdout!,stderr=child.stderr!;
 const completed=child.completed.then(({code,unavailable,remaining,interrupted})=>{
  if(remaining)throw new LiveProcessCleanupError('Windows live probe reported lingering descendants or could not confirm process-tree exit');
  if(unavailable)throw Error('Windows live probe process unavailable');
  return interrupted?null:code;
 });
 void completed.catch(()=>{});
 child.start(input);
 return {stdout,stderr,completed,async stop(){
  child.stop();
  try{await bounded(completed,10_000,'Windows live probe did not confirm process-tree exit');}
  finally{stdout.destroy();stderr.destroy();}
 }};
}

export function startLiveCommand(executable:string,args:string[],options:Options={},input=''):LiveProcess{
 if(process.platform==='win32'){
  const {cwd=process.cwd(),env=process.env}=options;
  const command=windowsCommand(executable,args,cwd,env);
  return startWindowsCommand(command.executable,command.args,{cwd,env},input);
 }
 const child=startPosixSession(executable,args,options);
 child.stdin.end(input);
 return child;
}

export async function startLiveSession(executable:string,args:string[],options:Options={}):Promise<LiveSession>{
 if(process.platform!=='win32')return startPosixSession(executable,args,options);
 const {cwd=process.cwd(),env=process.env}=options;
 const command=windowsCommand(executable,args,cwd,env);
 const pipe='\\\\.\\pipe\\rigup-live-'+randomUUID(),token=randomBytes(32).toString('hex');
 const expected=Buffer.from(token);
 const stdin=new PassThrough();
 const sockets=new Set<Socket>();
 let connected=false;
 const server=createServer(socket=>{
  if(connected){socket.destroy();return;}
  sockets.add(socket);
  socket.on('error',()=>socket.destroy());
  socket.once('close',()=>sockets.delete(socket));
  socket.setTimeout(5000,()=>socket.destroy());
  let received=Buffer.alloc(0);
  const authenticate=(chunk:Buffer)=>{
   if(connected||received.length+chunk.length>expected.length){socket.destroy();return;}
   received=Buffer.concat([received,chunk]);
   if(received.length<expected.length)return;
   if(!timingSafeEqual(received,expected)){socket.destroy();return;}
   connected=true;
   socket.off('data',authenticate);
   socket.setTimeout(0);
   server.close();
   stdin.pipe(socket);
  };
  socket.on('data',authenticate);
 });
 const cleanup=()=>{
  server.close();
  stdin.destroy();
  for(const socket of sockets)socket.destroy();
 };
 try{
  await once(server.listen(pipe),'listening');
  const relay=fileURLToPath(new URL('./live-stdin-relay.mjs',import.meta.url));
  const child=startWindowsCommand(process.execPath,[relay,command.executable,...command.args],{cwd,env},JSON.stringify({pipe,token}));
  void child.completed.then(cleanup,cleanup);
  return {...child,stdin,async stop(){try{await child.stop();}finally{cleanup();}}};
 }catch(error){cleanup();throw error;}
}

interface RunOptions extends Options {input?:string;timeoutMs:number;killSignal?:NodeJS.Signals;maxBuffer?:number;onStdout?:(chunk:string)=>void}

export async function runLiveCommand(executable:string,args:string[],{input,timeoutMs,killSignal='SIGKILL',maxBuffer=Infinity,onStdout,...options}:RunOptions){
 const child=startLiveCommand(executable,args,options,input);
 let stdout='',stderr='',stdoutBytes=0,stderrBytes=0;
 let timedOut=false,overflow=false,stop:Promise<void>|undefined;
 let observationFailed=false,observationError:unknown;
 let timer:ReturnType<typeof setTimeout>|undefined;
 let interrupt:()=>void;
 const interrupted=new Promise<null>((done,reject)=>{
  interrupt=()=>{
   if(stop)return;
   stop=child.stop(killSignal);
   void stop.then(()=>done(null),reject);
  };
  timer=setTimeout(()=>{timedOut=true;interrupt();},timeoutMs);
 });
 child.stdout.setEncoding('utf8').on('data',(chunk:string)=>{
  stdoutBytes+=Buffer.byteLength(chunk);
  if(stdoutBytes<=maxBuffer){
   stdout+=chunk;
   if(!observationFailed)try{onStdout?.(chunk);}catch(error){observationFailed=true;observationError=error;interrupt();}
  }else{overflow=true;interrupt();}
 });
 child.stderr.setEncoding('utf8').on('data',(chunk:string)=>{
  stderrBytes+=Buffer.byteLength(chunk);
  if(stderrBytes<=maxBuffer)stderr+=chunk;else{overflow=true;interrupt();}
 });
 try{
  const code=await Promise.race([child.completed,interrupted]);
  if(stop)await stop;
  if(observationFailed)throw observationError;
  if(overflow)throw Error('Live probe output exceeded its limit');
  return {code:timedOut?null:code,stdout,stderr,timedOut};
 }finally{clearTimeout(timer);}
}

export async function checkedLiveCommand(executable:string,args:string[],options:RunOptions){
 const result=await runLiveCommand(executable,args,options);
 if(result.timedOut)throw Error(executable+' timed out during the live probe');
 if(result.code!==0)throw Error(executable+' failed during the live probe (exit '+result.code+')');
 return result;
}

export async function liveVersion(executable:string){
 return (await checkedLiveCommand(executable,['--version'],{timeoutMs:15_000,maxBuffer:4096})).stdout.trim();
}
