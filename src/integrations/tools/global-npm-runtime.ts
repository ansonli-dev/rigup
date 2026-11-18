import {execFile} from 'node:child_process';
import {constants} from 'node:fs';
import {access,lstat,open,readFile,realpath} from 'node:fs/promises';
import {homedir} from 'node:os';
import {basename,delimiter,dirname,isAbsolute,join} from 'node:path';
import {promisify} from 'node:util';
import {targetPath} from '../../installer/ownership.js';
import {essentialEnvironment} from '../../runtime-inputs.js';
import {signature} from '../../generator/cache.js';
import {externalExecutable as executable,npmPathDirectories,withinPath as within} from '../../npm-command.mjs';
import {boundedCommandOutput,npmEnvironment,type NpmView} from './npm-resolution.js';
export type GlobalTool='openwiki'|'codegraph'|'openspec';
export function globalPackage(id:GlobalTool){return {name:id==='openspec'?'@fission-ai/openspec':id==='codegraph'?'@colbymchenry/codegraph':'openwiki',bin:id} as const;}
const exec=promisify(execFile);
const windows=process.platform==='win32';
const nodeName=windows?'node.exe':'node';
export const packageDirectory=(name:string)=> (windows?'node_modules/':'lib/node_modules/')+name;
export type Program={file:string;args?:string[];launcher?:string};
export const available=(path:string,mode:number)=>access(path,mode).then(()=>true,()=>false);
export const exists=(path:string)=>lstat(path).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
// The portable launcher keeps its bundled Node available for Rigup operations.
export function consumerPath(root:string){
 return npmPathDirectories(root,process.env.RIGUP_CONSUMER_PATH??process.env.PATH??process.env.Path??'');
}

export async function windowsNpmCommand(name:string,directory:string,root:string,pathDirs:string[]):Promise<Program>{
 const packageName=name==='npm'?'npm':globalPackage(name as GlobalTool).name;
 const modules=dirname(directory);
 const prefix=basename(directory).toLowerCase()==='.bin'&&basename(modules).toLowerCase()==='node_modules'?dirname(modules):directory;
 const packageRoot=await targetPath(prefix,packageDirectory(packageName));
 const manifest=await targetPath(packageRoot,'package.json');
 const stat=await lstat(manifest);
 if(!stat.isFile()||stat.size>64_000)throw Error('Invalid npm package manifest');
 const metadata=JSON.parse(await readFile(manifest,'utf8'));
 const bin=typeof metadata.bin==='string'?metadata.bin:metadata.bin?.[name];
 if(metadata.name!==packageName||typeof bin!=='string'||!/^[\w./-]+\.(?:c|m)?js$/i.test(bin))throw Error('Invalid npm package entry');
 const entry=await targetPath(packageRoot,bin.replace(/^\.\//,''));
 const node=await executable(nodeName,root,[directory,...pathDirs]);
 const canonical=await realpath(entry);
 if(!node||!within(packageRoot,canonical)||within(root,canonical)||!(await lstat(entry)).isFile())throw Error('Unsafe npm package entry');
 return {file:node,args:[canonical],launcher:join(directory,name+'.cmd')};
}

export async function findProgram(name:string,root:string,pathDirs:string[]):Promise<Program|undefined>{
 if(!windows){
  const file=await executable(name,root,pathDirs);
  if(file)return {file};
  return;
 }
 for(const directory of pathDirs){
  const file=await executable(name+'.exe',root,[directory]);
  if(file)return {file};
  // npm installs a .cmd shim beside its package. Launch the declared Node
  // entry directly so project paths and arguments never enter cmd.exe.
  if(await executable(name+'.cmd',root,[directory]))return windowsNpmCommand(name,directory,root,pathDirs);
 }
}

export function commandEnvironment(path:string[],extraEnv?:NodeJS.ProcessEnv,inheritPrefix=false):NodeJS.ProcessEnv{
 const prefix=inheritPrefix?Object.fromEntries(Object.entries(process.env).filter(([name])=>/^npm_config_prefix$/i.test(name))):{};
 const env=essentialEnvironment();delete env.Path;
 return {...env,...prefix,PATH:path.join(delimiter),DO_NOT_TRACK:'1',OPENSPEC_TELEMETRY:'0',OPENSPEC_NO_UPDATE_CHECK:'1',...extraEnv};
}

export async function command(program:Program,args:string[],cwd:string,path:string[],signal?:AbortSignal,env?:NodeJS.ProcessEnv){
 return exec(program.file,[...(program.args??[]),...args],{cwd,signal,timeout:20_000,maxBuffer:256_000,env:commandEnvironment(path,env,true)});
}

export function globalNpmOutput(npm:Program,path:string[],root:string,prefix?:string):NpmView{
 return (args,cwd,signal)=>boundedCommandOutput({executable:npm.file,args:[...npm.args??[],...args],env:npmEnvironment(path)},cwd,signal,prefix?[root,prefix]:[root]);
}

export async function npmPrefix(npm:Program,root:string,path:string[],signal?:AbortSignal,name='@fission-ai/openspec'){
 const preferred=(await globalNpmOutput(npm,path,root)(['prefix','-g'],homedir(),signal).catch(()=>undefined))?.trim();
 if(!preferred)return;
 for(const prefix of windows?[preferred]:[preferred,join(homedir(),'.local')]){
  if(!prefix||!isAbsolute(prefix))continue;
  const canonical=await realpath(prefix).catch(()=>undefined);
  const bin=windows?canonical:await realpath(join(prefix,'bin')).catch(()=>undefined);
  if(!canonical||within(root,canonical)||!bin||!within(canonical,bin)||!path.includes(bin)||!await available(bin,constants.W_OK))continue;
  if(await targetPath(canonical,packageDirectory(name)).catch(()=>undefined))return canonical;
 }
}

export async function userNode(root:string,path:string[],signal?:AbortSignal){
 const node=await executable(nodeName,root,path);
 if(!node)return;
 const version=(await command({file:node},['--version'],homedir(),path,signal).catch(()=>undefined))?.stdout.trim();
 if(version&&/^v\d+\.\d+\.\d+$/.test(version))return {file:node,version:version.slice(1)};
}

export async function programIdentity(program:Program,root:string,path:string[]):Promise<string>{
 const files=new Set([program.file,...(program.args??[]),...(program.launcher?[program.launcher]:[])]);
 if(!windows){
  const file=await open(program.file,constants.O_RDONLY|constants.O_NONBLOCK);
  try{
   if(!(await file.stat()).isFile())throw Error('OpenSpec launcher is not a regular file');
   const header=Buffer.alloc(256);await file.read(header);
   const shebang=/^#![ \t]*(\S+)(?:[ \t]+([^\r\n]+))?/.exec(header.toString('utf8'));
   if(shebang&&isAbsolute(shebang[1])){
    files.add(shebang[1]);
    if(basename(shebang[1])==='env'&&/^(?:-S\s+)?node(?:\s|$)/.test(shebang[2]??'')){
     const interpreter=await executable(nodeName,root,path);
     if(!interpreter)throw Error('OpenSpec Node interpreter is unavailable');
     files.add(interpreter);
    }
   }
  }finally{await file.close();}
 }
 const identities=await Promise.all([...files].map(async file=>{
  const canonical=await realpath(file),stat=await lstat(canonical,{bigint:true});
  if(within(root,file)||within(root,canonical)||!stat.isFile())throw Error('OpenSpec launcher is outside its approved path');
  return {file,canonical,identity:[stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].join(':')};
 }));
 return signature({program,identities});
}

export async function prefixIdentity(prefix:string){
 const stat=await lstat(prefix,{bigint:true});
 if(!stat.isDirectory()||await realpath(prefix)!==prefix)throw Error('OpenSpec npm prefix changed after approval');
 return stat.dev+':'+stat.ino;
}
