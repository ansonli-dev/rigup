import {makeReason,ReasonError} from '../../i18n/reasons.js';
import {execFile} from 'node:child_process';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {delimiter,join} from 'node:path';
import {parse,satisfies,validRange} from 'semver';
import {externalExecutable,npmCommand,npmPathDirectories,withinPath} from '../../npm-command.mjs';
import {normalizeNpmIntegrity} from '../../npm-integrity.mjs';

export type NpmPackageName='openwiki'|'@colbymchenry/codegraph'|'@fission-ai/openspec';
export interface NpmPackageIdentity {version:string;packageIntegrity:string}
export interface ResolvedNpmPackage extends NpmPackageIdentity {registry?:string;enginesNode?:string}
export type NpmView=(args:string[],cwd:string,signal?:AbortSignal)=>Promise<string>;
export const defaultNpmRegistry='https://registry.npmjs.org/';
const packageScope=(name:string)=>name.startsWith('@')?name.split('/')[0]:undefined;

export function normalizeNpmRegistry(value:string):string{
 const invalid=()=>Error('Npm registry must use HTTPS or loopback HTTP and omit credentials, query, and fragment');
 const authority=/^https?:\/\/([^/]+)/i.exec(value)?.[1];
 if(!authority||authority.includes('@')||/[?#\s\\]/.test(value))throw invalid();
 let url:URL;
 try{url=new URL(value);}catch{throw invalid();}
 const loopback=url.hostname==='localhost'||url.hostname==='[::1]'||/^127\.\d+\.\d+\.\d+$/.test(url.hostname);
 if(url.username||url.password||url.protocol!=='https:'&&!(url.protocol==='http:'&&loopback))throw invalid();
 return url.href.replace(/\/?$/,'/');
}

export function npmRegistryFlags(name:string,registry:string):string[]{
 const scope=packageScope(name);
 return scope?['--'+scope+':registry='+registry]:['--registry',registry];
}

export function npmEnvironment(directories:string[],registryOverride?:string):NodeJS.ProcessEnv{
 const env=Object.fromEntries(Object.entries(process.env).filter(([name])=>
  !/^path$/i.test(name)&&!/^npm_config_(?:_auth(?:token)?|username|_password)$/i.test(name)&&
  !(registryOverride&&/^npm_config_registry$/i.test(name))));
 return {...env,PATH:directories.join(delimiter),...(registryOverride?{npm_config_registry:registryOverride}:{})};
}

export function isStableNpmVersion(value:unknown):value is string{
 if(typeof value!=='string')return false;
 const version=parse(value);
 return !!version&&!version.prerelease.length&&value===version.version+(version.build.length?'+'+version.build.join('.'):'');
}

export function assertNpmNode(name:string,version:string,nodeRange:unknown,nodeVersion:string):string|undefined{
 if(nodeRange===undefined)return;
 if(typeof nodeRange!=='string'||!nodeRange.trim()||nodeRange.length>256||!validRange(nodeRange))throw Error(name+'@'+version+' has an invalid engines.node range');
 const range=nodeRange.trim().replace(/\s+/g,' ');
 if(!satisfies(nodeVersion,range))throw Error(name+'@'+version+' requires Node '+range+' (found v'+nodeVersion+')');
 return range;
}

export async function resolveProjectNpm(root:string,args:string[],registryOverride?:string){
 const directories=await npmPathDirectories(root,process.env.PATH??process.env.Path??'');
 const env=npmEnvironment(directories,registryOverride);
 if(process.platform==='win32'){
  const command=npmCommand(args);
  for(const path of [command.executable,command.args[0]])if(withinPath(root,path)||withinPath(root,await realpath(path)))throw Error('Project npm launcher must be outside the project');
  return {...command,env};
 }
 const executable=await externalExecutable('npm',root,directories);
 if(!executable)throw Error('npm launcher outside the project is unavailable');
 return {executable,args,env};
}

export async function boundedCommandOutput(command:{executable:string;args:string[];env:NodeJS.ProcessEnv},cwd:string,signal?:AbortSignal,protectedRoots=[cwd]):Promise<string>{
 signal?.throwIfAborted();
 const parent=await realpath(tmpdir());
 if(protectedRoots.some(root=>withinPath(root,parent)))throw Error('npm inspection needs a temporary directory outside the project and npm prefix');
 const scratch=await mkdtemp(join(parent,'rigup-npm-inspect-'));
 try{
  // npm creates its cache even for config and prefix queries.
  const env=Object.fromEntries(Object.entries(command.env).filter(([key])=>!/^npm_config_(?:cache|logs_dir|logs_max|timing|update_notifier)$/i.test(key)));
  Object.assign(env,{npm_config_cache:scratch,npm_config_logs_dir:scratch,npm_config_logs_max:'0',npm_config_timing:'false',npm_config_update_notifier:'false'});
  signal?.throwIfAborted();
  return await new Promise((resolve,reject)=>{
   let failure:Error|null=null;
   let output='';
   const child=execFile(command.executable,command.args,{cwd,env,signal,timeout:20_000,killSignal:'SIGKILL',maxBuffer:256_000},(error,stdout)=>{
    failure=error;output=stdout;
   });
   // execFile can invoke its callback for an abort before closing the process.
   child.once('close',()=>failure?reject(failure):resolve(output));
  });
 }finally{await rm(scratch,{recursive:true,force:true,maxRetries:2});}
}

const projectNpmOutput:NpmView=async(args,cwd,signal)=>boundedCommandOutput(await resolveProjectNpm(cwd,args),cwd,signal);

export async function effectiveNpmRegistry(root:string,name:string,override?:string,signal?:AbortSignal,run=projectNpmOutput):Promise<string>{
 signal?.throwIfAborted();
 if(override)return normalizeNpmRegistry(override);
 const scope=packageScope(name);
 let value:string;
 try{
  const get=async(key:string)=>(await run(['config','get',key,'--update-notifier=false'],root,signal)).trim();
  value=scope?await get(scope+':registry'):'';
  if(!value||value==='undefined')value=await get('registry');
 }catch{
  signal?.throwIfAborted();
  throw new ReasonError(makeReason('reason.npm.registry'));
 }
 return normalizeNpmRegistry(value);
}

export async function resolveNpmLatest(name:NpmPackageName,input:{root:string;stateRoot:string;registry?:string;nodeVersion:string;signal?:AbortSignal;view?:NpmView;npm?:NpmView}):Promise<ResolvedNpmPackage>{
 const {root,registry,nodeVersion,signal,npm}=input;
 signal?.throwIfAborted();
 const effectiveRegistry=await effectiveNpmRegistry(root,name,registry,signal,npm);
 const label=name+'@latest from '+effectiveRegistry;
 let output:string;
 try{
  const args=['view',name+'@latest','name','version','dist-tags.latest','dist.integrity','engines.node','--json',...npmRegistryFlags(name,effectiveRegistry),
   '--prefer-online','--fetch-retries=0','--update-notifier=false'];
  output=await (input.view??npm??projectNpmOutput)(args,root,signal);
  signal?.throwIfAborted();
 }catch{
  signal?.throwIfAborted();
  throw new ReasonError(makeReason('reason.npm.resolve',{label}));
 }
 let metadata:unknown;
 try{metadata=JSON.parse(output);}catch{throw new ReasonError(makeReason('reason.npm.metadata',{label}));}
 if(!metadata||typeof metadata!=='object'||Array.isArray(metadata))throw new ReasonError(makeReason('reason.npm.package',{label}));
 const fields=metadata as Record<string,unknown>;
 const version=fields.version;
 if(fields.name!==name||!isStableNpmVersion(version)||version!==fields['dist-tags.latest'])
  throw new ReasonError(makeReason('reason.npm.stable',{label}));
 const packageIntegrity=normalizeNpmIntegrity(fields['dist.integrity']);
 if(!packageIntegrity)throw new ReasonError(makeReason('reason.npm.integrity',{label}));
 const enginesNode=assertNpmNode(name,version,fields['engines.node'],nodeVersion);
 return {version,packageIntegrity,registry:effectiveRegistry,...(enginesNode?{enginesNode}:{})};
}
