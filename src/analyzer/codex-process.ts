import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,lstat,writeFile} from 'node:fs/promises';
import {processIdentity,isAlive,type ProcessIdentity} from '../installer/lock.js';
const exec=promisify(execFile);
export interface CodexInvocation {cwd:string;args:string[];prompt:string;output:string;signal?:AbortSignal;onStart(identity:ProcessIdentity):Promise<void>}
export interface CodexOutcome {code:number|null;stdout:string;lastMessage:string}
export async function codexAvailable():Promise<string>{
 try {const result=await exec('codex',['--version'],{timeout:10000,maxBuffer:4096});if(result.stdout.trim()!=='codex-cli 0.166.0')throw Error('unsupported version');return result.stdout.trim();}
 catch{throw Error('Local Codex 0.166.0 is unavailable; install/sign in to Codex or explicitly select another backend');}
}
export function codexArguments(cwd:string,output:string):string[]{
 const disabled=['shell_tool','unified_exec','view_image','browser_use','browser_use_external','computer_use','apps','remote_plugin','multi_agent','multi_agent_v2','skill_mcp_dependency_install','skill_search'];
 return ['exec','--ignore-user-config','--ephemeral','--skip-git-repo-check','--sandbox','read-only','--enable','skip_host_skill_discovery',...disabled.flatMap(name=>['--disable',name]),'--config','suppress_unstable_features_warning=true','--config','web_search="disabled"','--json','--output-last-message',output,'-C',cwd,'-'];
}
export async function invokeCodex(input:CodexInvocation):Promise<CodexOutcome>{
 if(input.signal?.aborted)throw Error('Codex cancelled before dispatch');
 await writeFile(input.output,'',{flag:'wx',mode:0o600});
 const child=spawn('codex',input.args,{cwd:input.cwd,env:process.env,detached:true,stdio:['pipe','pipe','pipe']});
 let stdout='',overflow=false,finished=false,timedOut=false;const ended=new Promise<number|null>(done=>{child.once('error',()=>{finished=true;done(1);});child.once('exit',code=>{finished=true;done(code);});});
 const stop=()=>{if(child.pid)try{process.kill(-child.pid,'SIGTERM');}catch{}};
 let force:ReturnType<typeof setTimeout>|undefined;
 const cancel=()=>{stop();force??=setTimeout(()=>{if(child.pid)try{process.kill(-child.pid,'SIGKILL');}catch{}},3000);};
 child.stdout.on('data',chunk=>{if(stdout.length+chunk.length>4_000_000){overflow=true;cancel();}else stdout+=chunk;});
 child.stderr.resume(); // Raw provider/agent output never enters user-facing errors.
 const timeout=setTimeout(()=>{timedOut=true;cancel();},180000);input.signal?.addEventListener('abort',cancel,{once:true});
 try{
  if(!child.pid)throw Error('Codex process unavailable');
  const identity=await processIdentity(child.pid);
  try{await input.onStart(identity);}catch(error){child.stdin.end();cancel();await ended;throw error;}
  if(input.signal?.aborted)cancel();else child.stdin.end(input.prompt);
  const code=await ended;
  if(await isAlive(identity))throw Error('Codex process exit unconfirmed');
  if(input.signal?.aborted||overflow||timedOut)throw Error('Codex cancelled or response exceeded its limit');
  const stat=await lstat(input.output);if(stat.isSymbolicLink()||!stat.isFile()||stat.size>2_000_000)throw Error('Invalid Codex output file');
  return {code,stdout,lastMessage:await readFile(input.output,'utf8')};
 }finally{child.stdin.end();if(!finished){cancel();await ended;}clearTimeout(timeout);if(force)clearTimeout(force);input.signal?.removeEventListener('abort',cancel);}
}
