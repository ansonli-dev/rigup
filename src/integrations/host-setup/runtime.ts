import {constants} from 'node:fs';
import {access,open,readdir,readlink,realpath,rm} from 'node:fs/promises';
import {homedir} from 'node:os';
import {basename,delimiter,dirname,extname,join,relative,resolve} from 'node:path';
import {signature} from '../../generator/cache.js';
import {acquireLock,defaultStateRoot,type ProjectLock} from '../../installer/lock.js';
import {protectedOperationCommand,hostWriterPath,readHostWriter,writerAlive,type WriterIdentity} from '../../installer/operations.js';
import {isRecord,saveDurable} from '../../private-record.js';
import {syncDirectory} from '../../sync-directory.js';
import {assertSafeWindowsAncestors} from '../../private-access.js';
import {npmPathDirectories} from '../../npm-command.mjs';
import {absoluteHostPath,checkedDirectory,checkedFile,nativeJson,statIfPresent,stamp,withinPath} from './host-files.js';

const windows=process.platform==='win32';
export type SetupHost='claude'|'omp';
export interface NativeInputs {home?:string;env?:NodeJS.ProcessEnv;stateRoot?:string}
export interface HostCommand {executable:string;args:string[];env:NodeJS.ProcessEnv}
export interface NativeProgram {file:string;args:string[];identity:string;paths:string[]}
const envKey=(windows? (key:string)=>key.toUpperCase() : (key:string)=>key);
export const consumerEnvironment=(base:NodeJS.ProcessEnv)=>Object.fromEntries(Object.entries(base).map(([key,value])=>[envKey(key),value]));
const localConfig=/^\.[a-z0-9][a-z0-9._-]{0,62}$/i;
const validProfile=/^[a-z0-9][a-z0-9._-]{0,63}$/;
const specialName=/^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)/i;

export async function assertProjectScope(root:string,home:string,host:SetupHost,env:NodeJS.ProcessEnv){
 if(!await checkedDirectory(root))throw Error('Project directory is missing');
 const claude=env.CLAUDE_CONFIG_DIR??join(home,'.claude');
 const omp=join(home,env.PI_CONFIG_DIR??'.omp');
 const candidates=host==='claude'?['.git','.claude']:['.git','.omp','.pi','.claude',env.PI_CONFIG_DIR??'.omp'];
 for(let parent=dirname(root);parent!==root;parent=dirname(parent)){
  for(const name of new Set(candidates)){
   const path=join(parent,name);
   if((relative(claude,path)===''||relative(omp,path)==='')&&relative(home,parent)==='')continue;
   if(await statIfPresent(path))throw Error('An enclosing '+name+' can change '+host+' project scope; choose the native project root');
  }
  if(dirname(parent)===parent)break;
 }
 const git=await statIfPresent(join(root,'.git'));
 if(git&&!git.isDirectory())throw Error('An indirect .git can change native project scope; prepare it manually');
 if(windows&&(await readdir(root)).some(name=>/\.(?:exe|com|cmd|bat|dll|ps1|scr|cpl)[ .]*$/i.test(name)))
  throw Error('Project contains an executable or DLL in its root; move it before native preparation');
}

async function safeBinary(path:string,root:string,header=false){
 const target=absoluteHostPath(await realpath(path));
 if(withinPath(root,target)||withinPath(root,path))throw Error('Native launcher resolves inside the project');
 const before=await checkedFile(target,{hardlinks:true,limit:1_000_000_000});
 if(!before)throw Error('Native launcher disappeared');
 await access(target,constants.X_OK);
 let start:Buffer|undefined;
 if(header){
  const handle=await open(target,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
   if(stamp(await handle.stat({bigint:true}))!==stamp(before))throw Error('Native launcher changed');
   start=Buffer.alloc(256);
   await handle.read(start);
  }finally{await handle.close();}
 }
 return {file:target,identity:stamp(before),start};
}

export async function vettedPath(root:string,raw:string){
 const paths:string[]=[];
 const entries=windows?raw.replace(/(^|;)"([^"]+)"(?=;|$)/g,'$1$2'):raw;
 for(const dir of await npmPathDirectories(root,entries)){
  try{
   const canonical=absoluteHostPath(dir);
   if(!await checkedDirectory(canonical))continue;
   const files=await readdir(canonical,{withFileTypes:true});
   if(files.length>6000)continue;
   let redirects=false;
   for(const item of files.filter(entry=>entry.isSymbolicLink())){
    const path=join(canonical,item.name),target=resolve(canonical,await readlink(path));
    if(withinPath(root,target)||withinPath(root,await realpath(path).catch(()=>target))){redirects=true;break;}
   }
   if(!redirects&&!paths.some(path=>relative(path,canonical)===''))paths.push(canonical);
  }catch{/* Unverified entries are excluded from the child PATH too. */}
 }
 return paths;
}

export async function nativeProgram(host:SetupHost,root:string,paths:string[]):Promise<NativeProgram>{
 const locate=async(name:string,dirs=paths)=>{
  for(const dir of dirs){
   const path=join(dir,name);
   if(await statIfPresent(path))return safeBinary(path,root,true);
  }
 };
 const direct=(binary:NonNullable<Awaited<ReturnType<typeof locate>>>)=>({file:binary.file,args:[],identity:signature(binary.identity),paths:[binary.file]});
 for(const directory of paths){
  const binary=await locate(host+(windows?'.exe':''),[directory]);
  if(binary){
   const text=binary.start!.toString('utf8');
   if(windows&&text.startsWith('MZ')||!windows&&!text.startsWith('#!'))return direct(binary);
   if(!windows&&host==='omp'&&/^#![ \t]*\/usr\/bin\/env[ \t]+bun[ \t]*\r?\n/.test(text)){
    const bun=await locate('bun');
    if(!bun||bun.start!.toString('utf8').startsWith('#!'))throw Error('OMP requires a trusted native Bun interpreter');
    return {file:bun.file,args:[binary.file],identity:signature([bun.identity,binary.identity]),paths:[bun.file,binary.file]};
   }
   throw Error('Unsupported native '+host+' launcher; install the vetted CLI directly');
  }
  if(!windows||host!=='claude')continue;
  const shim=join(directory,'claude.cmd');
  const shimInfo=await checkedFile(shim,{limit:64_000});
  if(!shimInfo)continue;
  const modules=dirname(directory);
  const base=basename(directory).toLowerCase()==='.bin'&&basename(modules).toLowerCase()==='node_modules'?modules:join(directory,'node_modules');
  const pkg=join(base,'@anthropic-ai','claude-code'),manifestPath=join(pkg,'package.json');
  const manifest=await nativeJson(manifestPath,64_000);
  const data=manifest?.value;
  const bin=isRecord(data?.bin)?data.bin.claude:data?.bin;
  if(data?.name!=='@anthropic-ai/claude-code'||typeof bin!=='string'||!(/^(?:\.\/)?[\w.-]+(?:\/[\w.-]+)*\.(?:exe|[cm]?js)$/i.test(bin))||
     bin.split('/').includes('..'))throw Error('Invalid Claude npm launcher manifest');
  const entry=join(pkg,bin),payload=await safeBinary(entry,root,true);
  if(relative(entry,payload.file)!=='')throw Error('Claude npm launcher entry is redirected');
  const identity=[stamp(shimInfo),manifest!.identity,payload.identity];
  if(extname(entry).toLowerCase()==='.exe'){
   if(!payload.start!.toString('utf8').startsWith('MZ'))throw Error('Claude npm entry is not a native executable');
   return {file:entry,args:[],identity:signature(identity),paths:[entry,shim,manifestPath]};
  }
  const node=await locate('node.exe');
  if(!node||!node.start!.toString('utf8').startsWith('MZ'))throw Error('Claude npm launcher requires trusted node.exe');
  return {file:node.file,args:[entry],identity:signature([...identity,node.identity]),paths:[node.file,entry,shim,manifestPath]};
 }
 throw Error(host+' was not found on a trusted PATH; install the supported CLI and retry');
}

export async function inspectHostRuntime(root:string,host:SetupHost,input:NativeInputs={}){
 root=await realpath(root);
 const raw=consumerEnvironment(input.env??(input.home?{}:process.env)),env:NodeJS.ProcessEnv={};
 const externalDirectory=async(key:string,value:string)=>{
  try{
   const path=absoluteHostPath(value);
   if(withinPath(root,path))throw Error('inside project');
   await checkedDirectory(path);
   return path;
  }catch{throw Error(key+' must point to a trusted absolute directory outside the project, without symlinks or junctions');}
 };
 const home=await externalDirectory('HOME',input.home??(windows?raw.USERPROFILE??raw.HOME:raw.HOME)??homedir());
 if(!await checkedDirectory(home))throw Error('HOME is missing');
 if(windows){
  for(const key of ['HOME','USERPROFILE'])if(raw[key]&&relative(home,await externalDirectory(key,raw[key]!))!=='')
   throw Error('HOME and USERPROFILE select different native settings; make them agree before retrying');
  env.USERPROFILE=home;
  env.SystemRoot=await externalDirectory('SystemRoot',raw.SYSTEMROOT??process.env.SystemRoot??'');
  if(relative(env.SystemRoot,process.env.SystemRoot??env.SystemRoot)!=='')throw Error('SystemRoot does not match the Windows system directory');
  env.WINDIR=env.SystemRoot;
  env.ComSpec=join(env.SystemRoot,'System32','cmd.exe');
  env.PATHEXT='.COM;.EXE;.BAT;.CMD';
  env.NoDefaultCurrentDirectoryInExePath='1';
 }
 env.HOME=home;
 for(const key of ['CLAUDE_CONFIG_DIR','XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_DATA_HOME','XDG_STATE_HOME',...(windows?['LOCALAPPDATA','APPDATA']:[]),...(host==='omp'?['PI_CODING_AGENT_DIR']:[])]){
  if(raw[key]!==undefined)env[key]=await externalDirectory(key,raw[key]!);
 }
 if(host==='omp'){
  if(raw.PI_CONFIG_FILES)throw Error('PI_CONFIG_FILES supplies unsupported OMP settings overlays; prepare manually or remove the overlay before retrying');
  if(raw.PI_CONFIG_DIR){
   if(!localConfig.test(raw.PI_CONFIG_DIR)||raw.PI_CONFIG_DIR.endsWith('.'))throw Error('PI_CONFIG_DIR must be a supported directory name under HOME');
   env.PI_CONFIG_DIR=raw.PI_CONFIG_DIR;
  }
  for(const key of ['OMP_PROFILE','PI_PROFILE']){
   if(raw[key]===undefined)continue;
   const name=raw[key]!.trim();
   if(name&&(!validProfile.test(name)||specialName.test(name)||name.endsWith('.')))throw Error(key+' does not select a supported OMP profile');
   env[key]=name;
  }
 }
 const stateRoot=await externalDirectory('Rigup state',input.stateRoot??(input.home?join(home,'.local','state','rigup'):defaultStateRoot()));
 await assertProjectScope(root,home,host,env);
 const path=await vettedPath(root,raw.RIGUP_CONSUMER_PATH??raw.PATH??'');
 env.PATH=path.join(delimiter);
 const program=await nativeProgram(host,root,path);
 const approved=signature({home,root,stateRoot,env,program});
 return {root,home,stateRoot,env,program,approved};
}
export type HostRuntime=Awaited<ReturnType<typeof inspectHostRuntime>>;

export function nativeChildEnv(runtime:HostRuntime,privateTemp:string):NodeJS.ProcessEnv{
 return {...runtime.env,...(windows?{TEMP:privateTemp,TMP:privateTemp}:{TMPDIR:privateTemp})};
}

export async function assertWindowsLaunch(runtime:HostRuntime,writePaths:string[]){
 if(!windows)return;
 for(const path of new Set([...runtime.program.paths,join(runtime.root,'check-cwd'),...writePaths]))
  await assertSafeWindowsAncestors(path,'Native setup requires trusted Windows directories');
}

export async function withHostWriter<T>(
 lock:Pick<ProjectLock,'root'|'stateRoot'>,host:SetupHost,
 work:(runner:{run:typeof run})=>Promise<T>,signal?:AbortSignal,
){
 const resource=await acquireLock(lock.root,{stateRoot:lock.stateRoot,resource:'native-host:'+host,recover:true});
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
  let writer:WriterIdentity|undefined,code:number|null=null,cancelled=false,dispatched=false;
  const result=await protectedOperationCommand(command,cwd,Math.min(timeoutMs,900_000),{
   signal,launcher:{cwd:resource.stateRoot,env:command.env},stdout:capture,
   identity:()=>writer,
   markDispatching:async identity=>{await saveDurable(record,JSON.stringify({root:resource.root,host,identity}));writer=identity;},
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
