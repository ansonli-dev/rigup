import {execFile} from 'node:child_process';
import {mkdir,readdir,realpath,writeFile} from 'node:fs/promises';
import {dirname,isAbsolute,join,relative} from 'node:path';
import {promisify} from 'node:util';
import type {ProjectProfile} from '../../analyzer/repository.js';
import {signature} from '../../generator/cache.js';
import {isRecord} from '../../private-record.js';
import {essentialEnvironment} from '../../runtime-private-env.js';
import {absoluteHostPath,canonicalHostDirectory,checkedDirectory,nativeJson,statIfPresent,withinPath} from './host-files.js';
import {claudeManagedRoot,claudePlugin} from './manual.js';
import {claudeMarket,claudeRepo,claudeSha,claudeSource,claudeVersion} from './pins.js';
import {bindingFrom} from './receipt.js';
import {hostGit,nativeChildEnv,type HostRuntime} from './runtime.js';

const exec=promisify(execFile);
const official=(source:unknown)=>isRecord(source)&&Object.keys(source).length===2&&source.source==='github'&&source.repo===claudeRepo;
export type ClaudeStep='marketplace'|'install';
export const claudeArgs=(step:ClaudeStep)=>['--setting-sources','user','plugin',...(step==='marketplace'?['marketplace','add',claudeRepo]:['install',claudePlugin]),'--scope','project'];

async function verifyCatalogRemote(catalog:string,runtime:HostRuntime){
 if(!await statIfPresent(join(catalog,'.git')))return;
 const git=await hostGit(runtime);
 const result=await exec(git,['-C',catalog,'config','--local','--get','remote.origin.url'],{
  env:essentialEnvironment(runtime.env),timeout:5000,maxBuffer:4096,windowsHide:true,
 }).catch(()=>undefined);
 const url='https://github.com/'+claudeRepo;
 if(result?.stdout.trim()!==url&&result?.stdout.trim()!==url+'.git')
  throw Error('The cached Claude marketplace repository has a different remote: '+catalog);
}

export async function inspectClaude(runtime:HostRuntime){
 const {root,home,env}=runtime;
 const config=await canonicalHostDirectory(env.CLAUDE_CONFIG_DIR??join(home,'.claude'));
 const projectConfig=await canonicalHostDirectory(join(root,'.claude'));
 if(!withinPath(root,projectConfig))throw Error('Claude project settings resolve outside the selected project: '+projectConfig);
 const project=join(projectConfig,'settings.json'),local=join(projectConfig,'settings.local.json');
 const user=join(config,'settings.json'),plugins=join(config,'plugins');
 const known=join(plugins,'known_marketplaces.json'),registry=join(plugins,'installed_plugins.json');
 const catalogRoot=join(plugins,'marketplaces',claudeMarket),catalog=join(catalogRoot,'.claude-plugin','marketplace.json');
 const packageRoot=join(plugins,'cache',claudeMarket,'superpowers'),install=join(packageRoot,claudeVersion);
 const configFile=join(env.CLAUDE_CONFIG_DIR??home,'.claude.json'),backups=join(config,'backups');
 const managed=claudeManagedRoot(env);
 const policy=join(managed,'managed-settings.json'),dropIns=join(managed,'managed-settings.d');
 const documents=[user,project,local,policy];
 if(await checkedDirectory(dropIns)){
  const names=(await readdir(dropIns)).filter(name=>name.endsWith('.json')).sort();
  if(names.length>50)throw Error('Claude managed settings exceed the inspection limit');
  documents.push(...names.map(name=>join(dropIns,name)));
 }
 if(withinPath(root,config))throw Error('Claude configuration must be outside the project');
 const stamps:Record<string,string|undefined>={};
 const read=async (path:string,label:string,limit?:number)=>{
  try{const doc=await nativeJson(path,limit);stamps[path]=doc?.identity;return doc?.value;}
  catch{throw Error('Invalid or unreadable '+label+': '+path);}
 };
 await read(configFile,'Claude user state',4_000_000);
 let projectEnabled=false,enabled=false,declared=false,projectOutsideMarket:unknown={};
 for(const path of documents){
  const value=await read(path,'Claude settings');
  if(!value)continue;
  if(path===project)projectOutsideMarket=Object.fromEntries(Object.entries(value).filter(([key])=>key!=='extraKnownMarketplaces'));
  if(value.extraKnownMarketplaces!==undefined){
   const markets=value.extraKnownMarketplaces;
   if(!isRecord(markets)||Object.hasOwn(markets,claudeMarket)&&
    (!isRecord(markets[claudeMarket])||!official(markets[claudeMarket].source)))
    throw Error('Claude settings declare a non-official '+claudeMarket+' marketplace: '+path);
   if(path===project&&Object.hasOwn(markets,claudeMarket))declared=true;
  }
  if(value.enabledPlugins!==undefined){
   const plugins=value.enabledPlugins;
   if(!isRecord(plugins)||Object.hasOwn(plugins,claudePlugin)&&typeof plugins[claudePlugin]!=='boolean')
    throw Error('Invalid Claude Superpowers setting: '+path);
   if(plugins[claudePlugin]===false)throw Error('Claude Superpowers is explicitly disabled: '+path);
   if(plugins[claudePlugin]===true){enabled=true;if(path===project)projectEnabled=true;}
  }
 }
 const markets=await read(known,'Claude marketplace registry',2_000_000);
 const installRegistry=await read(registry,'Claude installed plugin registry',2_000_000);
 const recorded=installRegistry?.plugins;
 if(installRegistry&&(installRegistry.version!==2||!isRecord(recorded)))throw Error('Unsupported Claude installed plugin registry');
 const records=isRecord(recorded)?recorded[claudePlugin]:undefined;
 const conflict=()=>Error('Claude Superpowers has a different scope or conflicting install receipt: '+registry);
 if(records!==undefined&&!Array.isArray(records))throw conflict();
 const scoped=[];
 for(const item of records??[]){
  if(!isRecord(item)||!['project','local'].includes(String(item.scope))||
     typeof item.projectPath!=='string'||!isAbsolute(item.projectPath))throw conflict();
  const projectPath=await realpath(item.projectPath).catch(()=>absoluteHostPath(item.projectPath as string));
  if(relative(root,projectPath)!=='')continue;
  if(item.scope!=='project')throw conflict();
  scoped.push(item);
 }
 if(scoped.length>1)throw conflict();
 const pinned=(item:unknown)=>isRecord(item)&&item.version===claudeVersion&&item.gitCommitSha===claudeSha&&
  typeof item.installPath==='string'&&isAbsolute(item.installPath)&&relative(install,absoluteHostPath(item.installPath))==='';
 let installed:string|undefined;
 if(scoped.length){
  const [item]=scoped;
  if(!pinned(item)||item.enabled===false||!await checkedDirectory(install))
   throw Error('Claude Superpowers receipt does not match the pinned source: '+registry);
  if(!projectEnabled)throw Error('Claude Superpowers receipt has no enabled project setting: '+project);
  installed=install;
 }else{
  if(enabled)throw Error('Claude Superpowers is enabled without an exact install receipt: '+registry);
  if(await statIfPresent(install)&&!records?.some(pinned))
   throw Error('Claude Superpowers cache exists without a pinned receipt: '+install);
 }
 const registered=markets?.[claudeMarket];
 let market:'missing'|'ready'='missing';
 if(registered!==undefined){
  if(!isRecord(registered)||!official(registered.source)||typeof registered.installLocation!=='string'||!isAbsolute(registered.installLocation)||
     relative(catalogRoot,absoluteHostPath(registered.installLocation))!=='')
   throw Error('The Claude marketplace name is already registered to a different source or path');
  const contents=await read(catalog,'official Claude marketplace catalog',2_000_000);
  const items=contents?.name===claudeMarket&&Array.isArray(contents.plugins)?contents.plugins.filter(item=>isRecord(item)&&item.name==='superpowers'):[];
  const item=items.length===1?items[0]:undefined;
  const source=item?.source;
  if(!isRecord(source)||Object.keys(source).length!==3||source.source!=='url'||source.url!==claudeSource||source.sha!==claudeSha)
   throw Error('The official cached catalog does not advertise the pinned Superpowers source; prepare Claude manually');
  await verifyCatalogRemote(catalogRoot,runtime);
  market='ready';
 }else if(await statIfPresent(catalogRoot)){
  throw Error('The Claude marketplace cache has no matching registration: '+catalogRoot);
 }
 if(installed&&market==='missing')throw Error('Claude install receipt lacks the official marketplace');
 for(const directory of [dirname(project),config,plugins,dirname(catalogRoot),dirname(packageRoot),backups])await checkedDirectory(directory);
 const paths=[project,local,user,known,registry,catalog,install,configFile,backups,policy];
 return {market,installed,declared,project,config,configFile,backups,known,registry,catalogRoot,install,paths,
  invariants:signature([projectOutsideMarket,...Object.entries(stamps).filter(([path])=>![project,known,registry,catalog,catalogRoot,configFile].includes(path))]),
  snapshot:signature({stamps,market,installed,paths})};
}

export function claudeRecognized(receipt:Awaited<ReturnType<typeof inspectClaude>>,profile:ProjectProfile){
 return !!receipt.installed&&bindingFrom(profile,'claude',receipt.installed,'superpowers');
}

export async function prepareClaudeScratch(path:string){
 await writeFile(join(path,'git-config'),'',{flag:'wx',mode:0o600});
 await mkdir(join(path,'empty-hooks'),{mode:0o700});
}

export function claudeGitEnv(path:string,denyRefresh:boolean):NodeJS.ProcessEnv{
 const empty=join(path,'git-config'),hooks=join(path,'empty-hooks');
 const entries=[['core.hooksPath',hooks],['core.fsmonitor','false'],['credential.helper',''],['http.followRedirects','false']];
 if(denyRefresh)for(const prefix of ['https://github.com/','git@github.com:','ssh://git@github.com/'])
  entries.push(['url.file:///rigup-marketplace-refresh-denied.insteadOf',prefix+claudeRepo]);
 return {GIT_ALLOW_PROTOCOL:'https',GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_GLOBAL:empty,GIT_CONFIG_SYSTEM:empty,
  GIT_CONFIG_NOSYSTEM:'1',GIT_TEMPLATE_DIR:hooks,GIT_LFS_SKIP_SMUDGE:'1',GIT_CONFIG_COUNT:String(entries.length),
  ...Object.fromEntries(entries.flatMap(([key,value],i)=>[['GIT_CONFIG_KEY_'+i,key],['GIT_CONFIG_VALUE_'+i,value]]))};
}

export function claudeCommand(runtime:HostRuntime,temp:string,step:ClaudeStep){
 return {executable:runtime.program.file,args:[...runtime.program.args,...claudeArgs(step)],
  env:{...nativeChildEnv(runtime,temp),...claudeGitEnv(temp,step==='install')}};
}
