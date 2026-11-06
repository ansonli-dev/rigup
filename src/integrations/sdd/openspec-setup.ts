import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {access,lstat,mkdir,mkdtemp,readdir,readFile,realpath,rm} from 'node:fs/promises';
import {homedir} from 'node:os';
import {delimiter,isAbsolute,join,relative} from 'node:path';
import {promisify} from 'node:util';
import {scanRepository} from '../../analyzer/repository.js';
import {acquireLock} from '../../installer/lock.js';
import {atomicProjectWrite} from '../../installer/manifest.js';
import {assertNoUnknownWriters} from '../../installer/operations.js';
import {targetPath} from '../../installer/ownership.js';
import {quoteShell} from '../../shell-command.js';
import type {Agent,SetupOptions} from '../../types.js';
import {agents} from '../agents/index.js';
import {loadUpstreamLock,requireRecipeEvidence} from '../upstream.js';
import {resolveSddBinding,unqualifiedSkillName} from './binding.js';
import {openspecInitArgs,openspecPackage} from './openspec.js';

const exec=promisify(execFile);
const npmFlags=['--ignore-scripts','--no-audit','--no-fund','--prefer-offline','--registry','https://registry.npmjs.org/'];
const hostScopes=(agent:Agent)=>[agents[agent].skillDirectory,agents[agent].skillDirectory.replace(/\/skills$/,'/commands')];
const shell=(args:string[])=>args.map(arg=>/^[\w./:@,=-]+$/.test(arg)?arg:quoteShell(arg)).join(' ');
const within=(root:string,path:string)=>{const rel=relative(root,path);return rel===''||rel!=='..'&&!rel.startsWith('../')&&!isAbsolute(rel);};
const available=(path:string,mode:number)=>access(path,mode).then(()=>true,()=>false);
const exists=(path:string)=>lstat(path).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
// The portable launcher keeps its bundled Node available for Rigup operations.
const consumerPath=()=>process.env.RIGUP_CONSUMER_PATH??process.env.PATH??'';

async function executable(name:string,root:string){
 for(const directory of consumerPath().split(delimiter)){
  if(!isAbsolute(directory))continue;
  const path=join(directory,name);
  if(!await available(path,constants.X_OK))continue;
  const canonical=await realpath(path);
  if(!within(root,path)&&!within(root,canonical)&&(await lstat(canonical)).isFile())return path;
 }
}

async function command(executable:string,args:string[],cwd:string,signal?:AbortSignal,extraEnv?:NodeJS.ProcessEnv,timeout=20_000){
 return exec(executable,args,{cwd,signal,timeout,maxBuffer:256_000,env:{...process.env,PATH:consumerPath(),DO_NOT_TRACK:'1',OPENSPEC_TELEMETRY:'0',...extraEnv}});
}

async function npmPrefix(npm:string,root:string,signal?:AbortSignal){
 const preferred=(await command(npm,['prefix','-g'],homedir(),signal).catch(()=>undefined))?.stdout.trim();
 if(!preferred)return;
 const path=await Promise.all(consumerPath().split(delimiter).filter(isAbsolute).map(dir=>realpath(dir).catch(()=>undefined)));
 for(const prefix of [preferred,join(homedir(),'.local')]){
  if(!prefix||!isAbsolute(prefix))continue;
  const bin=await realpath(join(prefix,'bin')).catch(()=>undefined);
  if(bin&&!within(root,bin)&&path.includes(bin)&&await available(bin,constants.W_OK))return await realpath(prefix);
 }
}

async function canRunOpenSpec(root:string,signal?:AbortSignal){
 const node=await executable('node',root);
 if(!node)return false;
 const version=(await command(node,['--version'],homedir(),signal).catch(()=>undefined))?.stdout.trim();
 const match=version?.match(/^v(\d+)\.(\d+)\.\d+$/);
 return !!match&&(Number(match[1])>22||Number(match[1])===22&&Number(match[2])>=12);
}

export async function inspectOpenSpec(root:string,options:Pick<SetupOptions,'agents'|'backend'>,signal?:AbortSignal){
 const [lock,profile,cli]=await Promise.all([
  loadUpstreamLock(),
  scanRepository(root,{agents:options.agents,backend:options.backend,sdd:'openspec',scope:options.agents.flatMap(hostScopes)}),
  executable('openspec',root)
 ]);
 const recipe=lock.find(item=>item.integrationId==='openspec')!;
 requireRecipeEvidence(recipe);
 const needsEntries:Agent[]=[],problems:string[]=[];
 for(const agent of options.agents){
  try{resolveSddBinding('openspec',agent,profile.nativeEntries?.[agent]??[],profile.skillSources?.[agent]??[],profile.files);}
  catch(error){
   const reason=(error as Error).message;
   if(reason.startsWith('missing native entry:'))needsEntries.push(agent);
   else problems.push(agent+': '+reason);
  }
 }
 let needsRoot=!await exists(join(root,'openspec/config.yaml'));
 let cliVersion:string|undefined;
 if(cli){
  const version=(await command(cli,['--version'],root,signal).catch(()=>undefined))?.stdout.trim();
  if(version&&/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)){
   cliVersion=version;
   const listed=await command(cli,['list','--json'],root,signal).catch(error=>error.code===1?{stdout:error.stdout as string}:undefined);
   try{
    const list=JSON.parse(listed?.stdout??'');
    if(list.root===null&&(!list.status?.length||list.status.some((status:{code:string})=>status.code==='no_openspec_root')))needsRoot=true;
    else if(list.root?.source==='store'||list.root?.path===root)needsRoot=false;
    else if(list.root?.source==='nearest'&&needsRoot)needsRoot=true;
    else problems.push('OpenSpec project root could not be verified');
   }catch{problems.push('OpenSpec CLI did not return a usable project status');}
  }else problems.push('The existing openspec command did not start successfully');
 }
 const needsProject=needsRoot||needsEntries.length>0;
 const [npm,nodeReady]=cli?[undefined,true]:await Promise.all([executable('npm',root),canRunOpenSpec(root,signal)]);
 const prefix=npm&&nodeReady?await npmPrefix(npm,root,signal):undefined;
 const installAvailable=!!prefix&&!await exists(join(prefix,'bin/openspec'))&&!await exists(join(prefix,'lib/node_modules',openspecPackage));
 const installPrefix=prefix??join(homedir(),'.local');
 const requirements=[
  ...(!cli?['OpenSpec CLI is missing from PATH']:[]),
  ...(needsRoot?['OpenSpec project root is missing']:[]),
  ...needsEntries.map(host=>host+': OpenSpec workflow entries are missing'),
  ...problems,
  ...(!nodeReady?['OpenSpec needs Node.js 22.12 or newer on the user PATH']:[]),
  ...(!cli&&!installAvailable?['Automatic installation requires npm and a writable user bin directory on PATH']:[]),
  ...(cliVersion&&cliVersion!==recipe.version&&needsProject?['Automatic project initialization uses the verified OpenSpec '+recipe.version+' layout']:[])
 ];
 const canPrepare=!problems.length&&(cliVersion===recipe.version||!!cliVersion&&!needsProject||!cli&&installAvailable);
 const steps=[
  ...(!cliVersion?[
   shell(['npm','install','--global','--prefix',installPrefix,...npmFlags,openspecPackage+'@'+recipe.version]),
   ...(!prefix?['export PATH='+quoteShell(join(installPrefix,'bin'))+':"$PATH"']:[])
  ]:[]),
  ...(needsProject&&!problems.length?[shell(['cd',root])+' && '+shell(['openspec',...openspecInitArgs(needsEntries)])]:[])
 ];
 return {cli,cliVersion,npm,prefix,recipe,needsProject,needsRoot,needsEntries,requirements,canPrepare,steps,entries:profile.nativeEntries};
}
type OpenSpecSetup=Awaited<ReturnType<typeof inspectOpenSpec>>;

export function reportOpenSpecPending(setup:OpenSpecSetup,resumeCommand:string,write:(text:string)=>void,report?:(value:Record<string,unknown>)=>void){
 const nextCommand=setup.steps.length?[...setup.steps,resumeCommand].join(' && '):null;
 report?.({phase:'preflight',installStatus:'pending',executable:false,pending:setup.requirements,requiredInput:setup.requirements,nextCommand,resumeCommand});
 write('补齐 OpenSpec 后继续原设置：\n'+(nextCommand??resumeCommand)+'\n');
}

async function installOpenSpec(setup:OpenSpecSetup,stage:string,signal?:AbortSignal){
 const {npm,prefix,recipe}=setup;
 if(!npm||!prefix||!recipe.packageIntegrity)throw Error('A writable npm bin directory on PATH is required');
 const name=openspecPackage+'@'+recipe.version;
 const archive='fission-ai-openspec-'+recipe.version+'.tgz';
 await command(npm,['pack','--ignore-scripts','--prefer-offline','--registry','https://registry.npmjs.org/','--pack-destination',stage,name],stage,signal,undefined,120_000);
 const tarball=join(stage,archive);
 const integrity='sha512-'+createHash('sha512').update(await readFile(tarball)).digest('base64');
 if(integrity!==recipe.packageIntegrity)throw Error('OpenSpec package integrity mismatch');
 await command(npm,['install','--global','--prefix',prefix,...npmFlags,tarball],stage,signal,undefined,120_000);
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
  const covered=(current:OpenSpecSetup)=>(current.cli||current.prefix===approved.prefix)
    && (!current.needsRoot||approved.needsRoot)&&current.needsEntries.every(agent=>approved.needsEntries.includes(agent));
  if(!setup.canPrepare||!covered(setup))return setup;
  stage=await mkdtemp(join(lock.stateRoot,'openspec-'));
  if(!setup.cli){
   const installLock=await acquireLock(root,{stateRoot:lock.stateRoot,recover,resource:'openspec:'+setup.prefix});
   try{
    setup=await inspectOpenSpec(root,options,signal);
    if(!setup.cli&&setup.prefix===approved.prefix&&setup.canPrepare){
     write('正在安装 OpenSpec CLI '+setup.recipe.version+' 到 '+setup.prefix+'\n');
     await installOpenSpec(setup,stage,signal);
    }
   }finally{await installLock.release();}
   setup=await inspectOpenSpec(root,options,signal);
  }
  if(setup.cli&&setup.cliVersion===setup.recipe.version&&setup.canPrepare&&setup.needsProject&&covered(setup)){
   const staged=join(stage,'project');
   await mkdir(staged);
   write('正在准备 OpenSpec 项目入口\n');
   await command(setup.cli,openspecInitArgs(setup.needsEntries),staged,signal,{XDG_CONFIG_HOME:join(stage,'config')});
   await addNativeFiles(root,staged,setup,signal);
  }
  return await inspectOpenSpec(root,options,signal);
 }finally{
  try{if(stage)await rm(stage,{recursive:true,force:true});}finally{await lock.release();}
 }
}
