import {mkdir,readdir,realpath,writeFile} from 'node:fs/promises';
import {dirname,join,relative} from 'node:path';
import type {ProjectProfile} from '../../analyzer/repository.js';
import {signature} from '../../generator/cache.js';
import {isRecord} from '../../private-record.js';
import {absoluteHostPath,canonicalHostDirectory,checkedDirectory,nativeJson,readNativeFile,statIfPresent,withinPath} from './host-files.js';
import {claudeManagedRoot,claudePlugin} from './manual.js';
import {claudeMarket,claudeRepo,claudeSha,claudeSource,claudeVersion} from './pins.js';
import {bindingFrom} from './receipt.js';
import {nativeChildEnv,trustedHelper,type HostRuntime} from './runtime.js';

const allowed=new Set(['permissions','enabledPlugins','extraKnownMarketplaces','model','outputStyle','language','includeCoAuthoredBy','cleanupPeriodDays']);
const knobs=new Set(['strictKnownMarketplaces','blockedMarketplaces']);
const official=(source:unknown)=>isRecord(source)&&Object.keys(source).length===2&&source.source==='github'&&source.repo===claudeRepo;
export type ClaudeStep='marketplace'|'install';
export const claudeArgs=(step:ClaudeStep)=>['--setting-sources','user','plugin',...(step==='marketplace'?['marketplace','add',claudeRepo]:['install',claudePlugin]),'--scope','project'];

async function gitConfig(dir:string,cached=false){
 const path=join(dir,'config'),doc=await readNativeFile(path);
 if(await statIfPresent(join(dir,'config.worktree'))||await statIfPresent(join(dir,'commondir')))
  throw Error('Git worktree configuration can change native scope; prepare Claude manually');
 if(!doc)return;
 // Git reads repository config independently of --setting-sources. Do not
 // let repository includes, filters or URL rewrites reach its subprocesses.
 let section='';
 const safe:Record<string,string[]>={
  core:['repositoryformatversion','filemode','bare','logallrefupdates','ignorecase','precomposeunicode','symlinks','autocrlf','protectntfs','longpaths'],
  remote:['url','fetch','pushurl'],submodule:['active'],branch:['remote','merge','rebase'],user:['name','email'],
 };
 for(const raw of doc.bytes.toString('utf8').split(/\r?\n/)){
  const line=raw.trim();
  if(!line||line.startsWith('#')||line.startsWith(';'))continue;
  const header=/^\[([a-z]+)(?: "[^"\\\x00-\x1f]+")?\]$/i.exec(line);
  if(header){section=header[1].toLowerCase();if(Object.hasOwn(safe,section))continue;}
  const entry=/^([a-z]+)\s*=\s*[^\x00-\x1f]*$/i.exec(line);
  if(cached&&section==='remote'&&entry?.[1].toLowerCase()==='url'&&line.split('=').slice(1).join('=').trim()!=='https://github.com/'+claudeRepo+'.git')throw Error('The cached Claude marketplace repository has a different remote');
  if(!entry||line.endsWith('\\')||!safe[section]?.includes(entry[1].toLowerCase()))
   throw Error('Git repository configuration contains unsupported settings; prepare Claude manually');
 }
 return doc.identity;
}

export async function inspectClaude(runtime:HostRuntime){
 const {root,home,env}=runtime;
 const config=await canonicalHostDirectory(env.CLAUDE_CONFIG_DIR??join(home,'.claude'));
 const project=join(root,'.claude','settings.json'),local=join(root,'.claude','settings.local.json');
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
  catch{throw Error('Invalid, redirected or unreadable '+label+'; reconcile it before retrying');}
 };
 await read(configFile,'Claude user state',4_000_000);
 let projectEnabled=false,enabled=false,declared=false,projectOutsideMarket:unknown={};
 for(const path of documents){
  const value=await read(path,'Claude settings');
  if(!value)continue;
  for(const key of Object.keys(value))if(!allowed.has(key)&&!(path!==project&&path!==local&&knobs.has(key)))
   throw Error('Unsupported Claude '+(path===project||path===local?'project key':'settings key')+(/^\w{1,80}$/.test(key)?' '+key:'')+'; prepare manually');
  if(path===project)projectOutsideMarket=Object.fromEntries(Object.entries(value).filter(([key])=>key!=='extraKnownMarketplaces'));
  if(value.extraKnownMarketplaces!==undefined){
   const markets=value.extraKnownMarketplaces;
   if(!isRecord(markets)||Object.entries(markets).some(([name,item])=>name!==claudeMarket||
    !isRecord(item)||Object.keys(item).length!==1||!official(item.source)))
    throw Error('Claude settings declare another or non-official marketplace; prepare manually');
   if(path===project&&Object.hasOwn(markets,claudeMarket))declared=true;
  }
  if(value.enabledPlugins!==undefined){
   if(!isRecord(value.enabledPlugins)||Object.entries(value.enabledPlugins).some(([id,v])=>id!==claudePlugin||typeof v!=='boolean'))
    throw Error('Claude settings include an unsupported plugin declaration; prepare manually');
   if(value.enabledPlugins[claudePlugin]===false)throw Error('Claude Superpowers is explicitly disabled in effective settings');
   if(value.enabledPlugins[claudePlugin]===true){enabled=true;if(path===project)projectEnabled=true;}
  }
 }
 const markets=await read(known,'Claude marketplace registry',2_000_000);
 const installRegistry=await read(registry,'Claude installed plugin registry',2_000_000);
 const recorded=installRegistry?.plugins;
 if(installRegistry&&(installRegistry.version!==2||!isRecord(recorded)))throw Error('Unsupported Claude installed plugin registry');
 const records=isRecord(recorded)?recorded[claudePlugin]:undefined;
 let installed:string|undefined;
 if(records!==undefined){
  const item=Array.isArray(records)&&records.length===1?records[0]:undefined;
  if(!isRecord(item)||item.scope!=='project'||typeof item.projectPath!=='string'||
     relative(root,absoluteHostPath(item.projectPath))!==''||relative(root,await realpath(item.projectPath))!=='')
   throw Error('Claude Superpowers has a different scope or conflicting install receipt; reconcile it manually');
  if(item.version!==claudeVersion||item.gitCommitSha!==claudeSha||item.enabled===false||typeof item.installPath!=='string'||
     relative(install,absoluteHostPath(item.installPath))!==''||!await checkedDirectory(install))
   throw Error('Claude Superpowers receipt does not match the pinned source; reconcile it manually');
  if(!projectEnabled)throw Error('Claude Superpowers receipt has no enabled project setting; reconcile it manually');
  installed=install;
 }else{
  if(enabled)throw Error('Claude Superpowers is enabled without an exact install receipt; reconcile it manually');
  if(await statIfPresent(packageRoot))throw Error('Claude Superpowers cache exists without its exact receipt; reconcile it manually');
 }
 const registered=markets?.[claudeMarket];
 let market:'missing'|'ready'='missing';
 if(registered!==undefined){
  if(!isRecord(registered)||!official(registered.source)||typeof registered.installLocation!=='string'||
     relative(catalogRoot,absoluteHostPath(registered.installLocation))!==''||
     Object.keys(registered).some(key=>!['source','installLocation','lastUpdated','autoUpdate'].includes(key)))
   throw Error('The Claude marketplace name is already registered to a different source or path');
  const contents=await read(catalog,'official Claude marketplace catalog',2_000_000);
  const items=contents?.name===claudeMarket&&Array.isArray(contents.plugins)?contents.plugins.filter(item=>isRecord(item)&&item.name==='superpowers'):[];
  const item=items.length===1?items[0]:undefined;
  const source=item?.source;
  if(!item||Object.keys(item).some(key=>!['name','description','category','source','homepage'].includes(key))||
     !isRecord(source)||Object.keys(source).length!==3||source.source!=='url'||source.url!==claudeSource||source.sha!==claudeSha)
   throw Error('The official cached catalog does not advertise the pinned Superpowers source; prepare Claude manually');
  stamps[catalogRoot]=await gitConfig(join(catalogRoot,'.git'),true);
  market='ready';
 }else if(await statIfPresent(catalogRoot)||isRecord(recorded)&&Object.keys(recorded).length){
  throw Error('Adding the Claude marketplace could touch existing plugins or a partial cache; reconcile it manually');
 }
 if(installed&&market==='missing')throw Error('Claude install receipt lacks the official marketplace');
 stamps[root]=await gitConfig(join(root,'.git'));
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

export async function claudeGitIdentity(runtime:HostRuntime){
 return trustedHelper('git',runtime);
}
