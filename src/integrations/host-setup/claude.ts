import {mkdir,readdir,realpath,writeFile} from 'node:fs/promises';
import {dirname,isAbsolute,join,relative} from 'node:path';
import {valid} from 'semver';
import type {ProjectProfile} from '../../analyzer/repository.js';
import {isRecord} from '../../private-record.js';
import {makeReason,type ReasonInput} from '../../i18n/reasons.js';
import {NativeBlocker} from './blockers.js';
import {absoluteHostPath,canonicalHostDirectory,checkedDirectory,nativeJson,statIfPresent,withinPath} from './host-files.js';
import {claudeManagedRoot,claudePlugin} from './manual.js';
import {claudeMarket,claudeRepo,claudeSource} from './pins.js';
import {bindingFrom} from './receipt.js';
import {nativeChildEnv,type HostLocations,type HostRuntime} from './runtime.js';

const official=(source:unknown)=>isRecord(source)&&Object.keys(source).length===2&&source.source==='github'&&source.repo===claudeRepo;
const shaOf=(value:unknown)=>typeof value==='string'&&/^[0-9a-f]{40}$/i.test(value)?value.toLowerCase():undefined;
const versionOf=(value:unknown)=>typeof value==='string'&&/^[0-9][A-Za-z0-9.+-]{0,127}$/.test(value)&&valid(value)?value:undefined;
export type ClaudeStep='marketplace'|'install';
export type ClaudeTarget={sha:string;version?:string};
export const claudeArgs=(step:ClaudeStep)=>['--setting-sources','user','plugin',...(step==='marketplace'?['marketplace','add',claudeRepo]:['install',claudePlugin]),'--scope','project'];

export async function inspectClaude(runtime:HostLocations){
 const {root,home,env}=runtime;
 const config=await canonicalHostDirectory(env.CLAUDE_CONFIG_DIR??join(home,'.claude'));
 const projectConfig=await canonicalHostDirectory(join(root,'.claude'));
 if(!withinPath(root,projectConfig))throw Error('Claude project settings resolve outside the selected project: '+projectConfig);
 const project=join(projectConfig,'settings.json'),local=join(projectConfig,'settings.local.json');
 const user=join(config,'settings.json'),plugins=join(config,'plugins');
 const known=join(plugins,'known_marketplaces.json'),registry=join(plugins,'installed_plugins.json');
 const catalogRoot=join(plugins,'marketplaces',claudeMarket),catalog=join(catalogRoot,'.claude-plugin','marketplace.json');
 const cache=join(plugins,'cache'),packageRoot=join(cache,claudeMarket,'superpowers');
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
 for(const directory of [projectConfig,config,plugins,dirname(catalogRoot),catalogRoot,dirname(catalog),cache,dirname(packageRoot),packageRoot,backups]){
  try{await checkedDirectory(directory);}
  catch{throw new NativeBlocker('prerequisite-unverified',makeReason('reason.native.claudeDirectory'),{evidence:[directory]});}
 }
 const read=async (path:string,label:string,limit?:number)=>{
  try{return (await nativeJson(path,limit))?.value;}
  catch{throw new NativeBlocker('prerequisite-unverified',makeReason('reason.native.claudeFile',{file:path},'Invalid or unreadable '+label+'.'),{evidence:[path]});}
 };
 await read(configFile,'Claude user state',4_000_000);
 let projectEnabled=false,declared=false;
 for(const path of documents){
  const value=await read(path,'Claude settings');
  if(!value)continue;
  if(value.extraKnownMarketplaces!==undefined){
   const markets=value.extraKnownMarketplaces;
   if(!isRecord(markets)||Object.hasOwn(markets,claudeMarket)&&
    (!isRecord(markets[claudeMarket])||!official(markets[claudeMarket].source)))
    throw new NativeBlocker('claude-catalog-no-entry',makeReason('reason.native.claudeMarketplaceSource'),{evidence:[path]});
   if(path===project&&Object.hasOwn(markets,claudeMarket))declared=true;
  }
  if(value.enabledPlugins!==undefined){
   const plugins=value.enabledPlugins;
   if(!isRecord(plugins)||Object.hasOwn(plugins,claudePlugin)&&typeof plugins[claudePlugin]!=='boolean')
    throw new NativeBlocker('prerequisite-unverified',makeReason('reason.native.claudeSetting'),{evidence:[path]});
   if(plugins[claudePlugin]===false)throw new NativeBlocker('host-plugin-disabled',makeReason('reason.native.claudeDisabled'),{evidence:[path]});
   if(plugins[claudePlugin]===true&&(path===project||path===local))projectEnabled=true;
  }
 }
 const markets=await read(known,'Claude marketplace registry',2_000_000);
 const installRegistry=await read(registry,'Claude installed plugin registry',2_000_000);
 const recorded=installRegistry?.plugins;
 if(installRegistry&&(installRegistry.version!==2||!isRecord(recorded)))
  throw new NativeBlocker('prerequisite-unverified',makeReason('reason.native.claudeRegistry'),{evidence:[registry]});
 const records=isRecord(recorded)?recorded[claudePlugin]:undefined;
 const broken=(reason:ReasonInput,evidence=[registry])=>new NativeBlocker('host-plugin-broken',reason,{evidence});
 const conflict=()=>broken(makeReason('reason.native.claudeReceiptConflict'));
 if(records!==undefined&&!Array.isArray(records))throw conflict();
 const receipts=(records??[]).filter(isRecord),scoped:Record<string,unknown>[]=[];
 for(const item of receipts){
  if((item.scope!=='project'&&item.scope!=='local')||typeof item.projectPath!=='string'||!isAbsolute(item.projectPath))continue;
  const path=item.projectPath;
  if(relative(root,await realpath(path).catch(()=>absoluteHostPath(path)))==='')scoped.push(item);
 }
 if(scoped.length>1)throw conflict();
 const cachePath=(item:Record<string,unknown>)=>{
  if(typeof item.installPath!=='string'||!isAbsolute(item.installPath))return;
  const path=absoluteHostPath(item.installPath);
  if(withinPath(packageRoot,path)&&relative(packageRoot,path)!=='')return path;
 };
 const item=scoped[0];
 if(item?.enabled===false||!item&&receipts.some(receipt=>receipt.scope==='user'&&receipt.enabled===false))
  throw new NativeBlocker('host-plugin-disabled',makeReason('reason.native.claudeReceiptDisabled'),{evidence:[registry]});
 let installed:string|undefined,installedSha:string|undefined,installedVersion:string|undefined;
 if(item){
  const path=cachePath(item);
  if(!path||!await checkedDirectory(path).catch(()=>undefined)||!withinPath(packageRoot,await realpath(path)))
   throw broken(makeReason('reason.native.claudeCacheMissing'),path?[registry,path]:[registry,packageRoot]);
  if(!projectEnabled)throw broken(makeReason('reason.native.claudeProjectNotEnabled'),[registry,project,local]);
  installed=path;installedSha=shaOf(item.gitCommitSha);installedVersion=versionOf(item.version);
 }else{
  if(projectEnabled&&!receipts.length)throw broken(makeReason('reason.native.claudeReceiptMissing'),[registry,project,local]);
  if(!receipts.some(cachePath)&&await checkedDirectory(packageRoot)&&
     (await readdir(packageRoot,{withFileTypes:true})).some(entry=>entry.isDirectory()||entry.isSymbolicLink()))
   throw broken(makeReason('reason.native.claudeCacheNoReceipt'),[packageRoot,registry]);
 }
 const registered=markets?.[claudeMarket];
 let market:'missing'|'ready'='missing';
 let target:ClaudeTarget|undefined;
 if(registered!==undefined){
  if(!isRecord(registered)||!official(registered.source)||typeof registered.installLocation!=='string'||!isAbsolute(registered.installLocation)||
     relative(catalogRoot,absoluteHostPath(registered.installLocation))!=='')
   throw new NativeBlocker('claude-catalog-no-entry',makeReason('reason.native.claudeMarketplaceRegistered'),{evidence:[known,catalogRoot]});
  const contents=await read(catalog,'official Claude marketplace catalog',2_000_000);
  const items=contents?.name===claudeMarket&&Array.isArray(contents.plugins)?contents.plugins.filter(item=>isRecord(item)&&item.name==='superpowers'):[];
  const entry=items.length===1?items[0]:undefined,source=entry?.source;
  const sha=isRecord(source)&&Object.keys(source).length===3&&source.source==='url'&&source.url===claudeSource?shaOf(source.sha):undefined;
  if(!sha)throw new NativeBlocker('claude-catalog-no-entry',makeReason('reason.native.claudeMarketplaceSha'),{evidence:[catalog]});
  const version=versionOf(entry?.version);
  if(entry?.version!==undefined&&!version)
   throw new NativeBlocker('claude-catalog-no-entry',makeReason('reason.native.claudeMarketplaceVersion'),{evidence:[catalog]});
  target={sha,...(version?{version}:{})};
  market='ready';
 }else if(await statIfPresent(catalogRoot)){
  throw new NativeBlocker('claude-catalog-no-entry',makeReason('reason.native.claudeMarketplaceMissing'),{evidence:[catalogRoot,known]});
 }
 const paths=[project,local,user,known,registry,catalog,packageRoot,configFile,backups,policy];
 return {market,target,installed,installedSha,installedVersion,declared,project,config,configFile,backups,known,registry,catalog,catalogRoot,packageRoot,paths};
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
