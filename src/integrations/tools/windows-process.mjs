import {execFile,spawn} from 'node:child_process';
import {statSync} from 'node:fs';
import {win32 as path} from 'node:path';
import {fileURLToPath} from 'node:url';
import {windowsSystemCommand,windowsSystemPowerShell} from '../../windows-system-env.mjs';

const windows=process.platform==='win32';
const batch=/\.(?:cmd|bat)$/i;
export const windowsPowerShellExecutable=windowsSystemPowerShell;

function windowsProgram(command,cwd,env,extensions){
 const suffix=path.extname(command).toLowerCase();
 const names=suffix?[command]:extensions.map(extension=>command+extension);
 if(suffix&&!extensions.includes(suffix))throw Error('Unsupported Windows command extension');
 const pathKey=Object.keys(env).sort().find(key=>key.toUpperCase()==='PATH'&&env[key]!==undefined);
 const explicit=path.isAbsolute(command)||/[\\/]/.test(command);
 const directories=explicit?[cwd]:(pathKey?env[pathKey]:'').split(';').filter(Boolean).map(dir=>path.resolve(cwd,dir.replace(/^"|"$/g,'')));
 for(const dir of directories)for(const name of names){
  const candidate=path.resolve(dir,name);
  if(statSync(candidate,{throwIfNoEntry:false})?.isFile())return candidate;
 }
 throw Error('Windows executable unavailable in the selected environment');
}

export function resolveWindowsExecutable(command,cwd,env){
 return windowsProgram(command,cwd,env,['.exe']);
}

function spawnArguments(executable,args,cwd,env){
 if(!windows)return {executable,args,env};
 executable=windowsProgram(executable,cwd,env,['.exe','.cmd','.bat']);
 if(!batch.test(executable))return {executable,args,env};
 const argv=[executable,...args];
 if(argv.some(value=>/["\x00-\x1f]/.test(value)))throw Error('Unsupported argument for Windows batch launcher');
 const line=argv.map(value=>'"'+value.replace(/\\+$/,slashes=>slashes+slashes)+'"').join(' ');
 if(line.length>8000)throw Error('Windows batch command line is too long');
 // Expand once so literal percent signs survive. Delayed expansion stays disabled.
 return {executable:windowsSystemCommand(),args:['/d','/v:off','/s','/c','"%RIGUP_BATCH_COMMAND%"'],
  env:{...env,RIGUP_BATCH_COMMAND:line},windowsVerbatimArguments:true};
}

/** @param {{executable:string,args:string[],cwd:string,env?:NodeJS.ProcessEnv}} spec */
export function spawnCommand({executable,args,cwd,env=process.env},options={}){
 const command=spawnArguments(executable,args,cwd,env);
 return spawn(command.executable,command.args,{cwd,env:command.env,windowsHide:true,
  windowsVerbatimArguments:command.windowsVerbatimArguments,...options});
}

function terminate(child){
 if(!child.pid)return Promise.resolve();
 if(windows){
  const taskkill=path.join(path.dirname(windowsSystemCommand()),'taskkill.exe');
  return new Promise(resolve=>{
   execFile(taskkill,['/T','/F','/PID',String(child.pid)],{windowsHide:true,timeout:5000},error=>{
    if(error&&child.exitCode===null&&child.signalCode===null)child.kill();
    resolve(undefined);
   });
  });
 }
 const signal=value=>{try{process.kill(-child.pid,value);}catch{}};
 signal('SIGTERM');
 return new Promise(resolve=>setTimeout(()=>{signal('SIGKILL');resolve(undefined);},250));
}

const worker=fileURLToPath(new URL('./process-worker.mjs',import.meta.url));
/** @param {{executable:string,args:string[],cwd:string,env?:NodeJS.ProcessEnv,captureOutput?:boolean,supervisorEnv?:NodeJS.ProcessEnv,supervisorCwd?:string}} spec */
export function startProcess(spec,{defer=false}={}){
 const capture=spec.captureOutput??true;
 const stdio=['pipe',capture?'pipe':'ignore',capture?'pipe':'ignore'];
 const child=defer?spawn(process.execPath,[worker],{
  cwd:spec.supervisorCwd??spec.cwd,
  env:Object.fromEntries(Object.entries(spec.supervisorEnv??process.env).filter(([key])=>!/^NODE_(?:OPTIONS|PATH)$/i.test(key))),
  // The writer must remain alive if the controller exits after dispatch.
  detached:true,windowsHide:true,stdio,
 }):spawnCommand(spec,{detached:!windows,stdio});
 let stopped=false,started=false,settled=false,unavailable=false;
 let stopPromise;
 let drain;
 /** @type {Promise<{code:number|null,unavailable:boolean,interrupted:boolean}>} */
 const completed=new Promise(resolve=>{
  const finish=async(code)=>{
   if(settled)return;
   settled=true;
   clearTimeout(drain);
   await stopPromise;
   resolve({code,unavailable,interrupted:stopped});
  };
  child.once('error',()=>{unavailable=true;void finish(null);});
  child.once('close',code=>void finish(code));
  // A descendant may inherit output descriptors after the direct process exits.
  child.once('exit',code=>{drain=setTimeout(()=>{
   child.stdout?.destroy();child.stderr?.destroy();
   void finish(code);
  },40);});
 });
 const stop=()=>{
  if(stopped||settled||child.exitCode!==null||child.signalCode!==null)return;
  stopped=true;
  if(defer&&!started)child.stdin?.end();
  else stopPromise=terminate(child);
  return true;
 };
 child.stdin?.on('error',()=>{});
 return {pid:child.pid,stdout:child.stdout,stderr:child.stderr,completed,stop,start(input=''){
  if(started||stopped||settled)throw Error('Command authorization is no longer available');
  started=true;
  child.stdin?.end(defer?JSON.stringify({spec,input}):input);
 }};
}

/** @param {Parameters<typeof startProcess>[0]} spec */
export const startWindowsProcess=spec=>startProcess(spec,{defer:true});
