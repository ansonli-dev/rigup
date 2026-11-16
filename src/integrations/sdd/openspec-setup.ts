import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {constants,createReadStream} from 'node:fs';
import {access,lstat,mkdir,mkdtemp,open,readdir,readFile,realpath,rm} from 'node:fs/promises';
import {homedir} from 'node:os';
import {basename,delimiter,dirname,isAbsolute,join} from 'node:path';
import {promisify} from 'node:util';
import {scanRepository} from '../../analyzer/repository.js';
import {acquireLock,defaultStateRoot} from '../../installer/lock.js';
import {interruptedInstallApplyId,interruptedSeedApplyId} from '../../installer/apply.js';
import {atomicProjectWrite} from '../../installer/manifest.js';
import {assertNoUnknownWriters} from '../../installer/operations.js';
import {targetPath} from '../../installer/ownership.js';
import {assertSupportedFileModes} from '../../installer/filesystem-modes.js';
import {essentialEnvironment,selectedNpmRegistry} from '../../runtime-inputs.js';
import {quoteShell} from '../../shell-command.js';
import {signature} from '../../generator/cache.js';
import {saveDurable} from '../../private-record.js';
import {normalizeNpmIntegrity} from '../../npm-integrity.mjs';
import {externalExecutable as executable,npmPathDirectories,withinPath as within} from '../../npm-command.mjs';
import type {Agent,SetupOptions} from '../../types.js';
import {agents} from '../agents/index.js';
import {assertNpmNode,boundedCommandOutput,defaultNpmRegistry,isStableNpmVersion,resolveNpmLatest,type NpmView,type ResolvedNpmPackage} from '../tools/npm-resolution.js';
import {startWindowsProcess} from '../tools/windows-process.mjs';
import {resolveSddBinding,unqualifiedSkillName} from './binding.js';
import {openspecInitArgs,openspecPackage,openspecPreparationCommand} from './openspec.js';

const exec=promisify(execFile);
const windows=process.platform==='win32';
const nodeName=windows?'node.exe':'node';
const packageDirectory=(name:string)=> (windows?'node_modules/':'lib/node_modules/')+name;
type Program={file:string;args?:string[];launcher?:string};
type OpenSpecOptions=Pick<SetupOptions,'agents'|'backend'>;
const npmFlags=['--ignore-scripts','--no-audit','--no-fund','--prefer-offline'];
const hostScopes=(agent:Agent)=>[agents[agent].skillDirectory,agents[agent].skillDirectory.replace(/\/skills$/,'/commands')];
const available=(path:string,mode:number)=>access(path,mode).then(()=>true,()=>false);
const exists=(path:string)=>lstat(path).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
// The portable launcher keeps its bundled Node available for Rigup operations.
function consumerPath(root:string){
 return npmPathDirectories(root,process.env.RIGUP_CONSUMER_PATH??process.env.PATH??process.env.Path??'');
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
 return {file:node,args:[canonical],launcher:join(directory,name+'.cmd')};
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

function commandEnvironment(path:string[],extraEnv?:NodeJS.ProcessEnv,inheritPrefix=false):NodeJS.ProcessEnv{
 const prefix=inheritPrefix?Object.fromEntries(Object.entries(process.env).filter(([name])=>/^npm_config_prefix$/i.test(name))):{};
 const env=essentialEnvironment();delete env.Path;
 return {...env,...prefix,PATH:path.join(delimiter),DO_NOT_TRACK:'1',OPENSPEC_TELEMETRY:'0',OPENSPEC_NO_UPDATE_CHECK:'1',...extraEnv};
}

async function command(program:Program,args:string[],cwd:string,path:string[],signal?:AbortSignal,env?:NodeJS.ProcessEnv){
 return exec(program.file,[...(program.args??[]),...args],{cwd,signal,timeout:20_000,maxBuffer:256_000,env:commandEnvironment(path,env,true)});
}

async function writingCommand(program:Program,args:string[],cwd:string,path:string[],signal?:AbortSignal,extraEnv?:NodeJS.ProcessEnv,timeout=20_000){
 const argv=[...(program.args??[]),...args];
 const env=commandEnvironment(path,extraEnv);
 if(!windows){
  try{await boundedCommandOutput({executable:program.file,args:argv,env},cwd,signal,timeout);}
  catch{signal?.throwIfAborted();throw Error('OpenSpec command failed; inspect its installation or retry the approved preparation.');}
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

async function userNode(root:string,path:string[],signal?:AbortSignal){
 const node=await executable(nodeName,root,path);
 if(!node)return;
 const version=(await command({file:node},['--version'],homedir(),path,signal).catch(()=>undefined))?.stdout.trim();
 if(version&&/^v\d+\.\d+\.\d+$/.test(version))return {file:node,version:version.slice(1)};
}

async function programIdentity(program:Program,root:string,path:string[]):Promise<string>{
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

async function assertCliIdentity(program:Program,root:string,path:string[],expected:string){
 if(await programIdentity(program,root,path).catch(()=>undefined)!==expected)throw Error('OpenSpec CLI changed after approval; prepare it again');
}

async function listOpenSpec(program:Program,root:string,path:string[],signal?:AbortSignal,env?:NodeJS.ProcessEnv){
 const result=await command(program,['list','--json'],root,path,signal,env).catch(error=>error.code===1?{stdout:error.stdout as string}:undefined);
 return JSON.parse(result?.stdout??'');
}

export async function inspectOpenSpec(root:string,options:OpenSpecOptions,signal?:AbortSignal,expectedCliIdentity?:string){
 root=await realpath(root);
 const path=await consumerPath(root);
 const [profile,discovered]=await Promise.all([
  scanRepository(root,{agents:options.agents,backend:options.backend,sdd:'openspec',scope:options.agents.flatMap(hostScopes)}),
  findProgram('openspec',root,path).catch(()=>null)
 ]);
 const cli=discovered??undefined;
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
 const cliIdentity=cli&&await programIdentity(cli,root,path).catch(()=>undefined);
 if(expectedCliIdentity&&cliIdentity!==expectedCliIdentity)throw Error('OpenSpec CLI changed after approval; prepare it again');
 if(cli&&!cliIdentity)problems.push('The existing OpenSpec launcher identity could not be verified');
 let cliVersion:string|undefined;
 if(cli&&cliIdentity){
  const version=(await command(cli,['--version'],root,path,signal).catch(()=>undefined))?.stdout.trim();
  if(version&&/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)){
   cliVersion=version;
   await assertCliIdentity(cli,root,path,cliIdentity);
   try{
    const list=await listOpenSpec(cli,root,path,signal);
    if(list.root===null&&(!list.status?.length||list.status.some((status:{code:string})=>['no_openspec_root','no_root_with_registered_stores'].includes(status.code))))needsRoot=true;
    else if(typeof list.root?.path==='string'&&isAbsolute(list.root.path)&&
            (list.root.source==='declared'||await realpath(list.root.path).catch(()=>undefined)===root))needsRoot=false;
    else if((list.root?.source==='nearest'||list.root?.source==='global_default')&&needsRoot)needsRoot=true;
    else problems.push('OpenSpec project root could not be verified');
   }catch{problems.push('OpenSpec CLI did not return a usable project status');}
   await assertCliIdentity(cli,root,path,cliIdentity);
  }else problems.push('The existing openspec command did not start successfully. Repair its installation or put a working CLI first on PATH.');
 }
 const needsProject=needsRoot||needsEntries.length>0;
 const [npm,node]=cli?[undefined,undefined]:await Promise.all([findProgram('npm',root,path).catch(()=>undefined),userNode(root,path,signal)]);
 const prefix=npm&&node?await npmPrefix(npm,root,path,signal):undefined;
 const installTargets=windows?['openspec','openspec.exe','openspec.cmd','openspec.ps1']:['bin/openspec'];
 const installAvailable=!cli&&!!prefix&&!(await Promise.all([...installTargets,packageDirectory(openspecPackage)].map(target=>exists(join(prefix,target))))).some(Boolean);
 const requirements=[
  ...(!cli?['OpenSpec CLI is missing from PATH']:[]),
  ...(needsRoot?['OpenSpec project root is missing']:[]),
  ...needsEntries.map(host=>host+': OpenSpec workflow entries are missing'),
  ...problems,
  ...(!cli&&!node?['OpenSpec needs a working Node.js on the user PATH']:[]),
  ...(!cli&&!installAvailable?['Automatic installation requires npm and a writable user bin directory on PATH']:[]),
 ];
 const canPrepare=!problems.length&&(!!cliVersion||installAvailable);
 const userBin=!windows&&!cli&&npm&&node&&!prefix
  ?await realpath(homedir()).then(home=>targetPath(home,'.local/bin')).catch(()=>undefined):undefined;
 const steps=[
  ...(!cli&&npm&&node&&!prefix&&userBin&&!within(root,userBin)?[
   'mkdir -p '+quoteShell(userBin),'export PATH='+quoteShell(userBin)+':"$PATH"'
  ]:[]),
  ...((!cli||needsProject)&&!problems.length?[openspecPreparationCommand(root,options.agents)]:[])
 ];
 return {root,cli,cliVersion,cliIdentity,npm,node,prefix,path,needsProject,needsRoot,needsEntries,requirements,canPrepare,steps,profile};
}
export type OpenSpecInspection=Awaited<ReturnType<typeof inspectOpenSpec>>;
type OpenSpecScope={root:string;agents:Agent[];needsRoot:boolean;needsEntries:Agent[]};
export type OpenSpecPreparation=OpenSpecScope&({kind:'existing';cliIdentity:string;cliVersion:string}|{kind:'install';prefix:string;prefixIdentity:string;npmIdentity:string;install:ResolvedNpmPackage});

async function prefixIdentity(prefix:string){
 const stat=await lstat(prefix,{bigint:true});
 if(!stat.isDirectory()||await realpath(prefix)!==prefix)throw Error('OpenSpec npm prefix changed after approval');
 return stat.dev+':'+stat.ino;
}

export async function planOpenSpecPreparation(root:string,options:OpenSpecOptions,input:{stateRoot?:string;signal?:AbortSignal;view?:NpmView},inspection?:OpenSpecInspection):Promise<{inspection:OpenSpecInspection;approval?:OpenSpecPreparation}>{
 const setup=inspection??await inspectOpenSpec(root,options,input.signal);
 input.signal?.throwIfAborted();
 if(!setup.canPrepare||!setup.requirements.length)return {inspection:setup};
 const scope:OpenSpecScope={root:setup.root,agents:[...options.agents],needsRoot:setup.needsRoot,needsEntries:[...setup.needsEntries]};
 if(setup.cli&&setup.cliIdentity&&setup.cliVersion)return {inspection:setup,approval:{...scope,kind:'existing',cliIdentity:setup.cliIdentity,cliVersion:setup.cliVersion}};
 if(!setup.npm||!setup.node||!setup.prefix)return {inspection:setup};
 try{
  const npm=setup.npm;
  const approvedPrefix=await prefixIdentity(setup.prefix),npmIdentity=await programIdentity(npm,setup.root,setup.path);
  const install=await resolveNpmLatest(openspecPackage,{root:setup.root,stateRoot:input.stateRoot??defaultStateRoot(),
   signal:input.signal,registry:await selectedNpmRegistry(setup.root),nodeVersion:setup.node.version,
   view:input.view??((args,cwd,signal)=>boundedCommandOutput({executable:npm.file,args:[...(npm.args??[]),...args],env:commandEnvironment(setup.path)},cwd,signal))});
  return {inspection:setup,approval:{...scope,kind:'install',prefix:setup.prefix,prefixIdentity:approvedPrefix,npmIdentity,install}};
 }catch(error){
  input.signal?.throwIfAborted();
  return {inspection:{...setup,requirements:[...setup.requirements,(error as Error).message],canPrepare:false}};
 }
}

export function reportOpenSpecPending(setup:OpenSpecInspection,resumeCommand:string,write:(text:string)=>void,report?:(value:Record<string,unknown>)=>void){
 const steps=setup.steps.filter(step=>step!==resumeCommand);
 const nextCommand=steps.length?[...steps,resumeCommand].join(' && '):null;
 report?.({phase:'preflight',installStatus:'pending',executable:false,pending:setup.requirements,requiredInput:setup.requirements,nextCommand,resumeCommand});
 write('补齐 OpenSpec 后继续原设置：\n'+(nextCommand??resumeCommand)+'\n');
}

type InstallApproval=Extract<OpenSpecPreparation,{kind:'install'}>;
const scopeCovered=(prior:Pick<OpenSpecScope,'needsRoot'|'needsEntries'>,setup:OpenSpecInspection)=>(!setup.needsRoot||prior.needsRoot)&&setup.needsEntries.every(agent=>prior.needsEntries.includes(agent));

async function assertRegistry(root:string,approval:InstallApproval){
 if((await selectedNpmRegistry(root)??defaultNpmRegistry)!==approval.install.registry)throw Error('Npm registry selection changed after review; review OpenSpec preparation again.');
}

async function approvedNpm(setup:OpenSpecInspection,approval:InstallApproval){
 if(!setup.npm||!setup.node||!setup.canPrepare||setup.prefix!==approval.prefix||
  await prefixIdentity(setup.prefix)!==approval.prefixIdentity||
  await programIdentity(setup.npm,setup.root,setup.path)!==approval.npmIdentity)
  throw Error('OpenSpec installation scope or npm launcher changed after approval; prepare it again');
 assertNpmNode(openspecPackage,approval.install.version,approval.install.enginesNode,setup.node.version);
 return setup.npm;
}

async function verifyArchive(path:string,integrity:string,signal?:AbortSignal){
 const normalized=normalizeNpmIntegrity(integrity);
 if(!normalized)throw Error('Approved OpenSpec integrity is invalid');
 const digests=normalized.split(' '),algorithm=digests[0].split('-')[0],hash=createHash(algorithm);
 for await(const chunk of createReadStream(path,{signal}))hash.update(chunk);
 if(!digests.includes(algorithm+'-'+hash.digest('base64')))throw Error('OpenSpec package integrity mismatch');
}

async function installedLauncher(root:string,approval:InstallApproval,path:string[]){
 const prefix=approval.prefix;
 if(await prefixIdentity(prefix)!==approval.prefixIdentity)throw Error('OpenSpec npm prefix changed during installation');
 const packageRoot=await targetPath(prefix,packageDirectory(openspecPackage));
 const manifest=JSON.parse(await readFile(await targetPath(packageRoot,'package.json'),'utf8'));
 if(manifest.name!==openspecPackage||manifest.version!==approval.install.version)throw Error('Installed OpenSpec package differs from its approval');
 const bin=typeof manifest.bin==='string'?manifest.bin:manifest.bin?.openspec;
 if(typeof bin!=='string'||!bin)throw Error('Installed OpenSpec entry is missing');
 const entry=await targetPath(packageRoot,bin.replace(/^\.\//,''));
 const launcher=join(prefix,windows?'openspec.cmd':'bin/openspec');
 if(!await available(launcher,constants.X_OK)||!(await lstat(entry)).isFile())throw Error('Installed OpenSpec launcher is missing or unusable');
 const program=windows?await windowsNpmCommand('openspec',prefix,root,path):{file:launcher};
 if(windows?program.args?.[0]!==await realpath(entry):await realpath(launcher)!==await realpath(entry))throw Error('Installed OpenSpec launcher differs from the approved package');
 return programIdentity(program,root,path);
}

export class OpenSpecReceiptError extends Error {}

async function installOpenSpec(root:string,options:OpenSpecOptions,approval:InstallApproval,setup:OpenSpecInspection,stage:string,stateRoot:string,signal?:AbortSignal){
 const {version,registry,packageIntegrity}=approval.install;
 if(!isStableNpmVersion(version)||!registry)throw Error('OpenSpec approval must contain an exact version and registry');
 const npm=await approvedNpm(setup,approval);
 const archive='fission-ai-openspec-'+version+'.tgz';
 const registryFlags=['--registry',registry,'--userconfig',join(stage,'.npmrc.user'),'--globalconfig',join(stage,'.npmrc.global'),'--cache',join(stage,'.npm-cache')];
 await assertRegistry(root,approval);
 await writingCommand(npm,['pack','--ignore-scripts','--prefer-offline',...registryFlags,'--pack-destination',stage,openspecPackage+'@'+version],stage,setup.path,signal,undefined,120_000);
 const tarball=await targetPath(stage,archive);
 await verifyArchive(tarball,packageIntegrity,signal);

 const current=await inspectOpenSpec(root,options,signal);
 if(!current.requirements.length)return current;
 if(!scopeCovered(approval,current))throw Error('OpenSpec preparation scope changed after approval; prepare it again');
 const installNpm=await approvedNpm(current,approval);
 await assertRegistry(root,approval);
 signal?.throwIfAborted();
 await writingCommand(installNpm,['install','--global','--prefix',approval.prefix,...npmFlags,...registryFlags,tarball],stage,current.path,signal,undefined,120_000);
 const identity=await installedLauncher(root,approval,current.path);
 const installed=await inspectOpenSpec(root,options,signal,identity);
 if(installed.cliVersion!==version)throw Error('Installed OpenSpec CLI does not report the approved version');
 try{
  await saveDurable(join(stateRoot,'openspec-'+signature({prefix:approval.prefix,name:openspecPackage})+'.json'),
   JSON.stringify({name:openspecPackage,prefix:approval.prefix,version,packageIntegrity,registry}));
 }catch{throw new OpenSpecReceiptError('OpenSpec CLI '+version+' was installed and verified, but its receipt could not be saved');}
 return installed;
}

async function publishableNativeFiles(root:string,staged:string,generatedFor:Agent[],setup:OpenSpecInspection,options:OpenSpecOptions){
 const allowed=['openspec',...generatedFor.flatMap(hostScopes)].map(scope=>scope+'/');
 const needed=[...(setup.needsRoot?['openspec']:[]),...setup.needsEntries.flatMap(hostScopes)].map(scope=>scope+'/');
 const files:{target:string;bytes:Buffer}[]=[];
 async function collect(dir:string){
  for(const entry of await readdir(join(staged,dir),{withFileTypes:true})){
   const target=dir+entry.name;
   if(entry.isDirectory()){await collect(target+'/');continue;}
   if(!entry.isFile()||!allowed.some(prefix=>target.startsWith(prefix)))throw Error('Unexpected native OpenSpec output: '+target);
   if(!needed.some(prefix=>target.startsWith(prefix)))continue;
   const host=setup.needsEntries.find(agent=>target.startsWith(agents[agent].skillDirectory+'/'));
   const match=target.match(/\/([^/]+)\/SKILL\.md$/);
   if(host&&match&&setup.profile.nativeEntries?.[host]?.some(name=>unqualifiedSkillName(name)===match[1]))continue;
   if(await exists(await targetPath(root,target)))continue;
   files.push({target,bytes:await readFile(join(staged,target))});
  }
 }
 await collect('');
 const publishable=new Set(files.map(file=>file.target));
 if(setup.needsRoot&&!['openspec/config.yaml','openspec/config.yml'].some(path=>publishable.has(path)))
  throw Error('OpenSpec did not generate a publishable project root');
 const stagedProfile=await scanRepository(staged,{...options,sdd:'openspec',scope:options.agents.flatMap(hostScopes)},{home:staged,env:{}});
 for(const host of options.agents){
  const generated=(stagedProfile.skillSources?.[host]??[]).filter(source=>publishable.has(source.identity));
  resolveSddBinding('openspec',host,[...setup.profile.nativeEntries?.[host]??[],...generated.map(source=>source.name)],
   [...setup.profile.skillSources?.[host]??[],...generated],[...setup.profile.files,...publishable]);
 }
 return files;
}

export async function prepareOpenSpec(root:string,options:OpenSpecOptions,approval:OpenSpecPreparation,
 dependencies:{stateRoot?:string;signal?:AbortSignal;recover?:boolean;write:(text:string)=>void}){
 const {stateRoot,signal,recover,write}=dependencies;
 const lock=await acquireLock(root,{stateRoot,recover});
 let stage:string|undefined;
 try{
  root=lock.root;
  if(approval.root!==root||signature(approval.agents)!==signature(options.agents))throw Error('OpenSpec approval belongs to another project or host selection');
  if(await interruptedSeedApplyId(root,lock.stateRoot)||await interruptedInstallApplyId(root,lock.stateRoot))
   throw Error('Resume the original approval with rigup update '+quoteShell(root)+' --resume --review');
  await assertNoUnknownWriters(root,lock.stateRoot);
  const approvedCli=approval.kind==='existing'?approval.cliIdentity:undefined;
  let setup=await inspectOpenSpec(root,options,signal,approvedCli);
  if(approval.kind==='existing'&&setup.cliVersion!==approval.cliVersion)throw Error('OpenSpec CLI changed after approval; prepare it again');
  if(!setup.requirements.length)return setup;
  if(!setup.canPrepare||!scopeCovered(approval,setup))throw Error('OpenSpec preparation scope changed after approval; prepare it again');
  if(setup.needsProject){
   const targets=[...(setup.needsRoot?['openspec/config.yaml']:[]),...setup.needsEntries.map(agent=>agents[agent].skillDirectory+'/openspec-propose/SKILL.md')];
   await assertSupportedFileModes(root,targets.map(target=>({target,mode:0o644})));
  }
  if(approval.kind==='install'){
   const installLock=await acquireLock(root,{stateRoot:lock.stateRoot,recover,resource:'openspec:'+approval.prefix});
   try{
    setup=await inspectOpenSpec(root,options,signal);
    if(!setup.requirements.length)return setup;
    if(!scopeCovered(approval,setup))throw Error('OpenSpec preparation scope changed after approval; prepare it again');
    await approvedNpm(setup,approval);
    await assertSupportedFileModes(approval.prefix,[{target:packageDirectory(openspecPackage)+'/package.json',mode:0o644},{target:windows?'openspec.cmd':'bin/openspec',mode:0o755}]);
    stage=await mkdtemp(join(lock.stateRoot,'openspec-'));
    write('正在安装 OpenSpec CLI '+approval.install.version+' 到 '+approval.prefix+'\n');
    setup=await installOpenSpec(root,options,approval,setup,stage,lock.stateRoot,signal);
   }finally{await installLock.release();}
  }
  if(!setup.requirements.length)return setup;
  if(!setup.cli||!setup.cliIdentity||!setup.canPrepare||!scopeCovered(approval,setup))throw Error('OpenSpec preparation scope changed after approval; prepare it again');
  const {cli,cliIdentity}=setup;
  stage??=await mkdtemp(join(lock.stateRoot,'openspec-'));
  const staged=join(stage,'project');await mkdir(staged);
  const env={XDG_CONFIG_HOME:join(stage,'config')};
  await assertCliIdentity(cli,root,setup.path,cliIdentity);
  await writingCommand(cli,openspecInitArgs(setup.needsEntries),staged,setup.path,signal,env);
  if(setup.needsRoot){
   await assertCliIdentity(cli,root,setup.path,cliIdentity);
   const list=await listOpenSpec(cli,staged,setup.path,signal,env).catch(()=>undefined);
   if(typeof list?.root?.path!=='string'||await realpath(list.root.path).catch(()=>undefined)!==staged)throw Error('OpenSpec did not recognize the staged project root');
  }
  const current=await inspectOpenSpec(root,options,signal,cliIdentity);
  if(!current.canPrepare||!scopeCovered(setup,current)||current.cliVersion!==setup.cliVersion)throw Error('OpenSpec preparation scope changed after approval; prepare it again');
  if(!current.requirements.length)return current;
  const files=await publishableNativeFiles(root,staged,setup.needsEntries,current,options);
  await assertCliIdentity(cli,root,current.path,cliIdentity);
  // Each retry only adds files that are still absent, even after a partial write.
  for(const {target,bytes} of files){
   signal?.throwIfAborted();
   await atomicProjectWrite(root,target,bytes,0o644,true);
  }
  return await inspectOpenSpec(root,options,signal,cliIdentity);
 }finally{
  try{if(stage)await rm(stage,{recursive:true,force:true});}finally{await lock.release();}
 }
}
