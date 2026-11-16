import {execFile} from 'node:child_process';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {delimiter,join} from 'node:path';
import {parse,satisfies,validRange} from 'semver';
import {privateDirectory} from '../../generator/cache.js';
import {externalExecutable,npmCommand,npmPathDirectories,withinPath} from '../../npm-command.mjs';
import {normalizeNpmIntegrity} from '../../npm-integrity.mjs';
import {essentialEnvironment} from '../../runtime-inputs.js';

export type NpmPackageName='openwiki'|'@colbymchenry/codegraph'|'@fission-ai/openspec';
export interface NpmPackageIdentity {version:string;packageIntegrity:string}
export interface ResolvedNpmPackage extends NpmPackageIdentity {registry?:string;enginesNode?:string}
export type NpmView=(args:string[],cwd:string,signal?:AbortSignal)=>Promise<string>;
export const defaultNpmRegistry='https://registry.npmjs.org/';

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

export async function resolveProjectNpm(root:string,args:string[]){
 const directories=await npmPathDirectories(root,process.env.PATH??process.env.Path??'');
 const env=essentialEnvironment();delete env.Path;env.PATH=directories.join(delimiter);
 if(process.platform==='win32'){
  const command=npmCommand(args);
  for(const path of [command.executable,command.args[0]])if(withinPath(root,path)||withinPath(root,await realpath(path)))throw Error('Project npm launcher must be outside the project');
  return {...command,env};
 }
 const executable=await externalExecutable('npm',root,directories);
 if(!executable)throw Error('npm launcher outside the project is unavailable');
 return {executable,args,env};
}

export function boundedCommandOutput(command:{executable:string;args:string[];env:NodeJS.ProcessEnv},cwd:string,signal?:AbortSignal,timeout=20_000):Promise<string>{
 signal?.throwIfAborted();
 return new Promise((resolve,reject)=>{
  let failure:Error|null=null;
  let output='';
  const child=execFile(command.executable,command.args,{cwd,env:command.env,signal,timeout,killSignal:'SIGKILL',maxBuffer:256_000},(error,stdout)=>{
   failure=error;output=stdout;
  });
  // execFile can invoke its callback for an abort before closing the process.
  child.once('close',()=>failure?reject(failure):resolve(output));
 });
}

export async function resolveNpmLatest(name:NpmPackageName,input:{root:string;stateRoot:string;registry?:string;nodeVersion:string;signal?:AbortSignal;view?:NpmView}):Promise<ResolvedNpmPackage>{
 const {root,stateRoot,registry,nodeVersion,signal}=input;
 signal?.throwIfAborted();
 const effectiveRegistry=registry??defaultNpmRegistry;
 const label=name+'@latest from '+effectiveRegistry;
 const stage=await mkdtemp(join(await privateDirectory(stateRoot,root),'npm-view-'));
 let output:string;
 try{
  const args=['view',name+'@latest','name','version','dist-tags.latest','dist.integrity','engines.node','--json','--registry',effectiveRegistry,
   '--prefix',stage,'--userconfig',join(stage,'user.npmrc'),'--globalconfig',join(stage,'global.npmrc'),'--cache',join(stage,'cache'),
   '--prefer-online','--fetch-retries=0','--update-notifier=false'];
  output=input.view?await input.view(args,stage,signal):await boundedCommandOutput(await resolveProjectNpm(root,args),stage,signal);
  signal?.throwIfAborted();
 }catch{
  signal?.throwIfAborted();
  throw Error('Could not resolve '+label+'; check registry access and npm availability');
 }finally{await rm(stage,{recursive:true,force:true});}
 let metadata:unknown;
 try{metadata=JSON.parse(output);}catch{throw Error('Could not resolve '+label+'; invalid npm metadata');}
 if(!metadata||typeof metadata!=='object'||Array.isArray(metadata))throw Error('Could not resolve '+label+'; expected one package');
 const fields=metadata as Record<string,unknown>;
 const version=fields.version;
 if(fields.name!==name||!isStableNpmVersion(version)||version!==fields['dist-tags.latest'])
  throw Error('Could not resolve '+label+'; registry must provide a stable latest tag for this package');
 const packageIntegrity=normalizeNpmIntegrity(fields['dist.integrity']);
 if(!packageIntegrity)throw Error('Could not resolve '+label+'; missing or invalid dist.integrity');
 const enginesNode=assertNpmNode(name,version,fields['engines.node'],nodeVersion);
 return {version,packageIntegrity,registry:effectiveRegistry,...(enginesNode?{enginesNode}:{})};
}
