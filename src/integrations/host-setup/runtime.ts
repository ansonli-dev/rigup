import {constants} from 'node:fs';
import {access,realpath,rm,stat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {basename,delimiter,dirname,extname,isAbsolute,join,resolve} from 'node:path';
import {acquireLock,defaultStateRoot,type ProjectLock} from '../../installer/lock.js';
import {protectedOperationCommand,hostWriterPath,nativeWriterStateRoot,readHostWriter,writerAlive} from '../../installer/operations.js';
import {isRecord,saveDurable} from '../../private-record.js';
import {syncDirectory} from '../../sync-directory.js';
import {absoluteHostPath,canonicalHostDirectory,nativeJson,withinPath} from './host-files.js';

const windows=process.platform==='win32';
export type SetupHost='claude'|'omp';
export interface NativeInputs {home?:string;env?:NodeJS.ProcessEnv;stateRoot?:string}
export interface HostCommand {executable:string;args:string[];env:NodeJS.ProcessEnv}
interface NativeProgram {file:string;args:string[]}
const envKey=(windows? (key:string)=>key.toUpperCase() : (key:string)=>key);
export const consumerEnvironment=(base:NodeJS.ProcessEnv)=>Object.fromEntries(Object.entries(base).map(([key,value])=>[envKey(key),value]));
const localConfig=/^\.?[a-z0-9][a-z0-9._-]{0,62}$/i;
const validProfile=/^[a-z0-9][a-z0-9._-]{0,63}$/;
const specialName=/^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)/i;

export const nativeHome=(input:NativeInputs,env:NodeJS.ProcessEnv)=>
 absoluteHostPath(input.home??(windows?env.USERPROFILE??env.HOME:env.HOME)??homedir());

async function runnable(path:string){
 try{
  if(!(await stat(path)).isFile())return false;
  await access(path,constants.X_OK);
  return true;
 }catch{return false;}
}

function pathEntries(root:string,path:string){
 return path.split(delimiter).filter(Boolean).map(dir=>resolve(root,windows?dir.replace(/^"|"$/g,''):dir));
}

async function npmClaudeProgram(file:string,paths:string[]):Promise<NativeProgram|undefined>{
 const directory=dirname(file),modules=dirname(directory);
 const base=basename(directory).toLowerCase()==='.bin'&&basename(modules).toLowerCase()==='node_modules'?
  modules:join(directory,'node_modules');
 const pkg=join(base,'@anthropic-ai','claude-code');
 const data=(await nativeJson(join(pkg,'package.json'),64_000).catch(()=>undefined))?.value;
 const bin=isRecord(data?.bin)?data.bin.claude:data?.bin;
 if(data?.name!=='@anthropic-ai/claude-code'||typeof bin!=='string'||!(/^(?:\.\/)?[\w.-]+(?:\/[\w.-]+)*\.(?:exe|[cm]?js)$/i.test(bin))||
    bin.split('/').includes('..'))return;
 const entry=resolve(pkg,bin);
 if(!await runnable(entry))return;
 if(extname(entry).toLowerCase()==='.exe')return {file:entry,args:[]};
 for(const dir of [directory,...paths]){
  const node=join(dir,'node.exe');
  if(await runnable(node))return {file:node,args:[entry]};
 }
}

async function nativeProgram(command:string,root:string,paths:string[]):Promise<NativeProgram|undefined>{
 const candidates=isAbsolute(command)?[command]:paths.flatMap(dir=>
  (windows?['.exe','.cmd','.bat']:['']).map(extension=>join(dir,command+extension)));
 for(const file of candidates){
  if(!await runnable(file))continue;
  if(windows&&command==='claude'&&extname(file).toLowerCase()==='.cmd'){
   const direct=await npmClaudeProgram(file,paths);
   if(direct)return direct;
  }
  return {file:resolve(root,file),args:[]};
 }
}

export async function inspectHostLocations(root:string,host:SetupHost,input:NativeInputs={}){
 root=await realpath(root);
 const env=consumerEnvironment(input.env??(input.home?{}:process.env));
 const externalDirectory=async(key:string,value:string)=>{
  try{
   const path=await canonicalHostDirectory(value);
   if(withinPath(root,path))throw Error('inside project');
   return path;
  }catch{throw Error(key+' must point to a directory outside the project: '+absoluteHostPath(value));}
 };
 const home=await externalDirectory('HOME',nativeHome(input,env));
 if(!(await stat(home)).isDirectory())throw Error('HOME is not a directory: '+home);
 env.HOME=home;
 if(windows){
  env.USERPROFILE=home;
  env.SYSTEMROOT??=process.env.SystemRoot;
  env.NODEFAULTCURRENTDIRECTORYINEXEPATH='1';
 }
 for(const key of ['CLAUDE_CONFIG_DIR','XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_DATA_HOME','XDG_STATE_HOME',...(windows?['LOCALAPPDATA','APPDATA']:[]),...(host==='omp'?['PI_CODING_AGENT_DIR']:[])]){
  if(env[key])env[key]=await externalDirectory(key,env[key]!);
 }
 if(host==='omp'){
  if(env.PI_CONFIG_DIR&&(!localConfig.test(env.PI_CONFIG_DIR)||specialName.test(env.PI_CONFIG_DIR)||env.PI_CONFIG_DIR.endsWith('.')))
   throw Error('PI_CONFIG_DIR must be a supported directory name under HOME');
  for(const key of ['OMP_PROFILE','PI_PROFILE']){
   if(env[key]===undefined)continue;
   const name=env[key]!.trim();
   if(name&&(!validProfile.test(name)||specialName.test(name)||name.endsWith('.')))throw Error(key+' does not select a supported OMP profile');
   env[key]=name;
  }
 }
 const stateRoot=await externalDirectory('Rigup state',input.stateRoot??(input.home?join(home,'.local','state','rigup'):defaultStateRoot()));
 const writerRoot=await externalDirectory('Rigup native writer state',nativeWriterStateRoot(input.stateRoot));
 const paths=pathEntries(root,env.RIGUP_CONSUMER_PATH??env.PATH??'');
 env.PATH=paths.join(delimiter);
 return {root,home,stateRoot,writerRoot,env};
}
export type HostLocations=Awaited<ReturnType<typeof inspectHostLocations>>;

export async function inspectHostRuntime(root:string,host:SetupHost,input:NativeInputs={}){
 const locations=await inspectHostLocations(root,host,input);
 const program=await nativeProgram(host,locations.root,pathEntries(locations.root,locations.env.PATH??''));
 if(!program)throw Error(host+' was not found on PATH; install the supported CLI and retry');
 return {...locations,program};
}
export type HostRuntime=Awaited<ReturnType<typeof inspectHostRuntime>>;

export function nativeChildEnv(runtime:HostRuntime,privateTemp:string):NodeJS.ProcessEnv{
 return {...runtime.env,...(windows?{TEMP:privateTemp,TMP:privateTemp}:{TMPDIR:privateTemp})};
}

export async function withHostWriter<T>(
 lock:Pick<ProjectLock,'root'|'stateRoot'>,host:SetupHost,
 work:(runner:{run:typeof run})=>Promise<T>,signal?:AbortSignal,writerRoot=lock.stateRoot,
){
 const resource=await acquireLock(lock.root,{stateRoot:writerRoot,resource:'native-host:'+host,recover:true});
 const record=hostWriterPath(resource.stateRoot,host);
 const clear=async()=>{await rm(record,{force:true});await syncDirectory(resource.stateRoot);};
 try{
  const previous=await readHostWriter(resource.stateRoot,host);
  if(previous){
   if(await writerAlive(previous.identity))throw Error('Previous '+host+' writing process still active; retry after it exits');
   await clear();
  }
  return await work({run});
 }finally{await resource.release();}

 async function run(command:HostCommand,cwd:string,timeoutMs:number,recheck:()=>Promise<string|undefined>,capture?: (chunk:Buffer)=>void){
  let code:number|null=null,cancelled=false,dispatched=false;
  const result=await protectedOperationCommand(command,cwd,Math.min(timeoutMs,900_000),{
   signal,launcher:{cwd:resource.stateRoot,env:command.env},stdout:capture,
   markDispatching:async identity=>{await saveDurable(record,JSON.stringify({root:resource.root,host,identity}));},
   registryPending:async()=>{
    let blocked:string|undefined;
    try{blocked=await recheck();}catch{blocked='Native prerequisites changed or could not be rechecked; review a fresh plan';}
    return blocked?{status:'pending',message:blocked}:undefined;
   },
   restoreUndispatched:async()=>{await clear();return {status:'pending',message:'Native command cancelled before dispatch'};},
   finish:async (exit,interrupted)=>{
    dispatched=true;code=exit;cancelled=interrupted;
    await clear();
    return {status:exit===0&&!interrupted?'done':'failed',message:'Native command exited'};
   },
  });
  return {code,cancelled:cancelled||!dispatched&&signal?.aborted===true,dispatched,blocked:result.status==='pending'?result.message:undefined};
 }
}

export async function hostGit(runtime:HostLocations){
 const program=await nativeProgram('git',runtime.root,pathEntries(runtime.root,runtime.env.PATH??''));
 if(!program||windows&&extname(program.file).toLowerCase()!=='.exe')
  throw Error('Native Claude setup requires Git on PATH');
 return program.file;
}
