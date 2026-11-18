import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,lstat,writeFile} from 'node:fs/promises';
import {statSync,readFileSync} from 'node:fs';
import {delimiter,join,resolve} from 'node:path';
import {StringDecoder} from 'node:string_decoder';
import {processIdentity,isAlive,type ProcessIdentity} from '../installer/lock.js';
import {startProcess,startWindowsProcess} from '../integrations/tools/windows-process.mjs';
const exec=promisify(execFile);
export type CodexProcessIdentity=ProcessIdentity;
export interface CodexInvocation {cwd:string;args:string[];prompt:string;output:string;signal?:AbortSignal;onStart(identity:CodexProcessIdentity):Promise<void>}
export interface CodexOutcome {code:number|null;stdout:string;lastMessage:string}
const attemptTimeoutMs=300_000;
export class CodexTimeoutError extends Error {
 constructor(){super('Codex exceeded the '+attemptTimeoutMs/1000+' second response limit');}
}

export async function codexProcessActive(identity:CodexProcessIdentity):Promise<boolean>{
 return isAlive(identity);
}

export async function codexAvailable():Promise<string>{
 try {
  const stdout=process.platform==='win32'?await windowsCodexVersion():(await exec('codex',['--version'],{timeout:10000,maxBuffer:4096})).stdout;
  if(stdout.trim()!=='codex-cli 0.166.0')throw Error('unsupported version');return stdout.trim();
 }
 catch{throw Error('Local Codex 0.166.0 is unavailable; install/sign in to Codex or explicitly select another backend');}
}

function windowsCodexCommand(cwd:string,args:string[]):{executable:string;args:string[]}{
 const exists=(path:string)=>statSync(path,{throwIfNoEntry:false})?.isFile();
 for(const part of (process.env.PATH??'').split(delimiter).filter(Boolean)){
  const directory=resolve(cwd,part.replace(/^"|"$/g,''));
  const executable=join(directory,'codex.exe');
  if(exists(executable))return {executable,args};
  if(exists(join(directory,'codex.cmd'))){
   const installed=join(directory,'node_modules','@openai','codex');
   const manifest=JSON.parse(readFileSync(join(installed,'package.json'),'utf8'));
   const entry=join(installed,'bin','codex.js');
   if(manifest.name==='@openai/codex'&&manifest.version==='0.166.0'&&manifest.bin?.codex==='bin/codex.js'&&exists(entry)){
    return {executable:process.execPath,args:[entry,...args]};
   }
   throw Error('Unsupported Windows Codex npm launcher');
  }
  if(exists(join(directory,'codex.bat'))||exists(join(directory,'codex.com')))throw Error('Unsupported Windows Codex launcher');
 }
 throw Error('Windows Codex executable unavailable');
}

async function windowsCodexVersion():Promise<string>{
 const cwd=process.cwd(),child=startWindowsProcess({...windowsCodexCommand(cwd,['--version']),cwd});
 let stdout='',overflow=false;
 child.stdout?.on('data',chunk=>{if(stdout.length+chunk.length>4096){overflow=true;child.stop();}else stdout+=chunk;});
 child.stderr?.resume();
 const timer=setTimeout(child.stop,10000);
 try{
  child.start();
  const result=await child.completed;
  if(result.code!==0||result.unavailable||result.interrupted||overflow)throw Error('Windows Codex version unavailable');
  return stdout;
 }finally{clearTimeout(timer);child.stop();await child.completed;}
}

export function codexArguments(cwd:string,output:string):string[]{
 const disabled=['shell_tool','unified_exec','view_image','browser_use','browser_use_external','computer_use','apps','remote_plugin','multi_agent','multi_agent_v2','skill_mcp_dependency_install','skill_search'];
 return ['exec','--ignore-user-config','--ephemeral','--skip-git-repo-check','--sandbox','read-only','--enable','skip_host_skill_discovery',...disabled.flatMap(name=>['--disable',name]),'--config','suppress_unstable_features_warning=true','--config','web_search="disabled"','--json','--output-last-message',output,'-C',cwd,'-'];
}
async function readCodexOutput(output:string):Promise<string>{
 const stat=await lstat(output);if(stat.isSymbolicLink()||!stat.isFile()||stat.size>2_000_000)throw Error('Invalid Codex output file');
 return readFile(output,'utf8');
}

export async function invokeCodex(input:CodexInvocation):Promise<CodexOutcome>{
 if(input.signal?.aborted)throw Error('Codex cancelled before dispatch');
 await writeFile(input.output,'',{flag:'wx',mode:0o600});
 const launch=process.platform==='win32'?windowsCodexCommand(input.cwd,input.args):{executable:'codex',args:input.args};
 const child=startProcess({...launch,cwd:input.cwd,env:process.env},{defer:true});
 const decoder=new StringDecoder('utf8');
 let stdout='',bytes=0,overflow=false,timedOut=false;
 child.stdout?.on('data',chunk=>{
  bytes+=chunk.length;
  if(bytes>4_000_000){overflow=true;child.stop();}else stdout+=decoder.write(chunk);
 });
 child.stderr?.resume();
 const timer=setTimeout(()=>{timedOut=true;child.stop();},attemptTimeoutMs);
 input.signal?.addEventListener('abort',child.stop,{once:true});
 try{
  if(!child.pid)throw Error('Codex process unavailable');
  await input.onStart(processIdentity(child.pid));
  if(input.signal?.aborted||timedOut)child.stop();else child.start(input.prompt);
  const outcome=await child.completed;
  if(timedOut)throw new CodexTimeoutError();
  if(input.signal?.aborted||overflow)throw Error('Codex cancelled or response exceeded its limit');
  if(outcome.unavailable||outcome.interrupted)throw Error('Codex process outcome unavailable');
  return {code:outcome.code,stdout:stdout+decoder.end(),lastMessage:await readCodexOutput(input.output)};
 }finally{
  clearTimeout(timer);input.signal?.removeEventListener('abort',child.stop);
  child.stop();await child.completed;
 }
}
