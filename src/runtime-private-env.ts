import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {lstat,open,readFile,realpath,rename,rm} from 'node:fs/promises';
import {basename,dirname,join,relative,sep} from 'node:path';
import {promisify} from 'node:util';
import ignore from 'ignore';
import {protectWindowsPrivateFile} from './private-access.js';
import {directoryLocation} from './path-location.js';
import {withinPath} from './npm-command.mjs';
import {renameWithRetry} from './atomic-rename.js';
import {syncDirectory} from './sync-directory.js';
import {translate,type Locale} from './i18n/index.js';
import {makeReason,ReasonError,reasonDetail,reasonFallback,type WithReasonDetail} from './i18n/reasons.js';

const exec=promisify(execFile),limit=256_000;
export const runtimeEnvPath='.rigup/.env';
interface Entry {value:string;start:number;end:number}
export interface RuntimeFile extends WithReasonDetail {text:string;entries:Map<string,Entry>;exists?:boolean;path?:string;problem?:string}
const unsafeFile=makeReason('reason.runtime.unsafeFile');
export class PrivateInputWriteError extends ReasonError {}


export function essentialEnvironment(environment:NodeJS.ProcessEnv=process.env):NodeJS.ProcessEnv{
 const names=['PATH','Path','HOME','USERPROFILE','SystemRoot','SYSTEMROOT','WINDIR','ComSpec','COMSPEC','PATHEXT','TEMP','TMP','TMPDIR','LANG','LC_ALL','LC_CTYPE','TERM','LOCALAPPDATA','APPDATA','XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_DATA_HOME'];
 return Object.fromEntries(names.flatMap(name=>environment[name]===undefined?[]:[[name,environment[name]]]));
}

function parse(text:string):Map<string,Entry>{
 const entries=new Map<string,Entry>();
 let at=0;
 const invalid=()=>new ReasonError(makeReason('reason.runtime.fileSyntax'));
 while(at<text.length){
  while(/[ \t\r\n]/.test(text[at]??'')&&at<text.length)at++;
  if(at===text.length)break;
  if(text[at]==='#'){at=text.indexOf('\n',at);if(at<0)break;continue;}
  const match=/^(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*/.exec(text.slice(at));
  if(!match||entries.has(match[1]))throw invalid();
  const name=match[1];at+=match[0].length;const start=at;
  let value='';
  const quote=text[at];
  if(quote==='"'||quote==="'"||quote==='`'){
   at++;let closed=false;
   while(at<text.length){
    const char=text[at++];
    if(char===quote){closed=true;break;}
    if(quote==='"'&&char==='\\'&&['n','r','t','"','\\'].includes(text[at])){
     const escaped=text[at++];value+=({n:'\n',r:'\r',t:'\t','"':'"','\\':'\\'} as Record<string,string>)[escaped];
    }else value+=char;
   }
   if(!closed)throw invalid();
  }else{
   while(at<text.length&&!['#','\r','\n'].includes(text[at]))at++;
   value=text.slice(start,at).trimEnd();
   at=start+value.length;
  }
  const end=at;
  while(text[at]===' '||text[at]==='\t')at++;
  if(text[at]==='#'){const newline=text.indexOf('\n',at);at=newline<0?text.length:newline;}
  if(at<text.length&&text[at]!=='\r'&&text[at]!=='\n')throw invalid();
  if(value.includes('\0'))throw invalid();
  entries.set(name,{value,start,end});
 }
 return entries;
}

async function runtimeDirectory(root:string){
 const directory=await directoryLocation(join(root,'.rigup'));
 if(!withinPath(root,directory)||directory===root)throw new ReasonError(unsafeFile);
 return directory;
}

async function runtimeBytes(path:string,beforeRead?:()=>Promise<void>){
 const info=await lstat(path).catch(error=>{if(error.code!=='ENOENT')throw error;});
 if(!info)return;
 if(!info.isFile()||info.size>limit)throw new ReasonError(unsafeFile);
 await beforeRead?.();
 const bytes=await readFile(path);
 if(bytes.length>limit)throw new ReasonError(unsafeFile);
 return bytes;
}

export async function hasGitMetadata(root:string):Promise<boolean>{
 for(let directory=root;;directory=dirname(directory)){
  try{await lstat(join(directory,'.git'));return true;}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  if(dirname(directory)===directory)return false;
 }
}

async function ignored(root:string,target:string):Promise<boolean>{
 // An alternate repository or index cannot establish safety for this project's file.
 if(Object.keys(process.env).some(name=>/^GIT_(?:DIR|WORK_TREE|INDEX_FILE|COMMON_DIR)$/i.test(name)))return false;
 if(await hasGitMetadata(root)){
  const options={timeout:5000,maxBuffer:4096,env:essentialEnvironment()};
  const git=await exec('git',['-C',root,'rev-parse','--is-inside-work-tree'],options).catch(()=>undefined);
  if(git?.stdout.trim()!=='true')return false;
  // Git's index spelling can differ from an alias on a case-insensitive filesystem.
  try{await exec('git',['-C',root,'ls-files','--error-unmatch','--',':(icase,literal)'+target],options);return false;}
  catch(error){if((error as {code?:unknown}).code!==1)return false;}
  return exec('git',['-C',root,'check-ignore','--quiet','--no-index','--',target],options).then(()=>true,()=>false);
 }
 // The nearest ignore file protects this private scope after a future git init.
 const path=join(root,dirname(target),'.gitignore');
 try{
  if(!(await lstat(path)).isFile())return false;
  return ignore().add(await readFile(path,'utf8')).ignores(basename(target));
 }catch{return false;}
}

async function isPrivateGitPath(root:string,name:string,actual:string){
 const targets=new Set(['.rigup/'+name,relative(root,actual).split(sep).join('/')]);
 for(const target of targets)if(!await ignored(root,target))return false;
 return true;
}

export async function readRuntimeFile(root:string):Promise<RuntimeFile>{
 const empty=():RuntimeFile=>({text:'',entries:new Map()});
 try{
  root=await realpath(root);
  const path=join(await runtimeDirectory(root),'.env');
  const raw=await runtimeBytes(path,async()=>{
   if(!await isPrivateGitPath(root,'.env',path))throw new ReasonError(unsafeFile);
  });
  if(!raw)return {...empty(),path};
  const text=raw.toString('utf8');
  if(!raw.equals(Buffer.from(text)))throw new ReasonError(makeReason('reason.runtime.fileEncoding'));
  return {text,entries:parse(text),exists:true,path};
 }catch(error){
  const detail=error instanceof ReasonError?error.reason:undefined;
  const reason=detail&&typeof detail!=='string'&&(detail.code==='reason.runtime.fileSyntax'||detail.code==='reason.runtime.fileEncoding')?detail:unsafeFile;
  return {...empty(),problem:reasonFallback(reason),[reasonDetail]:reason};
 }
}

export function renderRuntimeFile(file:RuntimeFile,values:{name:string;value?:string;comment:string;required:boolean}[],locale:Locale):string{
 let text=file.text;
 const edits=values.flatMap(input=>{
  const entry=file.entries.get(input.name);
  return entry&&!entry.value&&input.value?[{...entry,value:JSON.stringify(input.value)}]:[];
 }).sort((a,b)=>b.start-a.start);
 for(const entry of edits)text=text.slice(0,entry.start)+entry.value+text.slice(entry.end);
 for(const input of values){
  if(file.entries.has(input.name))continue;
  if(text&&!text.endsWith('\n'))text+='\n';
  const note=translate(locale,input.required?'artifact.envRequired':'artifact.envOptional',{note:input.comment});
  text+='# '+note+'\n'+input.name+'='+(input.value?JSON.stringify(input.value):'')+'\n';
 }
 return text;
}

export async function writeRuntimeFile(root:string,before:RuntimeFile,text:string):Promise<void>{
 root=await realpath(root);
 const directory=await runtimeDirectory(root),path=join(directory,'.env');
 const name='.env.rigup-'+randomUUID()+'.tmp',temporary=join(directory,name);
 const verifyIgnore=async()=>{
  if(!await isPrivateGitPath(root,'.env',path)||!await isPrivateGitPath(root,name,temporary))throw new ReasonError(unsafeFile);
 };
 const verify=async()=>{
  if(await runtimeDirectory(root)!==directory||before.problem||before.path&&before.path!==path)throw new ReasonError(unsafeFile);
  await verifyIgnore();
  const current=await runtimeBytes(path);
  if(!!current!==!!before.exists||current&&!current.equals(Buffer.from(before.text)))throw new ReasonError(unsafeFile);
 };
 await verifyIgnore();
 const handle=await open(temporary,'wx',0o600);
 try{
  try{
   try{
    if(process.platform==='win32')await protectWindowsPrivateFile(temporary);
    else if(((await handle.stat()).mode&0o777)!==0o600)throw Error('Private permissions unavailable');
   }catch{
    throw new PrivateInputWriteError(makeReason('reason.runtime.privatePermissions',{path}));
   }
   await verifyIgnore();
   await handle.writeFile(text);await handle.sync();
  }finally{await handle.close();}
  await renameWithRetry(()=>rename(temporary,path),verify);
  await syncDirectory(directory);
 }finally{await rm(temporary,{force:true}).catch(()=>{});}
}
