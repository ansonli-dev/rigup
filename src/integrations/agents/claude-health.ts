import {execFile} from 'node:child_process';
import {access,constants,stat} from 'node:fs/promises';
import {delimiter,isAbsolute,join} from 'node:path';
import {promisify} from 'node:util';

const exec=promisify(execFile);
async function isFile(path:string,mode=constants.F_OK):Promise<boolean>{
 try{await access(path,mode);return (await stat(path)).isFile();}catch{return false;}
}

async function claudeCommand():Promise<{file:string;args:string[]}|undefined>{
 for(const raw of (process.env.PATH??'').split(delimiter)){
  const directory=raw.replace(/^"(.*)"$/,'$1');
  if(!isAbsolute(directory))continue;
  const windows=process.platform==='win32';
  const file=join(directory,windows?'claude.exe':'claude');
  if(await isFile(file,constants.X_OK))return {file,args:[]};
  if(windows&&await isFile(join(directory,'claude.cmd'))){
   // Resolve the known npm layout without sending the project path or ID
   // through cmd.exe. Current packages can ship a binary or a JS entry.
   const pkg=join(directory,'node_modules','@anthropic-ai','claude-code');
   const native=join(pkg,'bin','claude.exe');
   if(await isFile(native))return {file:native,args:[]};
   const script=join(pkg,'cli.js');
   if(await isFile(script))return {file:process.execPath,args:[script]};
  }
 }
}

export async function probeClaudeProjectMcp(root:string,ids:string[],signal?:AbortSignal):Promise<string[]>{
 const command=await claudeCommand();
 if(!command)return [];
 const timeout=AbortSignal.timeout(30_000);
 const bounded=signal?AbortSignal.any([signal,timeout]):timeout;
 const connected:string[]=[];
 for(const id of ids){
  if(bounded.aborted)break;
  if(!/^[a-z0-9][a-z0-9._-]*$/.test(id))continue;
  try{
   const {stdout}=await exec(command.file,[...command.args,'mcp','get',id],{
    cwd:root,signal:bounded,windowsHide:true,maxBuffer:256_000,env:{...process.env,NO_COLOR:'1',FORCE_COLOR:'0'},
   });
   const lines=stdout.split(/\r?\n/).map(line=>line.trim());
   if(lines.includes(id+':')&&lines.includes('Scope: Project config (shared via .mcp.json)')&&
      lines.some(line=>/^Status: [✔✓√] Connected$/u.test(line)))connected.push(id);
  }catch{/* The host output can include sensitive configuration. */}
 }
 return connected;
}
