import {lstat,readFile,realpath,stat} from 'node:fs/promises';
import {resolve,relative,isAbsolute,posix,sep} from 'node:path';
import {stripVTControlCharacters} from 'node:util';
import {npmCommand} from '../../npm-command.mjs';
import {startProcess} from './windows-process.mjs';

const relativePath=p=>typeof p==='string'&&p&&!isAbsolute(p)&&!p.includes('\\')&&!p.split('/').includes('..');
export const npmScriptName=value=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/.test(value);
export const projectRelativePath=value=>relativePath(value)&&!/[\x00-\x1f\x7f]/.test(value)&&value.split('/').every(part=>part&&part!=='.');
class BlockedCheck extends Error {}

async function assertNpmScript(root,command){
 const [run,script]=command.args;
 if(command.executable!=='npm'||run!=='run'||!npmScriptName(script))return;
 const path=posix.join(command.cwd,'package.json');
 let manifest;
 try{
  const target=await realpath(resolve(root,path)),info=await stat(target);
  if(!within(root,target)||!info.isFile()||info.size>1_000_000)throw Error('Package manifest unavailable');
  manifest=JSON.parse(await readFile(target,'utf8'));
 }catch{throw new BlockedCheck('Read '+path+' and confirm the working directory before retrying.');}
 const scripts=manifest?.scripts;
 if(!scripts||typeof scripts!=='object'||Array.isArray(scripts)||!Object.hasOwn(scripts,script)||typeof scripts[script]!=='string'||!scripts[script].trim())
  throw new BlockedCheck('The selected npm script '+script+' is missing from '+path+'.');
}

function within(root,path){
 const rel=relative(root,path);
 return rel!=='..'&&!rel.startsWith('..'+sep)&&!isAbsolute(rel);
}
async function dependencyDiagnostic(text,root,cwd){
 const match=/^\s*error ([a-zA-Z0-9_-]{1,100}): ([\w./@-]{1,400}) → ([\w./@-]{1,400})\s*$/m.exec(stripVTControlCharacters(text));
 if(!match)return;
 const paths=await Promise.all(match.slice(2).map(async value=>{
  if(!relativePath(value)||value.split('/').some(part=>/^\.|secret|password|token|credential/i.test(part)))return;
  try{
   const path=resolve(cwd,value);
   if(!(await lstat(path)).isFile())return;
   const canonical=await realpath(path);
   if(within(root,canonical))return relative(root,canonical).split(sep).join('/');
  }catch{/* The diagnostic is useful only for confirmed project paths. */}
 }));
 if(paths.every(Boolean))return {rule:match[1],path:paths[0],relatedPath:paths[1]};
}
/** @param {{env?: NodeJS.ProcessEnv, signal?: AbortSignal, timeoutMs?: number}} [options] */
export async function executeCheck(command,root,options={}){
 const {env=process.env}=options;
 const {signal,timeoutMs}=options;
 if(!command||typeof command.executable!=='string'||!Array.isArray(command.args)||command.args.some(a=>typeof a!=='string')||!relativePath(command.cwd)||!Array.isArray(command.envRefs))throw Error('Invalid project check command');
 const referenceCommand=command;
 const startedAt=new Date().toISOString(),start=Date.now(),finish=result=>({command:referenceCommand,...result,startedAt,finishedAt:new Date().toISOString(),durationMs:Date.now()-start});
 if(command.executable.includes('${')||command.cwd.includes('${'))return finish({status:'pending',exitCode:3,reason:'Environment references are supported only in command arguments'});
 const references=command.args.flatMap(arg=>[...arg.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map(match=>match[1]));
 const undeclared=[...new Set(references.filter(name=>!command.envRefs.includes(name)))];
 if(undeclared.length)return finish({status:'pending',exitCode:3,reason:'Undeclared environment references: '+undeclared.join(', ')});
 const missing=command.envRefs.filter(name=>!env[name]);
 if(missing.length)return finish({status:'pending',exitCode:3,reason:'Missing environment references: '+missing.join(', ')});
 if(signal?.aborted)return finish({status:'pending',exitCode:130,reason:'Check cancelled before dispatch'});
 root=await realpath(root);
 const cwd=await realpath(resolve(root,command.cwd));
 if(!within(root,cwd))throw Error('Check working directory escapes the selected project');
 try{await assertNpmScript(root,command);}
 catch(error){
  if(error instanceof BlockedCheck)return finish({status:'pending',exitCode:3,reason:error.message});
  throw error;
 }
 return finish(await dispatchCheck(command,root,cwd,{env,signal,timeoutMs:timeoutMs??600_000}));
}

async function dispatchCheck(command,root,cwd,{env,signal,timeoutMs}){
 if(signal?.aborted)return {status:'pending',exitCode:130,reason:'Check cancelled before dispatch'};
 let launch;
 const args=command.args.map(arg=>arg.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,(_match,name)=>env[name]));
 try{launch=command.executable==='npm'?npmCommand(args):{...command,args};}
 catch{return {exitCode:3,status:'pending',reason:'Check executable unavailable in the selected environment'};}
 // Only allowlisted diagnostic fields leave this buffer. Keep draining after its limit.
 const chunks=[];let bytes=0;
 const collect=chunk=>{const part=chunk.subarray(0,32768-bytes);if(part.length){chunks.push(part);bytes+=part.length;}};
 const result=await runCheck(launch,cwd,{env,signal,timeoutMs},collect);
 if(result.status==='failed'&&!result.reason){
  let output=stripVTControlCharacters(Buffer.concat(chunks).toString('utf8'));
  for(const secret of command.envRefs.map(name=>env[name]).filter(Boolean).sort((a,b)=>b.length-a.length))output=output.split(secret).join('[redacted]');
  const diagnostic=await dependencyDiagnostic(output,root,cwd);
  return {...result,...(diagnostic?{diagnostic}:{reason:'Check failed; inspect the project command in its working directory'})};
 }
 return result;
}

async function runCheck(launch,cwd,{env,signal,timeoutMs},collect){
 let child;
 try{child=startProcess({...launch,cwd,env});}
 catch{return {exitCode:3,status:'pending',reason:'Check executable unavailable in the selected environment'};}
 child.stdout?.on('data',collect);
 child.stderr?.on('data',collect);
 let interrupted;
 const interrupt=reason=>{if(child.stop())interrupted=reason;};
 const cancel=()=>interrupt('cancelled');
 const timeout=setTimeout(()=>interrupt('timed out'),timeoutMs);
 signal?.addEventListener('abort',cancel,{once:true});
 try{
  if(signal?.aborted)cancel();else child.start();
  const {code,unavailable}=await child.completed;
  if(interrupted)return {exitCode:interrupted==='cancelled'?130:3,status:'pending',reason:'Check '+interrupted};
  if(unavailable)return {exitCode:3,status:'pending',reason:'Check executable unavailable in the selected environment'};
  return {exitCode:code??1,status:code===0?'passed':'failed',commandFinishedAt:new Date().toISOString()};
 }finally{
  clearTimeout(timeout);signal?.removeEventListener('abort',cancel);
  child.stop();await child.completed;
 }
}
