import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {access,constants,mkdtemp,rm,lstat,realpath,open} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {delimiter,join,resolve,relative,isAbsolute,posix,sep} from 'node:path';
import {stripVTControlCharacters} from 'node:util';
import {npmCommand} from '../../npm-command.mjs';
import {startWindowsProcess} from './windows-process.mjs';
const exec=promisify(execFile);
export function checkPrerequisites(script,manifest,cwd){
 const tools=[];
 if(/(?:^|[;&|]\s*|pm2\s+start\s+["'])\s*yarn(?:\s|$)/.test(script))tools.push('yarn');
 if(/(?:^|[;&|]\s*)\s*pm2\s+start(?:\s|$)/.test(script))tools.push('pm2');
 if(/(?:^|[;&|]\s*|yarn\s+)\s*playwright\s+test(?:\s|$)/.test(script))tools.push('playwright');
 const singleJest=/^[ \t]*jest[ \t]+[\w./= \t-]+$/.test(script);
 const config=singleJest?/[ \t]--config(?:=|[ \t]+)([\w./-]+\.json)(?=[ \t]|$)/.exec(script)?.[1]:undefined;
 const postgres=config&&relativePath(config)&&['pg','postgres','slonik','nestjs-slonik'].some(name=>Object.hasOwn(manifest.dependencies??{},name)||Object.hasOwn(manifest.devDependencies??{},name))
  ?{config:posix.join(cwd,config),
    ...(/^NODE_ENV=test\s+/.test(String(manifest.scripts?.['migration:up:tests']??''))?{migration:'migration:up:tests'}:{}),
    ...(!/\s(?:-i|--runInBand|-w|--maxWorkers)(?=\s|=|$)/.test(script)?{runInBand:true}:{})}:undefined;
 return {...(tools.length?{tools}:{}),...(postgres?{postgres}:{})};
}
export function jestSetupPath(config,setup){
 if(typeof setup==='string'&&/^<rootDir>\/[\w./-]+$/.test(setup)&&!setup.split('/').includes('..'))return posix.join(posix.dirname(config),setup.slice('<rootDir>/'.length));
}
export function hasTestDatabaseGuard(source){
 return /^\s*if\s*\(\s*!\s*(?:databaseConfig\.)?database\.includes\(\s*(['"])test\1\s*\)\s*\)\s*\{?\s*throw\b/m.test(source.replace(/\/\*[\s\S]*?\*\//g,''));
}
const relativePath=p=>typeof p==='string'&&p&&!isAbsolute(p)&&!p.includes('\\')&&!p.split('/').includes('..');
export const npmScriptName=value=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/.test(value);
export const projectRelativePath=value=>relativePath(value)&&!/[\x00-\x1f\x7f]/.test(value)&&value.split('/').every(part=>part&&part!=='.');
class BlockedCheck extends Error {}

async function readProjectFile(root,path,limit){
 if(!projectRelativePath(path))throw Error('Invalid project file path');
 const absolute=resolve(root,path);
 if(await realpath(absolute)!==absolute)throw Error('Project file is a symlink');
 const file=await open(absolute,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const info=await file.stat();
  if(!info.isFile()||info.size>limit)throw Error('Project file is unsafe or exceeds the read limit');
  const bytes=await file.readFile();
  if(bytes.length>limit)throw Error('Project file exceeds the read limit');
  return {bytes,mode:info.mode&0o777};
 }finally{await file.close();}
}

async function resolveNpmCommand(root,command){
 const [run,script]=command.args;
 if(command.executable!=='npm'||run!=='run'||!npmScriptName(script))return command;
 let manifest;
 try{manifest=JSON.parse((await readProjectFile(root,posix.join(command.cwd,'package.json'),1_000_000)).bytes);}
 catch{throw new BlockedCheck('Read the selected package.json and confirm the working directory before retrying.');}
 const scripts=manifest?.scripts,body=scripts?.[script];
 if(!scripts||typeof scripts!=='object'||Array.isArray(scripts)||typeof body!=='string'||!body.trim()||!Object.hasOwn(scripts,script))throw new BlockedCheck('The selected npm script is missing from package.json.');
 const {tools,postgres}=checkPrerequisites(body,manifest,command.cwd);
 if(postgres||command.testDatabase){
  const config=postgres&&await readProjectFile(root,postgres.config,256_000).then(file=>JSON.parse(file.bytes)).catch(()=>null);
  const setup=postgres&&jestSetupPath(postgres.config,config?.globalSetup);
  const guarded=setup&&await readProjectFile(root,setup,256_000).then(file=>hasTestDatabaseGuard(file.bytes.toString())).catch(()=>false);
  if(!guarded)throw new BlockedCheck('Verify the dedicated PostgreSQL test database and its Jest global setup guard before running this check.');
 }
 const args=postgres?.runInBand&&!command.args.includes('--runInBand')
  ?[...command.args,...(command.args.includes('--')?[]:['--']),'--runInBand']:command.args;
 return {...command,args,tools,testDatabase:postgres?true:undefined};
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
 let {env=process.env}=options;
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
 const cwd=await realpath(resolve(root,command.cwd));
 if(!within(root,cwd))throw Error('Check working directory escapes the selected project');
 try{command=await resolveNpmCommand(root,command);}
 catch(error){
  if(error instanceof BlockedCheck)return finish({status:'pending',exitCode:3,reason:error.message});
  throw error;
 }
 if(command.tools?.includes('yarn')){
  try{await Promise.any((env.PATH??'').split(delimiter).map(directory=>access(resolve(cwd,directory,'yarn'),constants.X_OK)));}
  catch{return finish({status:'pending',exitCode:3,reason:'Put the project Yarn version on PATH, then rerun this check'});}
 }
 let pm2,pm2Home;
 if(command.tools?.includes('pm2')){
  try{
   pm2=(await exec('npm',['exec','--offline','--yes=false','--call','command -v pm2'],{cwd,env,timeout:10000,maxBuffer:4096})).stdout.trim();
   if(!isAbsolute(pm2)||/[\r\n\0]/.test(pm2))throw Error('Invalid PM2 path');
   await access(pm2,constants.X_OK);
   pm2Home=await mkdtemp(join(tmpdir(),'rigup-pm2-'));
   env={...env,PM2_HOME:pm2Home};
  }catch{return finish({status:'pending',exitCode:3,reason:'Install the project dependencies to provide PM2, then rerun this check'});}
 }
 if(command.testDatabase)env={...env,NODE_ENV:'test'};
 try{return finish(await dispatchCheck(command,root,cwd,{env,signal,timeoutMs:timeoutMs??(command.tools?.includes('playwright')?120000:60000)}));}
 finally{
  if(pm2Home){
   try{await lstat(join(pm2Home,'pm2.pid'));await exec(pm2,['kill'],{cwd,env,timeout:10000,maxBuffer:4096});}
   catch(error){if(error.code!=='ENOENT')throw Error('Isolated PM2 did not stop. Reconcile the test process before retrying.');}
   await rm(pm2Home,{recursive:true,force:true});
  }
 }
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
 const result=process.platform==='win32'
  ?await runWindowsCheck(launch,cwd,{env,signal,timeoutMs},collect)
  :await runPosixCheck(launch,cwd,{env,signal,timeoutMs},collect);
 if(result.status==='failed'&&!result.reason){
  let output=stripVTControlCharacters(Buffer.concat(chunks).toString('utf8'));
  for(const secret of command.envRefs.map(name=>env[name]).filter(Boolean).sort((a,b)=>b.length-a.length))output=output.split(secret).join('[redacted]');
  if(command.testDatabase&&/\b(?:connect[ \t]+(?:EPERM|EACCES|ECONNREFUSED|ENETUNREACH|ETIMEDOUT)|getaddrinfo[ \t]+(?:ENOTFOUND|EAI_AGAIN))\b/i.test(output))
   return {...result,processExitCode:result.exitCode,exitCode:3,status:'pending',reason:'Test database unavailable here. Use an authorized terminal with the dedicated test database and rerun the same check.'};
  if(command.tools?.includes('playwright')&&/Executable doesn't exist|playwright install/i.test(output)&&/browserType\.launch|Playwright Test or Playwright/i.test(output))
   return {...result,processExitCode:result.exitCode,exitCode:3,status:'pending',reason:'Install the project browsers with npm exec --yes=false -- playwright install in the check working directory.'};
  const diagnostic=await dependencyDiagnostic(output,root,cwd);
  return {...result,...(diagnostic?{diagnostic}:{reason:'Check failed; inspect the project command in its working directory'})};
 }
 return result;
}

async function runWindowsCheck(launch,cwd,{env,signal,timeoutMs},collect){
 let child;
 try{child=startWindowsProcess({...launch,cwd,env});}
 catch{return {exitCode:3,status:'pending',reason:'Check executable unavailable in the selected environment'};}
 child.stdout?.on('data',collect);child.stderr?.on('data',collect);
 let interrupted;
 const interrupt=reason=>{interrupted??=reason;child.stop();};
 const cancel=()=>interrupt('cancelled');
 const timeout=setTimeout(()=>interrupt('timed out'),timeoutMs);
 signal?.addEventListener('abort',cancel,{once:true});
 try{
  if(signal?.aborted)cancel();else child.start();
  const {code,remaining,unavailable,interrupted:stopped}=await child.completed;
  if(remaining)return {exitCode:1,status:'failed',reason:'Check left a process running or could not confirm its exit; result cannot be accepted'};
  if(interrupted)return {exitCode:interrupted==='cancelled'?130:3,status:'pending',reason:'Check '+interrupted};
  if(unavailable||stopped)return {exitCode:3,status:'pending',reason:'Check executable unavailable in the selected environment'};
  return {exitCode:code??1,status:code===0?'passed':'failed',commandFinishedAt:new Date().toISOString()};
 }finally{
  clearTimeout(timeout);signal?.removeEventListener('abort',cancel);
  child.stop();await child.completed;
 }
}

async function runPosixCheck(launch,cwd,{env,signal,timeoutMs},collect){
 let child;
 try{child=spawn(launch.executable,launch.args,{cwd,env,shell:false,detached:true,stdio:['ignore','pipe','pipe']});}
 catch{return {exitCode:3,status:'pending',reason:'Check executable or runtime arguments unavailable in the selected environment'};}
 child.stdout.on('data',collect);child.stderr.on('data',collect);
 return new Promise(resolveResult=>{
  let interrupted,unavailable=false;
  const kill=()=>{if(child.pid)try{process.kill(-child.pid,'SIGKILL');}catch{}};
  const interrupt=reason=>{interrupted=reason;kill();child.stdout.destroy();child.stderr.destroy();};
  const cancel=()=>interrupt('cancelled');
  const timeout=setTimeout(()=>interrupt('timed out'),timeoutMs);
  signal?.addEventListener('abort',cancel,{once:true});
  if(signal?.aborted)cancel();
  child.once('error',()=>{unavailable=true;});
  child.once('close',code=>{
   clearTimeout(timeout);signal?.removeEventListener('abort',cancel);
   let remaining=false;if(child.pid)try{process.kill(-child.pid,0);remaining=true;kill();}catch{}
   if(interrupted)return resolveResult({exitCode:interrupted==='cancelled'?130:3,status:'pending',reason:'Check '+interrupted});
   if(unavailable)return resolveResult({exitCode:3,status:'pending',reason:'Check executable unavailable in the selected environment'});
   if(remaining)return resolveResult({exitCode:1,status:'failed',reason:'Check left a process running; result cannot be accepted'});
   resolveResult({exitCode:code??1,status:code===0?'passed':'failed',commandFinishedAt:new Date().toISOString()});
  });
 });
}
