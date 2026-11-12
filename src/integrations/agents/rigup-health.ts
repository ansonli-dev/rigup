import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {resolveWindowsExecutable,startWindowsProcess} from '../tools/windows-process.mjs';

// Initialize only: never send a research or model tool call during doctor.
export async function probeRigupProjectMcp(root:string,signal?:AbortSignal):Promise<string|undefined>{
 try{
  if(signal?.aborted)return;
  const binding=JSON.parse(await readFile(join(root,'.mcp.json'),'utf8')).mcpServers?.rigup;
  if(binding?.command!=='node'||!Array.isArray(binding.args)||!binding.args.every((arg:unknown)=>typeof arg==='string')||binding.cwd!==undefined&&binding.cwd!=='.')return;
  const input=JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'rigup-doctor',version:'1'}}})+'\n';
  let output='',bytes=0,overflow=false;
  const windows=process.platform==='win32';
  const command=windows?resolveWindowsExecutable(binding.command,root,process.env):binding.command;
  const child=windows?startWindowsProcess({executable:command,args:binding.args,cwd:root,env:process.env}):spawn(command,binding.args,{cwd:root,env:process.env,detached:true,stdio:['pipe','pipe','pipe']});
  const stop=()=>{
   if('stop' in child)child.stop();
   else if(child.pid)try{process.kill(-child.pid,'SIGKILL');}catch{}
  };
  child.stdout?.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>64_000){overflow=true;stop();}else output+=chunk.toString('utf8');});
  child.stderr?.resume();
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
   const bounded=AbortSignal.timeout(10_000);
   timer=setTimeout(stop,10_000);signal?.addEventListener('abort',stop,{once:true});
   let success:boolean;
   if('start' in child){
    child.start(input);
    const result=await child.completed;
    success=result.code===0&&!result.unavailable&&!result.remaining&&!result.interrupted;
   }else{
    child.stdin?.on('error',()=>{});child.stdin?.end(input);
    success=await new Promise<boolean>(done=>{child.once('error',()=>done(false));child.once('close',code=>done(code===0));});
   }
   if(!success||overflow||signal?.aborted||bounded.aborted)return;
   for(const line of output.split(/\r?\n/)){
    let response;try{response=JSON.parse(line);}catch{continue;}
    const info=response?.id===1&&response?.jsonrpc==='2.0'?response.result?.serverInfo:undefined;
    if(info?.name==='rigup'&&typeof info.version==='string'&&/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(info.version))return info.version;
   }
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',stop);}
 }catch{/* Host output, configuration and PATH failures must not expose credentials. */}
}
