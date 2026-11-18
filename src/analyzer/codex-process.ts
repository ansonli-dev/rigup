import {readFile,lstat,realpath,writeFile} from 'node:fs/promises';
import {statSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {StringDecoder} from 'node:string_decoder';
import {processIdentity,isAlive,type ProcessIdentity} from '../installer/lock.js';
import {startProcess} from '../integrations/tools/windows-process.mjs';
import {externalExecutable,npmPathDirectories,withinPath} from '../npm-command.mjs';
export type CodexProcessIdentity=ProcessIdentity;
type CodexProgram={executable:string;prefix:string[]};
export interface CodexInvocation {
 cwd:string;args:string[];prompt:string;output:string;program?:CodexProgram;signal?:AbortSignal;timeoutMs?:number;
 onStart(identity:CodexProcessIdentity):Promise<void>;
}
export interface CodexOutcome {code:number|null;stdout:string;lastMessage:string}
export class CodexTimeoutError extends Error {
 constructor(timeoutMs:number){super('Codex exceeded the '+timeoutMs+' ms response limit');}
}
export function codexTimeoutMs(value=process.env.RIGUP_CODEX_TIMEOUT_MS):number{
 if(!value)return 300_000;
 const timeout=Number(value);
 if(!/^[1-9]\d*$/.test(value)||!Number.isSafeInteger(timeout)||timeout>2_147_483_647)throw Error('RIGUP_CODEX_TIMEOUT_MS must be a positive millisecond integer up to 2147483647');
 return timeout;
}

export async function codexProcessActive(identity:CodexProcessIdentity):Promise<boolean>{
 return isAlive(identity);
}

export async function codexAvailable(root:string,cwd:string,signal?:AbortSignal):Promise<{program:CodexProgram;version:string}>{
 try {
  signal?.throwIfAborted();
  const program=await codexProgram(root),version=(await codexVersion(program,cwd,signal)).trim();
  if(!/^codex-cli \d+\.\d+\.\d+(?:[-+][0-9a-z.-]+)?$/i.test(version))throw Error('unusable version');
  return {program,version};
 }
 catch{signal?.throwIfAborted();throw Error('Local Codex is unavailable; install/sign in to Codex or explicitly select another backend');}
}

async function codexProgram(root:string):Promise<CodexProgram>{
 const path=await npmPathDirectories(root,process.env.PATH??process.env.Path??'');
 if(process.platform!=='win32'){
  const executable=await externalExecutable('codex',root,path);
  if(executable)return {executable,prefix:[]};
  throw Error('Codex executable unavailable');
 }
 const exists=(path:string)=>statSync(path,{throwIfNoEntry:false})?.isFile();
 for(const directory of path){
  const executable=await externalExecutable('codex.exe',root,[directory]);
  if(executable)return {executable,prefix:[]};
  if(await externalExecutable('codex.cmd',root,[directory])){
   const installed=await realpath(join(directory,'node_modules','@openai','codex'));
   if(withinPath(root,installed))throw Error('Unsafe Codex package location');
   const manifest=JSON.parse(readFileSync(join(installed,'package.json'),'utf8'));
   const entry=join(installed,'bin','codex.js');
   if(manifest.name==='@openai/codex'&&manifest.bin?.codex==='bin/codex.js'&&exists(entry)){
    const actual=await realpath(entry);
    if(!withinPath(installed,actual)||withinPath(root,actual))throw Error('Unsafe Codex package entry');
    return {executable:process.execPath,prefix:[actual]};
   }
   throw Error('Unsupported Windows Codex npm launcher');
  }
  if(exists(join(directory,'codex.bat'))||exists(join(directory,'codex.com')))throw Error('Unsupported Windows Codex launcher');
 }
 throw Error('Windows Codex executable unavailable');
}

async function codexVersion(program:CodexProgram,cwd:string,signal?:AbortSignal):Promise<string>{
 const child=startProcess({executable:program.executable,args:[...program.prefix,'--version'],cwd});
 let stdout='',overflow=false;
 child.stdout?.on('data',chunk=>{if(stdout.length+chunk.length>4096){overflow=true;child.stop();}else stdout+=chunk;});
 child.stderr?.resume();
 const timer=setTimeout(child.stop,10000);
 signal?.addEventListener('abort',child.stop,{once:true});
 try{
  if(signal?.aborted)child.stop();else child.start();
  const result=await child.completed;
  if(result.code!==0||result.unavailable||result.interrupted||overflow)throw Error('Codex version unavailable');
  return stdout;
 }finally{clearTimeout(timer);signal?.removeEventListener('abort',child.stop);child.stop();await child.completed;}
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
 const timeout=input.timeoutMs??codexTimeoutMs();
 await writeFile(input.output,'',{flag:'wx',mode:0o600});
 const program=input.program??await codexProgram(input.cwd);
 const launch={executable:program.executable,args:[...program.prefix,...input.args]};
 const child=startProcess({...launch,cwd:input.cwd,env:process.env},{defer:true});
 const decoder=new StringDecoder('utf8');
 let stdout='',bytes=0,overflow=false,timedOut=false;
 child.stdout?.on('data',chunk=>{
  bytes+=chunk.length;
  if(bytes>4_000_000){overflow=true;child.stop();}else stdout+=decoder.write(chunk);
 });
 child.stderr?.resume();
 const timer=setTimeout(()=>{timedOut=true;child.stop();},timeout);
 input.signal?.addEventListener('abort',child.stop,{once:true});
 try{
  if(!child.pid)throw Error('Codex process unavailable');
  await input.onStart(processIdentity(child.pid));
  if(input.signal?.aborted||timedOut)child.stop();else child.start(input.prompt);
  const outcome=await child.completed;
  if(timedOut)throw new CodexTimeoutError(timeout);
  if(input.signal?.aborted)throw Error('Codex cancelled');
  if(overflow)throw Error('Codex response exceeded its limit');
  if(outcome.unavailable||outcome.interrupted)throw Error('Codex process outcome unavailable');
  return {code:outcome.code,stdout:stdout+decoder.end(),lastMessage:await readCodexOutput(input.output)};
 }finally{
  clearTimeout(timer);input.signal?.removeEventListener('abort',child.stop);
  child.stop();await child.completed;
 }
}
