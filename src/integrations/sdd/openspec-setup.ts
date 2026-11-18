import {globalNpmInstallOperation,managedGlobalNpmProblem,runGlobalNpmInstall,type GlobalNpmApproval} from '../tools/global-npm.js';
import {packageDirectory,exists,consumerPath,findProgram,commandEnvironment,command,npmPrefix,userNode,programIdentity,prefixIdentity,type Program as GlobalProgram} from '../tools/global-npm-runtime.js';
import {lstat,mkdir,mkdtemp,readdir,readFile,realpath,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {homedir} from 'node:os';
import {isAbsolute,join} from 'node:path';
import {scanNativeEntries} from '../../analyzer/repository.js';
import {acquireLock,defaultStateRoot} from '../../installer/lock.js';
import {interruptedInstallApplyId,interruptedSeedApplyId} from '../../installer/apply.js';
import {atomicProjectWrite} from '../../installer/manifest.js';
import {assertNoUnknownWriters} from '../../installer/operations.js';
import {targetPath} from '../../installer/ownership.js';
import {selectedNpmRegistry} from '../../runtime-inputs.js';
import {quoteShell} from '../../shell-command.js';
import {signature} from '../../generator/cache.js';
import {saveDurable} from '../../private-record.js';
import {withinPath as within} from '../../npm-command.mjs';
import type {Agent,SetupOptions} from '../../types.js';
import {agents} from '../agents/index.js';
import {assertNpmNode,boundedCommandOutput,defaultNpmRegistry,isStableNpmVersion,resolveNpmLatest,resolveProjectNpm,type NpmView,type ResolvedNpmPackage} from '../tools/npm-resolution.js';
import {startWindowsProcess} from '../tools/windows-process.mjs';
import {resolveSddBinding,unqualifiedSkillName} from './binding.js';
import {openspecInitArgs,openspecPackage,openspecPreparationCommand,type OpenSpecInstallScope} from './openspec.js';
import {installProjectOpenSpec,readOpenSpecPreparation,saveOpenSpecPreparation,verifiedProjectOpenSpec,type OpenSpecPreparationRecord} from './openspec-project.js';
import {assertEmptyNativeScope} from '../tools/initialization.js';
import {toolPackage} from '../tools/recipes.js';

const windows=process.platform==='win32';
type Program=GlobalProgram&{source?:'project'};
type OpenSpecInspectionSettings={scope?:OpenSpecInstallScope;stateRoot?:string};
const projectPrefix=toolPackage('openspec').prefix;
type OpenSpecOptions=Pick<SetupOptions,'agents'|'backend'>;
const hostScopes=(agent:Agent)=>[agents[agent].skillDirectory,agents[agent].skillDirectory.replace(/\/skills$/,'/commands')];
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

async function cliProgramIdentity(program:Program,root:string,path:string[],stateRoot?:string){
 return program.source==='project'?(await verifiedProjectOpenSpec(root,stateRoot))?.identity:programIdentity(program,root,path);
}

async function assertCliIdentity(program:Program,root:string,path:string[],expected:string,stateRoot?:string){
 if(await cliProgramIdentity(program,root,path,stateRoot).catch(()=>undefined)!==expected)throw Error('OpenSpec CLI changed after approval; prepare it again');
}

async function listOpenSpec(program:Program,root:string,path:string[],signal?:AbortSignal,env?:NodeJS.ProcessEnv){
 const result=await command(program,['list','--json'],root,path,signal,env).catch(error=>error.code===1?{stdout:error.stdout as string}:undefined);
 return JSON.parse(result?.stdout??'');
}

export interface OpenSpecRuntimeIdentity { cliIdentity:string; rootIdentity:string; scope:OpenSpecInstallScope }

async function rootIdentity(path:string,source:string,project:string){
 const canonical=await realpath(path);
 const identity=await lstat(canonical,{bigint:true});
 if(!identity.isDirectory())throw Error('OpenSpec root is not a directory');
 const configs=[];
 for(const name of ['openspec/config.yaml','openspec/config.yml',...(canonical===project?[]:['config.yaml','config.yml'])]){
  const config=await targetPath(canonical,name);
  if(!await exists(config))continue;
  const data=await lstat(config);
  if(!data.isFile()||data.size>256_000)throw Error('OpenSpec config cannot be verified');
  configs.push({name,sha256:createHash('sha256').update(await readFile(config)).digest('hex')});
 }
 return signature({canonical,source,device:String(identity.dev),inode:String(identity.ino),configs});
}

export async function inspectOpenSpec(root:string,options:OpenSpecOptions,signal?:AbortSignal,expectedCliIdentity?:string,settings:OpenSpecInspectionSettings={}){
 root=await realpath(root);
 const {scope='global',stateRoot}=settings;
 const path=await consumerPath(root);
 const [profile,project,external]=await Promise.all([
  scanNativeEntries(root,{agents:options.agents,backend:options.backend,sdd:'openspec',scope:options.agents.flatMap(hostScopes)}),
  verifiedProjectOpenSpec(root,stateRoot).catch(error=>({problem:(error as Error).message})),
  findProgram('openspec',root,path).catch(()=>null)
 ]);
 const needsEntries:Agent[]=[],problems:string[]=[];
 if(project&&'problem' in project)problems.push(project.problem);
 if(!project&&external===null)problems.push('The existing openspec command could not be resolved. Repair its installation or put a working CLI first on PATH.');
 const externalProblem=!project&&external?await managedGlobalNpmProblem('openspec',external.launcher??external.file,stateRoot):undefined;
 if(externalProblem)problems.push(externalProblem);
 const cli:Program|undefined=project?('file' in project?project:undefined):externalProblem?undefined:external??undefined;
 for(const agent of options.agents){
  try{resolveSddBinding('openspec',agent,profile.nativeEntries?.[agent]??[],profile.skillSources?.[agent]??[],profile.files);}
  catch(error){
   const reason=(error as Error).message;
   if(reason.startsWith('missing native entry:'))needsEntries.push(agent);
   else problems.push(agent+': '+reason);
  }
 }
 let needsRoot=!await exists(join(root,'openspec/config.yaml'))&&!await exists(join(root,'openspec/config.yml'));
 let verifiedRoot:string|undefined;
 const cliIdentity=project&&'identity' in project?project.identity:cli&&await programIdentity(cli,root,path).catch(()=>undefined);
 if(expectedCliIdentity&&cliIdentity!==expectedCliIdentity)throw Error('OpenSpec CLI changed after approval; prepare it again');
 if(cli&&!cliIdentity)problems.push('The existing OpenSpec launcher identity could not be verified');
 let cliVersion:string|undefined;
 if(cli&&cliIdentity){
  const version=(await command(cli,['--version'],root,path,signal).catch(()=>undefined))?.stdout.trim();
  if(version&&/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)){
   cliVersion=version;
   await assertCliIdentity(cli,root,path,cliIdentity,stateRoot);
   try{
    const list=await listOpenSpec(cli,root,path,signal);
    if(list.root===null&&(!list.status?.length||list.status.some((status:{code:string})=>['no_openspec_root','no_root_with_registered_stores'].includes(status.code))))needsRoot=true;
    else if(typeof list.root?.path==='string'&&isAbsolute(list.root.path)&&
            (list.root.source==='declared'||await realpath(list.root.path).catch(()=>undefined)===root)){
      verifiedRoot=await rootIdentity(list.root.path,list.root.source,root);needsRoot=false;
    }
    else if((list.root?.source==='nearest'||list.root?.source==='global_default')&&needsRoot)needsRoot=true;
    else problems.push('OpenSpec project root could not be verified');
   }catch{problems.push('OpenSpec CLI did not return a usable project status');}
   await assertCliIdentity(cli,root,path,cliIdentity,stateRoot);
  }else problems.push('The existing openspec command did not start successfully. Repair its installation or put a working CLI first on PATH.');
 }
 const needsProject=needsRoot||needsEntries.length>0;
 const npm=cli?undefined:await findProgram('npm',root,path).catch(()=>undefined);
 const prefix=npm?await npmPrefix(npm,root,path,signal):undefined;
 // A Windows npm shim uses Node beside the launcher before searching PATH.
 const node=cli?undefined:await userNode(root,windows&&prefix?[prefix,...path]:path,signal);
 const installTargets=windows?['openspec','openspec.exe','openspec.cmd','openspec.ps1']:['bin/openspec'];
 const installAvailable=!cli&&!!node&&!!prefix&&!(await Promise.all([...installTargets,packageDirectory(openspecPackage)].map(target=>exists(join(prefix,target))))).some(Boolean);
 const projectAvailable=!cli&&!problems.length&&await Promise.all([
  assertEmptyNativeScope(root,projectPrefix),resolveProjectNpm(root,[]),
 ]).then(()=>true,()=>false);
 const requirements=[
  ...(!cli?[scope==='global'?'OpenSpec CLI is missing from PATH':'OpenSpec CLI is missing']:[]),
  ...(needsRoot?['OpenSpec project root is missing']:[]),
  ...needsEntries.map(host=>host+': OpenSpec workflow entries are missing'),
  ...problems,
  ...(!cli&&scope==='global'&&!node?['OpenSpec needs a working Node.js on the user PATH']:[]),
  ...(!cli&&scope==='global'&&!installAvailable?['Automatic installation requires npm and a writable user bin directory on PATH']:[]),
  ...(!cli&&scope==='project'&&!projectAvailable?['OpenSpec project installation requires a usable npm and an empty, untracked '+projectPrefix+' scope']:[]),
 ];
 const canPrepare=!problems.length&&(!!cliVersion||(scope==='project'?projectAvailable:installAvailable));
 const userBin=scope==='global'&&!windows&&!cli&&npm&&node&&!prefix
  ?await realpath(homedir()).then(home=>targetPath(home,'.local/bin')).catch(()=>undefined):undefined;
 const steps=[
  ...(!cli&&npm&&node&&!prefix&&userBin&&!within(root,userBin)?[
   'mkdir -p '+quoteShell(userBin),'export PATH='+quoteShell(userBin)+':"$PATH"'
  ]:[]),
  ...((!cli||needsProject)&&!problems.length?[openspecPreparationCommand(root,options.agents,scope)]:[])
 ];
 const runtime:OpenSpecRuntimeIdentity|undefined=!requirements.length&&cliIdentity&&verifiedRoot?{cliIdentity,rootIdentity:verifiedRoot,scope:cli?.source==='project'?'project':'global'}:undefined;
 return {root,cli,cliVersion,cliIdentity,npm,node,prefix,path,needsProject,needsRoot,needsEntries,requirements,canPrepare,steps,profile,scope,stateRoot,projectAvailable,globalAvailable:installAvailable,runtime};
}
export async function assertOpenSpecRuntime(root:string,options:OpenSpecOptions,approved:OpenSpecRuntimeIdentity,stateRoot?:string){
 const state=await readOpenSpecPreparation(root,stateRoot);
 if(state&&!state.complete)throw Error('Resume the original OpenSpec preparation before applying');
 const setup=await inspectOpenSpec(root,options,undefined,approved.cliIdentity,{scope:approved.scope,stateRoot});
 if(!setup.runtime||signature(setup.runtime)!==signature(approved))throw Error('OpenSpec CLI or native root changed after approval; review again');
}

export type OpenSpecInspection=Awaited<ReturnType<typeof inspectOpenSpec>>;
type OpenSpecScope={root:string;agents:Agent[];needsRoot:boolean;needsEntries:Agent[]};
export type OpenSpecPreparation=OpenSpecScope&({kind:'existing';scope:OpenSpecInstallScope;cliIdentity:string;cliVersion:string}|{kind:'install';prefix:string;prefixIdentity:string;npmIdentity:string;install:ResolvedNpmPackage}|{kind:'project-install';prefix:string;install:ResolvedNpmPackage});
export const preparationScope=(approval:OpenSpecPreparation):OpenSpecInstallScope=>
 approval.kind==='existing'?approval.scope:approval.kind==='install'?'global':'project';

export async function interruptedOpenSpecPreparation(root:string,stateRoot?:string){
 const record=await readOpenSpecPreparation(root,stateRoot);
 if(!record||record.complete)return;
 return {requirements:['Resume the original OpenSpec preparation.'],
  nextCommand:openspecPreparationCommand(root,record.approval.agents,preparationScope(record.approval))+' --resume'};
}

export async function inspectOpenSpecForSetup(root:string,options:OpenSpecOptions,stateRoot?:string,signal?:AbortSignal){
 const project=await inspectOpenSpec(root,options,signal,undefined,{scope:'project',stateRoot});
 return !project.cli&&!project.projectAvailable&&project.globalAvailable
  ?inspectOpenSpec(root,options,signal,undefined,{scope:'global',stateRoot}):project;
}

export function openSpecProjectScopes(scope:Pick<OpenSpecScope,'needsRoot'|'needsEntries'>):string[]{
 return [...(scope.needsRoot?['openspec']:[]),...scope.needsEntries.flatMap(hostScopes)].map(path=>path+'/');
}

export async function planOpenSpecPreparation(root:string,options:OpenSpecOptions,input:{stateRoot?:string;signal?:AbortSignal;view?:NpmView},inspection?:OpenSpecInspection):Promise<{inspection:OpenSpecInspection;approval?:OpenSpecPreparation}>{
 const setup=inspection??await inspectOpenSpec(root,options,input.signal,undefined,{stateRoot:input.stateRoot});
 input.signal?.throwIfAborted();
 if(!setup.canPrepare||!setup.requirements.length)return {inspection:setup};
 const scope:OpenSpecScope={root:setup.root,agents:[...options.agents],needsRoot:setup.needsRoot,needsEntries:[...setup.needsEntries]};
 if(setup.cli&&setup.cliIdentity&&setup.cliVersion)return {inspection:setup,approval:{...scope,kind:'existing',scope:setup.scope,cliIdentity:setup.cliIdentity,cliVersion:setup.cliVersion}};
 if(setup.scope==='project')try{
  const install=await resolveNpmLatest(openspecPackage,{root:setup.root,stateRoot:input.stateRoot??defaultStateRoot(),signal:input.signal,registry:await selectedNpmRegistry(setup.root),nodeVersion:process.versions.node,view:input.view});
  return {inspection:setup,approval:{...scope,kind:'project-install',prefix:join(setup.root,projectPrefix),install}};
 }catch(error){
  input.signal?.throwIfAborted();
  return {inspection:{...setup,requirements:[...setup.requirements,(error as Error).message],canPrepare:false}};
 }
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

async function approvedNpm(setup:OpenSpecInspection,approval:InstallApproval){
 if(!setup.npm||!setup.node||!setup.canPrepare||setup.prefix!==approval.prefix||
  await prefixIdentity(setup.prefix)!==approval.prefixIdentity||
  await programIdentity(setup.npm,setup.root,setup.path)!==approval.npmIdentity)
  throw Error('OpenSpec installation scope or npm launcher changed after approval; prepare it again');
 assertNpmNode(openspecPackage,approval.install.version,approval.install.enginesNode,setup.node.version);
 return setup.npm;
}

export class OpenSpecReceiptError extends Error {}

async function installOpenSpec(root:string,options:OpenSpecOptions,approval:InstallApproval,stateRoot:string,signal?:AbortSignal,recover?:boolean){
 const global:GlobalNpmApproval={root,id:'openspec',name:openspecPackage,bin:'openspec',prefix:approval.prefix,prefixIdentity:approval.prefixIdentity,npmIdentity:approval.npmIdentity,install:approval.install};
 const outcome=await runGlobalNpmInstall(globalNpmInstallOperation(global),{stateRoot,signal,recover,authorizationRef:signature(approval),beforeInstall:async()=>{
  const current=await inspectOpenSpec(root,options,signal,undefined,{scope:'global',stateRoot});
  if(!scopeCovered(approval,current))throw Error('OpenSpec preparation scope changed after approval; prepare it again');
  try{await approvedNpm(current,approval);}
  catch{throw Error('OpenSpec installation scope or npm launcher changed after approval; prepare it again');}
 }});
 if(outcome.status!=='done')throw Error(outcome.message);
 const installed=await inspectOpenSpec(root,options,signal,outcome.globalReceipt!.launcherIdentity,{scope:'global',stateRoot});
 const {version,registry,packageIntegrity}=approval.install;
 if(installed.cliVersion!==version)throw Error('Installed OpenSpec CLI does not report the approved version');
 try{
  await saveDurable(join(stateRoot,'openspec-'+signature({prefix:approval.prefix,name:openspecPackage})+'.json'),
   JSON.stringify({name:openspecPackage,prefix:approval.prefix,version,packageIntegrity,registry}));
 }catch{throw new OpenSpecReceiptError('OpenSpec CLI '+version+' was installed and verified, but its receipt could not be saved');}
 return {inspection:installed,installed:true};
}

async function publishableNativeFiles(root:string,staged:string,generatedFor:Agent[],setup:OpenSpecInspection,options:OpenSpecOptions){
 const allowed=['openspec',...generatedFor.flatMap(hostScopes)].map(scope=>scope+'/');
 const needed=openSpecProjectScopes(setup);
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
 const stagedProfile=await scanNativeEntries(staged,{...options,sdd:'openspec',scope:options.agents.flatMap(hostScopes)},{home:staged,env:{}});
 for(const host of options.agents){
  const generated=(stagedProfile.skillSources?.[host]??[]).filter(source=>publishable.has(source.identity));
  resolveSddBinding('openspec',host,[...setup.profile.nativeEntries?.[host]??[],...generated.map(source=>source.name)],
   [...setup.profile.skillSources?.[host]??[],...generated],[...setup.profile.files,...publishable]);
 }
 return files;
}

export async function prepareOpenSpec(root:string,options:OpenSpecOptions,approval:OpenSpecPreparation,
 dependencies:{stateRoot?:string;signal?:AbortSignal;recover?:boolean;write:(text:string)=>void;onInstalled?:()=>void}){
 const {stateRoot,signal,recover,write,onInstalled}=dependencies;
 const lock=await acquireLock(root,{stateRoot,recover});
 let stage:string|undefined;
 try{
  root=lock.root;
  if(approval.root!==root||signature(approval.agents)!==signature(options.agents))throw Error('OpenSpec approval belongs to another project or host selection');
  if(await interruptedSeedApplyId(root,lock.stateRoot)||await interruptedInstallApplyId(root,lock.stateRoot))
   throw Error('Resume the original approval with rigup update '+quoteShell(root)+' --resume --review');
  await assertNoUnknownWriters(root,lock.stateRoot);
  const prior=await readOpenSpecPreparation(root,lock.stateRoot);
  const approvalDigest=signature(approval);
  if(prior&&!prior.complete&&(!recover||prior.approvalDigest!==approvalDigest))
   throw Error('Resume the original OpenSpec preparation with --prepare-openspec --resume');
  const record:OpenSpecPreparationRecord=prior&&!prior.complete?prior:
   {version:1,root,approval,approvalDigest,complete:false,projectReceipt:prior?.projectReceipt,projectPayloadDigest:prior?.projectPayloadDigest};
  const scope=preparationScope(approval);
  const inspect=(identity?:string)=>inspectOpenSpec(root,options,signal,identity,{scope,stateRoot:lock.stateRoot});
  const finish=async(setup:OpenSpecInspection)=>{
   if(!setup.requirements.length){record.complete=true;await saveOpenSpecPreparation(record,lock.stateRoot);}
   return setup;
  };
  const approvedCli=approval.kind==='existing'?approval.cliIdentity:record.installedCliIdentity;
  let setup=await inspect(approvedCli);
  if(approval.kind==='existing'&&setup.cliVersion!==approval.cliVersion)throw Error('OpenSpec CLI changed after approval; prepare it again');
  if(!scopeCovered(approval,setup))throw Error('OpenSpec preparation scope changed after approval; prepare it again');
  if(!setup.requirements.length&&!(prior&&!prior.complete&&approval.kind!=='existing'&&!record.installedCliIdentity))
   return prior&&!prior.complete?finish(setup):setup;
  if(!setup.canPrepare&&!(recover&&prior&&!prior.complete&&approval.kind!=='existing'&&!record.installedCliIdentity))
   throw Error('OpenSpec preparation scope changed after approval; prepare it again');
  if(approval.kind!=='existing')await saveOpenSpecPreparation(record,lock.stateRoot);
  if(setup.needsProject){
   const targets=[...(setup.needsRoot?['openspec/config.yaml']:[]),...setup.needsEntries.map(agent=>agents[agent].skillDirectory+'/openspec-propose/SKILL.md')];
  }
  if(approval.kind==='project-install'&&!record.installedCliIdentity){
   if(approval.prefix!==join(root,projectPrefix))throw Error('OpenSpec project npm destination differs from approval');
   write('正在安装 OpenSpec CLI '+approval.install.version+' 到 '+approval.prefix+'\n');
   await installProjectOpenSpec(root,record,lock.stateRoot,signal,recover);
   onInstalled?.();
   setup=await inspect();
   if(!setup.cliIdentity||setup.cli?.source!=='project'||setup.cliVersion!==approval.install.version)
    throw Error('Installed project OpenSpec CLI does not match approval');
   record.installedCliIdentity=setup.cliIdentity;
   await saveOpenSpecPreparation(record,lock.stateRoot);
  }
  if(approval.kind==='install'&&!record.installedCliIdentity){
   write('正在安装 OpenSpec CLI '+approval.install.version+' 到 '+approval.prefix+'\n');
   const outcome=await installOpenSpec(root,options,approval,lock.stateRoot,signal,recover);
   setup=outcome.inspection;
   if(outcome.installed)onInstalled?.();
   record.installedCliIdentity=setup.cliIdentity;
   await saveOpenSpecPreparation(record,lock.stateRoot);
  }
  if(!setup.requirements.length)return finish(setup);
  if(!setup.cli||!setup.cliIdentity||!setup.canPrepare||!scopeCovered(approval,setup))throw Error('OpenSpec preparation scope changed after approval; prepare it again');
  const {cli,cliIdentity}=setup;
  stage??=await mkdtemp(join(lock.stateRoot,'openspec-'));
  const staged=join(stage,'project');await mkdir(staged);
  const home=join(stage,'home');
  const env={HOME:home,USERPROFILE:home,XDG_CONFIG_HOME:join(home,'config'),XDG_DATA_HOME:join(home,'data'),
   XDG_CACHE_HOME:join(home,'cache'),XDG_STATE_HOME:join(home,'state'),APPDATA:join(home,'roaming'),LOCALAPPDATA:join(home,'local')};
  await Promise.all([...new Set(Object.values(env))].map(path=>mkdir(path,{recursive:true,mode:0o700})));
  await assertCliIdentity(cli,root,setup.path,cliIdentity,lock.stateRoot);
  await writingCommand(cli,openspecInitArgs(setup.needsEntries,setup.cliVersion),staged,setup.path,signal,env);
  if(setup.needsRoot){
   await assertCliIdentity(cli,root,setup.path,cliIdentity,lock.stateRoot);
   const list=await listOpenSpec(cli,staged,setup.path,signal,env).catch(()=>undefined);
   if(typeof list?.root?.path!=='string'||await realpath(list.root.path).catch(()=>undefined)!==staged)throw Error('OpenSpec did not recognize the staged project root');
  }
  const current=await inspect(cliIdentity);
  if(!current.canPrepare||!scopeCovered(setup,current)||current.cliVersion!==setup.cliVersion)throw Error('OpenSpec preparation scope changed after approval; prepare it again');
  if(!current.requirements.length)return finish(current);
  const files=await publishableNativeFiles(root,staged,setup.needsEntries,current,options);
  await assertCliIdentity(cli,root,current.path,cliIdentity,lock.stateRoot);
  await saveOpenSpecPreparation(record,lock.stateRoot);
  // Each retry only adds files that are still absent, even after a partial write.
  for(const {target,bytes} of files){
   signal?.throwIfAborted();
   await atomicProjectWrite(root,target,bytes,0o644,true);
  }
  return finish(await inspect(cliIdentity));
 }finally{
  try{if(stage)await rm(stage,{recursive:true,force:true});}finally{await lock.release();}
 }
}
