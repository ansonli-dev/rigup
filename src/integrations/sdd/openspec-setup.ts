import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {access,lstat,mkdir,mkdtemp,readdir,readFile,realpath,rm} from 'node:fs/promises';
import {homedir} from 'node:os';
import {basename,delimiter,dirname,isAbsolute,join,relative,sep} from 'node:path';
import {promisify} from 'node:util';
import {scanRepository} from '../../analyzer/repository.js';
import {acquireLock} from '../../installer/lock.js';
import {atomicProjectWrite} from '../../installer/manifest.js';
import {assertNoUnknownWriters} from '../../installer/operations.js';
import {targetPath} from '../../installer/ownership.js';
import {assertSupportedFileModes} from '../../installer/filesystem-modes.js';
import {essentialEnvironment,selectedNpmRegistry} from '../../runtime-inputs.js';
import {quoteShell} from '../../shell-command.js';
import type {Agent,SetupOptions} from '../../types.js';
import {agents} from '../agents/index.js';
import {loadUpstreamLock,requireRecipeEvidence} from '../upstream.js';
import {startWindowsProcess} from '../tools/windows-process.mjs';
import {resolveSddBinding,unqualifiedSkillName} from './binding.js';
import {openspecInitArgs,openspecPackage,openspecPreparationCommand} from './openspec.js';

const exec=promisify(execFile);
const windows=process.platform==='win32';
const nodeName=windows?'node.exe':'node';
const packageDirectory=(name:string)=> (windows?'node_modules/':'lib/node_modules/')+name;
type Program={file:string;args?:string[]};
const npmFlags=['--ignore-scripts','--no-audit','--no-fund','--prefer-offline'];
const hostScopes=(agent:Agent)=>[agents[agent].skillDirectory,agents[agent].skillDirectory.replace(/\/skills$/,'/commands')];
const within=(root:string,path:string)=>{const rel=relative(root,path);return rel===''||rel!=='..'&&!rel.startsWith('..'+sep)&&!isAbsolute(rel);};
const available=(path:string,mode:number)=>access(path,mode).then(()=>true,()=>false);
const exists=(path:string)=>lstat(path).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
// The portable launcher keeps its bundled Node available for Rigup operations.
async function consumerPath(root:string){
 const path=process.env.RIGUP_CONSUMER_PATH??process.env.PATH??'';
 const candidates=await Promise.all(path.split(delimiter).filter(dir=>isAbsolute(dir)&&!within(root,dir)).map(async dir=>{
  const canonical=await realpath(dir).catch(()=>undefined);
  if(!canonical||within(root,canonical))return;
  const interpreter=await realpath(join(canonical,nodeName)).catch(()=>undefined);
  if(!interpreter||!within(root,interpreter))return canonical;
 }));
 return candidates.filter((dir):dir is string=>!!dir);
}

async function executable(name:string,root:string,pathDirs:string[]){
 for(const directory of pathDirs){
  const path=join(directory,name);
  if(!await available(path,constants.X_OK))continue;
  const canonical=await realpath(path);
  if(!within(root,path)&&!within(root,canonical)&&(await lstat(canonical)).isFile())return path;
 }
}

async function windowsNpmCommand(name:'openspec'|'npm',directory:string,root:string,pathDirs:string[]):Promise<Program>{
 const packageName=name==='npm'?'npm':openspecPackage;
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
 return {file:node,args:[canonical]};
}

async function findProgram(name:'openspec'|'npm',root:string,pathDirs:string[]):Promise<Program|undefined>{
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

function commandEnvironment(path:string[],extraEnv?:NodeJS.ProcessEnv):NodeJS.ProcessEnv{
 const prefix=Object.fromEntries(Object.entries(process.env).filter(([name])=>/^npm_config_prefix$/i.test(name)));
 return {...essentialEnvironment(),...prefix,PATH:path.join(delimiter),DO_NOT_TRACK:'1',OPENSPEC_TELEMETRY:'0',OPENSPEC_NO_UPDATE_CHECK:'1',...extraEnv};
}

async function command(program:Program,args:string[],cwd:string,path:string[],signal?:AbortSignal){
 return exec(program.file,[...(program.args??[]),...args],{cwd,signal,timeout:20_000,maxBuffer:256_000,env:commandEnvironment(path)});
}

async function writingCommand(program:Program,args:string[],cwd:string,path:string[],signal?:AbortSignal,extraEnv?:NodeJS.ProcessEnv,timeout=20_000){
 const argv=[...(program.args??[]),...args];
 const env={...essentialEnvironment(),PATH:path.join(delimiter),DO_NOT_TRACK:'1',OPENSPEC_TELEMETRY:'0',OPENSPEC_NO_UPDATE_CHECK:'1',...extraEnv};
 if(!windows){
  try{await exec(program.file,argv,{cwd,signal,timeout,maxBuffer:256_000,env});}
  catch{throw Error('OpenSpec command failed; inspect its installation or retry the approved preparation.');}
  return;
 }
 signal?.throwIfAborted();
 const child=startWindowsProcess({executable:program.file,args:argv,cwd,env,captureOutput:false});
 const timer=setTimeout(child.stop,timeout);
 signal?.addEventListener('abort',child.stop,{once:true});
 try{
  if(signal?.aborted)child.stop();else child.start();
  const result=await child.completed;
  if(result.code!==0||result.remaining||result.unavailable||result.interrupted)throw Error('Protected OpenSpec command did not complete');
 }finally{
  clearTimeout(timer);signal?.removeEventListener('abort',child.stop);
  child.stop();await child.completed;
 }
}

async function npmPrefix(npm:Program,root:string,path:string[],signal?:AbortSignal){
 const preferred=(await command(npm,['prefix','-g'],homedir(),path,signal).catch(()=>undefined))?.stdout.trim();
 if(!preferred)return;
 for(const prefix of windows?[preferred]:[preferred,join(homedir(),'.local')]){
  if(!prefix||!isAbsolute(prefix))continue;
  const canonical=await realpath(prefix).catch(()=>undefined);
  const bin=windows?canonical:await realpath(join(prefix,'bin')).catch(()=>undefined);
  if(!canonical||within(root,canonical)||!bin||!within(canonical,bin)||!path.includes(bin)||!await available(bin,constants.W_OK))continue;
  if(await targetPath(canonical,packageDirectory(openspecPackage)).catch(()=>undefined))return canonical;
 }
}

async function canRunOpenSpec(root:string,path:string[],signal?:AbortSignal){
 const node=await executable(nodeName,root,path);
 if(!node)return false;
 const version=(await command({file:node},['--version'],homedir(),path,signal).catch(()=>undefined))?.stdout.trim();
 const match=version?.match(/^v(\d+)\.(\d+)\.\d+$/);
 return !!match&&(Number(match[1])>22||Number(match[1])===22&&Number(match[2])>=12);
}

export async function inspectOpenSpec(root:string,options:Pick<SetupOptions,'agents'|'backend'>,signal?:AbortSignal){
 root=await realpath(root);
 const path=await consumerPath(root);
 const [lock,profile,discovered]=await Promise.all([
  loadUpstreamLock(),
  scanRepository(root,{agents:options.agents,backend:options.backend,sdd:'openspec',scope:options.agents.flatMap(hostScopes)}),
  findProgram('openspec',root,path).catch(()=>null)
 ]);
 const cli=discovered??undefined;
 const recipe=lock.find(item=>item.integrationId==='openspec')!;
 requireRecipeEvidence(recipe);
 const needsEntries:Agent[]=[],problems:string[]=[];
 if(discovered===null)problems.push('The existing openspec command could not be resolved. Repair its installation or put a working CLI first on PATH.');
 for(const agent of options.agents){
  try{resolveSddBinding('openspec',agent,profile.nativeEntries?.[agent]??[],profile.skillSources?.[agent]??[],profile.files);}
  catch(error){
   const reason=(error as Error).message;
   if(reason.startsWith('missing native entry:'))needsEntries.push(agent);
   else problems.push(agent+': '+reason);
  }
 }
 let needsRoot=!await exists(join(root,'openspec/config.yaml'))&&!await exists(join(root,'openspec/config.yml'));
 let cliVersion:string|undefined;
 if(cli){
  const version=(await command(cli,['--version'],root,path,signal).catch(()=>undefined))?.stdout.trim();
  if(version&&/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)){
   cliVersion=version;
   const listed=await command(cli,['list','--json'],root,path,signal).catch(error=>error.code===1?{stdout:error.stdout as string}:undefined);
   try{
    const list=JSON.parse(listed?.stdout??'');
    if(list.root===null&&(!list.status?.length||list.status.some((status:{code:string})=>['no_openspec_root','no_root_with_registered_stores'].includes(status.code))))needsRoot=true;
    else if(typeof list.root?.path==='string'&&isAbsolute(list.root.path)&&
            (list.root.source==='declared'||await realpath(list.root.path).catch(()=>undefined)===root))needsRoot=false;
    else if((list.root?.source==='nearest'||list.root?.source==='global_default')&&needsRoot)needsRoot=true;
    else problems.push('OpenSpec project root could not be verified');
   }catch{problems.push('OpenSpec CLI did not return a usable project status');}
  }else problems.push('The existing openspec command did not start successfully. Repair its installation or put a working CLI first on PATH.');
 }
 const needsProject=needsRoot||needsEntries.length>0;
 const externalPreparation=!!cliVersion&&cliVersion!==recipe.version&&needsProject;
 const [npm,nodeReady]=cli?[undefined,true]:await Promise.all([findProgram('npm',root,path).catch(()=>undefined),canRunOpenSpec(root,path,signal)]);
 const prefix=npm&&nodeReady?await npmPrefix(npm,root,path,signal):undefined;
 const installTargets=windows?['openspec','openspec.exe','openspec.cmd','openspec.ps1']:['bin/openspec'];
 const installAvailable=!cli&&!!prefix&&!(await Promise.all([...installTargets,packageDirectory(openspecPackage)].map(target=>exists(join(prefix,target))))).some(Boolean);
 const requirements=[
  ...(!cli?['OpenSpec CLI is missing from PATH']:[]),
  ...(needsRoot?['OpenSpec project root is missing']:[]),
  ...needsEntries.map(host=>host+': OpenSpec workflow entries are missing'),
  ...problems,
  ...(!nodeReady?['OpenSpec needs Node.js 22.12 or newer on the user PATH']:[]),
  ...(!cli&&!installAvailable?['Automatic installation requires npm and a writable user bin directory on PATH']:[]),
  ...(externalPreparation?['Automatic project initialization uses the verified OpenSpec '+recipe.version+' layout. Use the installed OpenSpec CLI to initialize this project, then retry Rigup.']:[])
 ];
 const canPrepare=!problems.length&&(cliVersion===recipe.version||!!cliVersion&&!needsProject||!cli&&installAvailable);
 const userBin=!windows&&!cli&&npm&&nodeReady&&!prefix
  ?await realpath(homedir()).then(home=>targetPath(home,'.local/bin')).catch(()=>undefined):undefined;
 const steps=[
  ...(!cli&&npm&&nodeReady&&!prefix&&userBin&&!within(root,userBin)?[
   'mkdir -p '+quoteShell(userBin),'export PATH='+quoteShell(userBin)+':"$PATH"'
  ]:[]),
  ...((!cli||needsProject)&&!problems.length?[externalPreparation
   ?['openspec',...openspecInitArgs(options.agents),quoteShell(root)].join(' ')
   :openspecPreparationCommand(root,options.agents)]:[])
 ];
 const registry=!cli||needsProject?await selectedNpmRegistry(root):undefined;
 return {cli,cliVersion,npm,prefix,path,recipe,...(registry?{registry}:{}),needsProject,needsRoot,needsEntries,requirements,canPrepare,steps,entries:profile.nativeEntries};
}
type OpenSpecSetup=Awaited<ReturnType<typeof inspectOpenSpec>>;

export function reportOpenSpecPending(setup:OpenSpecSetup,resumeCommand:string,write:(text:string)=>void,report?:(value:Record<string,unknown>)=>void){
 const steps=setup.steps.filter(step=>step!==resumeCommand);
 const nextCommand=steps.length?[...steps,resumeCommand].join(' && '):null;
 report?.({phase:'preflight',installStatus:'pending',executable:false,pending:setup.requirements,requiredInput:setup.requirements,nextCommand,resumeCommand});
 write('补齐 OpenSpec 后继续原设置：\n'+(nextCommand??resumeCommand)+'\n');
}

async function assertRegistry(root:string,approved:OpenSpecSetup){
 if(await selectedNpmRegistry(root)!==approved.registry)throw Error('Npm registry selection changed after review; review OpenSpec preparation again.');
}

async function installOpenSpec(root:string,setup:OpenSpecSetup,stage:string,signal?:AbortSignal){
 const {npm,prefix,recipe}=setup;
 if(!npm||!prefix||!recipe.packageIntegrity)throw Error('A writable npm bin directory on PATH is required');
 const name=openspecPackage+'@'+recipe.version;
 const archive='fission-ai-openspec-'+recipe.version+'.tgz';
 const registryFlags=['--registry',setup.registry??'https://registry.npmjs.org/','--userconfig',join(stage,'.npmrc.user'),'--globalconfig',join(stage,'.npmrc.global'),'--cache',join(stage,'.npm-cache')];
 await assertRegistry(root,setup);
 await writingCommand(npm,['pack','--ignore-scripts','--prefer-offline',...registryFlags,'--pack-destination',stage,name],stage,setup.path,signal,undefined,120_000);
 const tarball=join(stage,archive);
 const integrity='sha512-'+createHash('sha512').update(await readFile(tarball)).digest('base64');
 if(integrity!==recipe.packageIntegrity)throw Error('OpenSpec package integrity mismatch');
 await assertRegistry(root,setup);
 await writingCommand(npm,['install','--global','--prefix',prefix,...npmFlags,...registryFlags,tarball],stage,setup.path,signal,undefined,120_000);
}

async function addNativeFiles(root:string,staged:string,setup:OpenSpecSetup,signal?:AbortSignal){
 const allowed=['openspec',...setup.needsEntries.flatMap(hostScopes)].map(scope=>scope+'/');
 const files:{target:string;bytes:Buffer}[]=[];
 async function collect(dir:string){
  for(const entry of await readdir(join(staged,dir),{withFileTypes:true})){
   const target=dir+entry.name;
   if(entry.isDirectory()){await collect(target+'/');continue;}
   if(!entry.isFile()||!allowed.some(prefix=>target.startsWith(prefix)))throw Error('Unexpected native OpenSpec output: '+target);
   if(target.startsWith('openspec/')&&!setup.needsRoot)continue;
   const host=setup.needsEntries.find(agent=>target.startsWith(agents[agent].skillDirectory+'/'));
   const match=target.match(/\/([^/]+)\/SKILL\.md$/);
   if(host&&match&&setup.entries?.[host]?.some(name=>unqualifiedSkillName(name)===match[1]))continue;
   if(await exists(await targetPath(root,target)))continue;
   files.push({target,bytes:await readFile(join(staged,target))});
  }
 }
 await collect('');
 // Each retry only adds files that are still absent, even after a partial write.
 for(const {target,bytes} of files){
  signal?.throwIfAborted();
  await atomicProjectWrite(root,target,bytes,0o644,true);
 }
}

export async function prepareOpenSpec(root:string,options:Pick<SetupOptions,'agents'|'backend'>,approved:OpenSpecSetup,
 dependencies:{stateRoot?:string;signal?:AbortSignal;recover?:boolean;write:(text:string)=>void}){
 const {stateRoot,signal,recover,write}=dependencies;
 const lock=await acquireLock(root,{stateRoot,recover});
 let stage:string|undefined;
 try{
  await assertNoUnknownWriters(root,lock.stateRoot);
  let setup=await inspectOpenSpec(root,options,signal);
  if(!setup.requirements.length)return setup;
  await assertRegistry(root,approved);
  const covered=(current:OpenSpecSetup)=>current.registry===approved.registry&&(current.cli||current.prefix===approved.prefix)
    && (!current.needsRoot||approved.needsRoot)&&current.needsEntries.every(agent=>approved.needsEntries.includes(agent));
  if(!setup.canPrepare||!covered(setup))return setup;
  await assertSupportedFileModes(root,[{target:'openspec/config.yaml',mode:0o644},...setup.needsEntries.flatMap(agent=>hostScopes(agent).map(scope=>({target:scope+'/probe',mode:0o644})))]);
  if(!setup.cli&&setup.prefix)await assertSupportedFileModes(setup.prefix,[{target:packageDirectory(openspecPackage)+'/package.json',mode:0o644},{target:windows?'openspec.cmd':'bin/openspec',mode:0o755}]);
  stage=await mkdtemp(join(lock.stateRoot,'openspec-'));
  if(!setup.cli){
   const installLock=await acquireLock(root,{stateRoot:lock.stateRoot,recover,resource:'openspec:'+setup.prefix});
   try{
    setup=await inspectOpenSpec(root,options,signal);
    await assertRegistry(root,approved);
    if(!setup.cli&&setup.prefix===approved.prefix&&setup.canPrepare&&covered(setup)){
     write('正在安装 OpenSpec CLI '+setup.recipe.version+' 到 '+setup.prefix+'\n');
     await installOpenSpec(root,setup,stage,signal);
    }
   }finally{await installLock.release();}
   setup=await inspectOpenSpec(root,options,signal);
  }
  if(setup.cli&&setup.cliVersion===setup.recipe.version&&setup.canPrepare&&setup.needsProject&&covered(setup)){
   await assertRegistry(root,approved);
   const staged=join(stage,'project');
   await mkdir(staged);
   write('正在准备 OpenSpec 项目入口\n');
   await writingCommand(setup.cli,openspecInitArgs(setup.needsEntries),staged,setup.path,signal,{XDG_CONFIG_HOME:join(stage,'config')});
   await addNativeFiles(root,staged,setup,signal);
  }
  return await inspectOpenSpec(root,options,signal);
 }finally{
  try{if(stage)await rm(stage,{recursive:true,force:true});}finally{await lock.release();}
 }
}
