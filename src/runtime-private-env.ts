import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat,open,readFile,realpath,rename,rm} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {promisify} from 'node:util';
import ignore from 'ignore';
import {assertPrivateAccess,assertSafeWindowsAncestors,createWindowsPrivateDirectory} from './private-access.js';
import {renameWithRetry} from './atomic-rename.js';
import {syncDirectory} from './sync-directory.js';

const exec=promisify(execFile),limit=256_000;
export const runtimeEnvPath='.rigup/.env';
interface Entry {value:string;start:number;end:number}
export interface RuntimeFile {text:string;entries:Map<string,Entry>;identity?:string;problem?:string}
const identity=(info:{dev:number;ino:number;size:number;mtimeMs:number})=>[info.dev,info.ino,info.size,info.mtimeMs].join(':');
const problem='Keep .rigup/.env unchanged; make it an untracked, effectively ignored, private regular file with safe parent directories, then retry.';

export function essentialEnvironment(environment:NodeJS.ProcessEnv=process.env):NodeJS.ProcessEnv{
 const names=['PATH','Path','HOME','USERPROFILE','SystemRoot','SYSTEMROOT','WINDIR','ComSpec','COMSPEC','PATHEXT','TEMP','TMP','TMPDIR','LANG','LC_ALL','LC_CTYPE','TERM','LOCALAPPDATA','APPDATA','XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_DATA_HOME'];
 return Object.fromEntries(names.flatMap(name=>environment[name]===undefined?[]:[[name,environment[name]]]));
}

function parse(text:string):Map<string,Entry>{
 const entries=new Map<string,Entry>();
 let at=0;
 const invalid=()=>Error('Invalid .rigup/.env syntax or duplicate key; correct the local file without exporting its contents.');
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

async function safeParents(root:string):Promise<void>{
 for(const path of [root,join(root,'.rigup')]){
  let info;try{info=await lstat(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'&&path!==root)return;throw error;}
  if(!info.isDirectory()||info.isSymbolicLink()||await realpath(path)!==path||process.platform!=='win32'&&!!(info.mode&0o022))throw Error(problem);
 }
 await assertSafeWindowsAncestors(join(root,runtimeEnvPath),problem);
}

async function hasGitMetadata(root:string):Promise<boolean>{
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
 const path=join(root,'.rigup/.gitignore');
 try{
  if(!(await lstat(path)).isFile()||await realpath(path)!==path)return false;
  return ignore().add(await readFile(path,'utf8')).ignores(target.slice('.rigup/'.length));
 }catch{return false;}
}

export async function readRuntimeFile(root:string):Promise<RuntimeFile>{
 const empty=():RuntimeFile=>({text:'',entries:new Map()});
 try{
  await safeParents(root);
  const path=join(root,runtimeEnvPath);
  let info;try{info=await lstat(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return empty();throw error;}
  if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>limit||!await ignored(root,runtimeEnvPath))throw Error(problem);
  await assertPrivateAccess(path,info,problem);
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
   const opened=await file.stat();
   if(!opened.isFile()||opened.nlink!==1||identity(opened)!==identity(info))throw Error(problem);
   await assertPrivateAccess(path,opened,problem);
   const bytes=await file.readFile();
   if(bytes.length>limit)throw Error(problem);
   const text=bytes.toString('utf8');
   return {text,entries:parse(text),identity:identity(info)};
  }finally{await file.close();}
 }catch(error){return {...empty(),problem:error instanceof Error&&error.message.startsWith('Invalid .rigup/.env')?error.message:problem};}
}

export function renderRuntimeFile(file:RuntimeFile,values:{name:string;value?:string;reason:string;required:boolean}[]):string{
 let text=file.text;
 const edits=values.flatMap(input=>{
  const entry=file.entries.get(input.name);
  return entry&&!entry.value&&input.value?[{...entry,value:JSON.stringify(input.value)}]:[];
 }).sort((a,b)=>b.start-a.start);
 for(const entry of edits)text=text.slice(0,entry.start)+entry.value+text.slice(entry.end);
 for(const input of values){
  if(file.entries.has(input.name))continue;
  if(text&&!text.endsWith('\n'))text+='\n';
  text+='# '+(input.required?'Required':'Optional')+': '+input.reason+'\n'+input.name+'='+(input.value?JSON.stringify(input.value):'')+'\n';
 }
 return text;
}

export async function writeRuntimeFile(root:string,before:RuntimeFile,text:string):Promise<void>{
 const tempTarget='.rigup/.env.rigup-'+randomUUID()+'.tmp',temporary=join(root,tempTarget),path=join(root,runtimeEnvPath);
 await safeParents(root);
 if(!await ignored(root,runtimeEnvPath)||!await ignored(root,tempTarget))throw Error(problem);
 const parent=await lstat(join(root,'.rigup'));
 const verify=async()=>{
  await safeParents(root);
  const currentParent=await lstat(join(root,'.rigup'));
  if(parent.dev!==currentParent.dev||parent.ino!==currentParent.ino)throw Error(problem);
  if(!await ignored(root,runtimeEnvPath)||!await ignored(root,tempTarget))throw Error(problem);
  const current=await readRuntimeFile(root);
  if(current.problem||current.identity!==before.identity||current.text!==before.text)throw Error(problem);
 };
 let staged=temporary;
 try{
  if(process.platform==='win32'){
   await createWindowsPrivateDirectory(temporary,problem);
   staged=join(temporary,'.env');
  }
  const handle=await open(staged,'wx',0o600);
  try{
   await assertPrivateAccess(staged,await handle.stat(),problem);
   await verify();
   await handle.writeFile(text);await handle.sync();
  }finally{await handle.close();}
  await verify();
  await renameWithRetry(()=>rename(staged,path),verify);
  await syncDirectory(join(root,'.rigup'));
 }finally{
  // A replaced parent is not ours to clean up.
  const current=await lstat(join(root,'.rigup')).catch(()=>undefined);
  if(current?.dev===parent.dev&&current.ino===parent.ino)await rm(temporary,{force:true,recursive:process.platform==='win32'}).catch(()=>{});
 }
}
