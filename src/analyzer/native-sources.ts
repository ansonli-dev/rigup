import {readFile,readdir,realpath,stat,lstat} from 'node:fs/promises';
import {join,isAbsolute,relative,dirname,resolve,matchesGlob} from 'node:path';
import {homedir} from 'node:os';
import {parse} from 'yaml';
import {parse as toml} from 'smol-toml';
import {parse as jsonc} from 'jsonc-parser';
import {fileURLToPath} from 'node:url';
import {rcompare,valid} from 'semver';
import {digest,safePath} from './evidence.js';
import {agents,projectCommandRoots} from '../integrations/agents/index.js';
import type {Agent,SetupOptions} from '../types.js';
import {sddDiscoveryNames,unqualifiedSkillName,type SkillSource} from '../integrations/sdd/binding.js';
export interface NativeDiscoveryOptions {home?:string;env?:Record<string,string|undefined>;requiredOpenSpecEntriesOnly?:true;managedProjectPaths?:string[];onWarning?:(message:string)=>void}
export function nativeSkillMetadata(text:string):{name:string;satisfies:boolean;disabled?:boolean}|undefined {
 const front=text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);if(!front)return;
 const value=parse(front[1]);if(!value||typeof value.name!=='string'||typeof value.description!=='string')return;
 return {name:value.name,satisfies:value.dependencies===undefined||Array.isArray(value.dependencies)&&value.dependencies.length===0,
  ...(value['disable-model-invocation']===true?{disabled:true}:{})};
}
const inside=(base:string,path:string)=>{const rel=relative(base,path);return rel===''||!rel.startsWith('..')&&!isAbsolute(rel);};
const list=async(path:string)=>readdir(path).catch(()=>[] as string[]);
const record=(value:unknown):Record<string,any>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,any>:{};
const array=(value:unknown):string[]=>typeof value==='string'?[value]:Array.isArray(value)?value.filter((x):x is string=>typeof x==='string'):[];
export async function discoverNativeSources(root:string,options:SetupOptions,dependencies:NativeDiscoveryOptions={}) {
 const result:Partial<Record<Agent,SkillSource[]>>={};if(!options.sdd&&!options.customSkills?.length)return result;
 const home=dependencies.home??homedir(),env=dependencies.env??(dependencies.home?{}:process.env);
 const wanted=new Set(options.sdd?sddDiscoveryNames(options.sdd,options.sdd!=='openspec'||!dependencies.requiredOpenSpecEntriesOnly):[]);
 let metadataFiles=0,metadataBytes=0,metadataExhausted=false;
 const metadataText=async(path:string,bound?:string)=>{
  const canonical=await realpath(path);if(bound&&!inside(await realpath(bound),canonical))throw Error('native source escapes installation root');
  const info=await stat(canonical);if(!info.isFile()||info.size>256000)throw Error('Native manager metadata exceeds budget');
  if(++metadataFiles>2000||(metadataBytes+=info.size)>8_000_000){metadataExhausted=true;throw Error('Native metadata read budget exceeded');}
  return readFile(canonical,'utf8');
 };
 const json=async(path:string)=>{try{return record(JSON.parse(await metadataText(path,inside(root,path)?root:undefined)));}catch{return {};}};
 for(const item of options.customSkills??[]){try{const meta=nativeSkillMetadata(await metadataText(join(isAbsolute(item.source)?item.source:join(root,item.source),'SKILL.md')));if(meta)wanted.add(unqualifiedSkillName(meta.name));}catch{}}
 let hooks:any[]=[];
 if(options.sdd==='spec-kit')try{const extension=parse(await metadataText(join(root,'.specify/extensions.yml'),root));hooks=Object.values(extension?.hooks??{}).flat().filter((hook:any)=>hook&&hook.enabled!==false&&hook.optional===false&&!hook.condition);for(const hook of hooks)if(typeof hook.command==='string'){wanted.add(hook.command);wanted.add(hook.command.replaceAll('.','-'));}}catch{}
 const claude=env.CLAUDE_CONFIG_DIR??join(home,'.claude'),codex=env.CODEX_HOME??join(home,'.codex');
 const profileName=env.OMP_PROFILE??env.PI_PROFILE;
 const ompRoot=join(home,env.PI_CONFIG_DIR||'.omp',...(profileName&&profileName!=='default'&&/^[a-z0-9][a-z0-9._-]{0,63}$/.test(profileName)?['profiles',profileName]:[]));
 const omp=env.PI_CODING_AGENT_DIR??join(ompRoot,'agent');
 const xdgRoot=env.XDG_DATA_HOME?join(env.XDG_DATA_HOME,'omp',...(profileName&&profileName!=='default'?['profiles',profileName]:[])):undefined;
 const ompPlugins=join(xdgRoot&&['darwin','linux'].includes(process.platform)&&omp===join(ompRoot,'agent')&&(await stat(xdgRoot).catch(()=>undefined))?.isDirectory()?xdgRoot:ompRoot,'plugins');
 const claudeSettings:Record<string,boolean>={};
 for(const file of [join(claude,'settings.json'),join(root,'.claude/settings.json'),join(root,'.claude/settings.local.json')])Object.assign(claudeSettings,(await json(file)).enabledPlugins??{});
 const matchingProject=async(record:any)=>['project','local'].includes(record.scope)&&typeof record.projectPath==='string'&&await realpath(record.projectPath).catch(()=>undefined)===root;
 for(const agent of options.agents){
  const sources:SkillSource[]=[];result[agent]=sources;
  let count=0,bytes=0,directories=0;
  const visited=new Set<string>();
  const inlineBodies=new Map<string,string>();
  const commandSources=new Set<string>();
  const warn=(id:string,error:unknown)=>dependencies.onWarning?.('Native plugin '+(/^[\w.@/-]{1,200}$/.test(id)?id:'invalid identifier')+' skipped: '+((error as NodeJS.ErrnoException)?.code==='ENOENT'?'manifest missing':'invalid or unavailable metadata; repair the enabled installation'));
  const unavailable=(problem:string)=>{for(const name of wanted)sources.push({name,identity:agent+':unavailable',origin:'unknown',satisfies:false,problem});};
  type Context={origin:SkillSource['origin'];namespace?:string;bound?:string;packageName?:string;sourceFingerprint?:string;project?:boolean;pathNames?:boolean;skillRoot?:string};
  const local=(path:string):Context=>({origin:'local',...(inside(root,path)?{bound:root,project:true}:{})});
  const identity=async(path:string,ctx:Context)=>{const canonical=await realpath(path);return ctx.project?relative(root,canonical).split('\\').join('/'):canonical;};
  const add=async(path:string,ctx:Context,commandName?:string)=>{
   if(ctx.project&&dependencies.managedProjectPaths?.includes(relative(root,path).split('\\').join('/')))return;
   const text=await metadataText(path,ctx.bound);if(++count>2000||(bytes+=Buffer.byteLength(text))>8_000_000)throw Error('native discovery budget exceeded');
   const meta=commandName?{name:commandName,satisfies:!/^dependencies:/m.test(text)}:nativeSkillMetadata(text);
   if(!meta)return;
   if(ctx.pathNames&&ctx.skillRoot)meta.name=relative(ctx.skillRoot,path).replaceAll('\\','/').replace(/(?:\/SKILL)?\.md$/i,'');
   const name=ctx.namespace&&!meta.name.includes(':')?ctx.namespace+':'+meta.name:meta.name;
   if(!wanted.has(unqualifiedSkillName(name)))return;
   const sourceIdentity=await identity(path,ctx);if(commandName)commandSources.add(sourceIdentity);
   sources.push({name,identity:sourceIdentity,origin:ctx.origin,digest:digest(text),satisfies:meta.satisfies&&!meta.disabled,
    ...(meta.disabled?{problem:'disable-model-invocation prevents calling '+name+'; enable model invocation in the native entry'}:{}),
    ...(ctx.packageName?{packageName:ctx.packageName}:{}),...(ctx.sourceFingerprint?{sourceFingerprint:ctx.sourceFingerprint}:{})});
  };
  const walk=async(dir:string,ctx:Context,depth=0):Promise<void>=>{
   if(depth>4)return;if(++directories>2000){unavailable('native discovery budget exceeded');return;}
   let canonical:string;try{canonical=await realpath(dir);if(ctx.bound&&!inside(await realpath(ctx.bound),canonical))return;}catch{return;}
   const key=canonical+'\0'+(ctx.namespace??'');if(visited.has(key))return;visited.add(key);
   try{await add(join(dir,'SKILL.md'),ctx);return;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'){warn(ctx.packageName??agent,error);return;}}
   for(const name of (await list(dir)).sort())if(!name.startsWith('.')){const path=join(dir,name);if((await stat(path).catch(()=>undefined))?.isDirectory())await walk(path,ctx,depth+1);else if(ctx.pathNames&&name.endsWith('.md'))try{await add(path,ctx);}catch(error){warn(agent,error);}}
  };
  const commands=async(dir:string,ctx:Context)=>{for(const file of await list(dir))if(file.endsWith('.md')){try{await add(join(dir,file),ctx,file.slice(0,-3));}catch(error){warn(agent,error);}}};
  const plugin=async(path:string,manifestFile:string,name:string,namespace?:string,skillDirs?:string[],scope:'user'|'project'='user',entries:string[]=[],selection?:string)=>{
   const canonical=await realpath(path);if(scope==='project'&&!inside(root,canonical))throw Error('project plugin escapes project');
   const manifestPath=join(path,manifestFile),text=await metadataText(manifestPath,canonical),manifest=JSON.parse(text);
   if(manifest.name!==name)throw Error('Invalid plugin manifest');
   const entryDigests=[];for(const entry of entries){const target=resolve(path,entry);entryDigests.push({path:await realpath(target),digest:digest(await metadataText(target,canonical))});}
   const sourceFingerprint=digest(JSON.stringify({root:canonical,manifest:await realpath(manifestPath),digest:digest(text),entries:entryDigests,selection}));
   const ctx:Context={origin:'plugin',namespace,bound:canonical,packageName:name,sourceFingerprint};
   for(const dir of skillDirs??array(manifest.skills).concat('skills'))await walk(resolve(path,dir),ctx);
  };
  // Each native host applies its own scope and name precedence below.
  const roots=agent==='codex'?[join(codex,'skills'),join(home,'.agents/skills')]:agent==='claude'?[join(claude,'skills')]:agent==='opencode'?[join(env.XDG_CONFIG_HOME??join(home,'.config'),'opencode/skills'),join(home,'.agents/skills')]:[join(omp,'skills')];
  for(const path of agent==='opencode'?[]:roots)await walk(path,local(path));
  if(agent!=='opencode')await walk(join(root,agents[agent].skillDirectory),local(join(root,agents[agent].skillDirectory)));
  for(const path of agent==='opencode'?[]:projectCommandRoots[agent])await commands(join(root,path),local(join(root,path)));
  const commandRoot=agent==='claude'?join(claude,'commands'):agent==='opencode'?join(env.XDG_CONFIG_HOME??join(home,'.config'),'opencode/commands'):agent==='omp'?join(omp,'commands'):undefined;
  if(commandRoot&&agent!=='opencode')await commands(commandRoot,local(commandRoot));
  if(agent==='opencode'){
   const standard=join(env.XDG_CONFIG_HOME??join(home,'.config'),'opencode'),custom=env.OPENCODE_CONFIG_DIR;
   const configAt=async(path:string)=>{try{return record(jsonc(await metadataText(path,inside(root,path)?root:undefined)));}catch{return {};}};
   const documents=async(dir:string)=>Promise.all(['opencode.json','opencode.jsonc'].map(async name=>({path:join(dir,name),value:await configAt(join(dir,name))})));
   const standardDocs=await documents(standard),customDocs=custom?await documents(custom):[];
   const explicit=env.OPENCODE_CONFIG?[{path:env.OPENCODE_CONFIG,value:await configAt(env.OPENCODE_CONFIG)}]:[];
   const disabled=['true','1'].includes(env.OPENCODE_DISABLE_PROJECT_CONFIG??'');
   const projectDocs=disabled?[]:[...await documents(root),...await documents(join(root,'.opencode'))];
   let inline:any={};try{inline=record(jsonc(env.OPENCODE_CONFIG_CONTENT??'{}'));}catch{}
   const v2=[...standardDocs,...customDocs,...explicit,...projectDocs,{value:inline}].some(doc=>Array.isArray(doc.value.plugins));
   const configs=[...(v2&&custom?customDocs:standardDocs),...explicit,...projectDocs,...(!v2?customDocs:[]),{path:'OPENCODE_CONFIG_CONTENT',value:inline}];
   const config:any={};for(const {value} of configs)for(const [key,item] of Object.entries(value)){config[key]=item&&typeof item==='object'&&!Array.isArray(item)?{...config[key],...item}:item;}
   const skillRoots=[join(home,'.claude/skills'),join(home,'.agents/skills'),...(!v2||!custom?[join(standard,'skills')]:[]),
    ...(!disabled?[join(root,'.claude/skills'),join(root,'.agents/skills'),join(root,'.opencode/skills')]:[]),...(custom?[join(custom,'skills')]:[]),
    ...array(config.skills?.paths).map(path=>resolve(root,path))];
   for(const path of skillRoots){const start=sources.length;await walk(path,{...local(path),pathNames:v2,skillRoot:path});
    // OpenCode's later config/skill directories replace the same invocation ID.
    const names=new Set(sources.slice(start).map(source=>source.name));for(let i=start-1;i>=0;i--)if(names.has(sources[i].name))sources.splice(i,1);
   }
   const commandRoots=[...(!v2||!custom?[join(standard,'command'),join(standard,'commands')]:[]),...(!disabled?projectCommandRoots.opencode.map(path=>join(root,path)):[]),...(custom?[join(custom,'command'),join(custom,'commands')]:[])];
   for(const path of commandRoots){const start=sources.length;await commands(path,local(path));const names=new Set(sources.slice(start).map(source=>source.name));for(let i=start-1;i>=0;i--)if(names.has(sources[i].name))sources.splice(i,1);}
   for(const {path,value} of configs)for(const [name,command] of Object.entries(value.command??{}) as [string,any][]){
    if(!wanted.has(name))continue;for(let i=sources.length-1;i>=0;i--)if(sources[i].name===name)sources.splice(i,1);
    if(typeof command?.template==='string'&&Buffer.byteLength(command.template)<=256000){const identity=path+'#command.'+name;inlineBodies.set(identity,command.template);sources.push({name,identity,origin:'local',digest:digest(JSON.stringify(command)),satisfies:true});}
   }
   const matches=(pattern:string,name:string)=>new RegExp('^'+pattern.replace(/[.+?^${}()|[\]\\]/g,'\\$&').replaceAll('*','.*')+'$').test(name);
   const loaded=new Map<string,{id:string;items:SkillSource[]}>();
   const autoRoots=[...(!v2||!custom?[standard]:[]),...(!disabled?[join(root,'.opencode')]:[]),...(custom?[custom]:[])];
   const auto=[];for(const base of autoRoots)for(const name of ['plugin','plugins'])for(const file of await list(join(base,name))){const target=join(base,name,file);if(v2?(await stat(target).catch(()=>undefined))?.isDirectory():/\.[cm]?[jt]s$/.test(file))auto.push({path:base,target});}
   const operations=[...auto,...configs.flatMap(({path,value})=>(Array.isArray(v2?value.plugins:value.plugin)?(v2?value.plugins:value.plugin):[]).flatMap((item:any)=>{const target=typeof item==='string'?item:item?.package;return typeof target==='string'?[{path,target}]:[];}))];
   for(const {path,target} of operations){
    if(v2&&target.startsWith('-')){for(const [key,item] of loaded)if(matches(target.slice(1),item.id))loaded.delete(key);continue;}
    if(v2&&[...loaded.values()].some(item=>matches(target,item.id)))continue;
    const official=/^(?:superpowers@)?(?:git\+)?https:\/\/github\.com\/obra\/superpowers(?:\.git)?(?:#.*)?$/.test(target)||/^(?:superpowers@)?github:obra\/superpowers(?:#.*)?$/.test(target);
    let localTarget:string|undefined;try{localTarget=target.startsWith('file://')?fileURLToPath(target):isAbsolute(target)?target:target.startsWith('.')?resolve(dirname(path),target):undefined;}catch(error){warn('superpowers',error);continue;}
    if(!official&&!localTarget)continue;
    const versionSeparator=target.lastIndexOf('@');const policyTarget='plugin:'+(isAbsolute(target)||versionSeparator<=0?target:target.slice(0,versionSeparator));
    if(v2&&configs.flatMap(doc=>doc.value.policies??[]).findLast((policy:any)=>policy.action==='integration.use'&&matches(policy.resource,policyTarget))?.effect==='deny')continue;
    try{
     let base:string;
     if(localTarget){localTarget=await realpath(localTarget);base=(await stat(localTarget)).isDirectory()?localTarget:resolve(dirname(localTarget),'../..');if(inside(root,path)&&!inside(root,await realpath(base)))throw Error('project plugin escapes project');}
     else {
      const cache=join(env.XDG_CACHE_HOME??join(home,'.cache'),'opencode');
      if(v2){const key=join(cache,'npm','git-superpowers-'+digest(target).slice(0,12));const generation=(await list(key)).filter(name=>/^\d+$/.test(name)).sort((a,b)=>Number(a)-Number(b)).at(-1);if(!generation)throw Error('missing current plugin generation');base=join(key,generation,'node_modules/superpowers');}
      else base=join(cache,'packages',process.platform==='win32'?target.replace(/[<>:"|?*\x00-\x1f]/g,'_'):target,'node_modules/superpowers');
     }
     const canonical=await realpath(base),manifestPath=join(base,'package.json'),manifestText=await metadataText(manifestPath,canonical),manifest=JSON.parse(manifestText);
     if(manifest.name!=='superpowers')throw Error('Invalid plugin manifest');
     const directEntry=localTarget&&(await stat(localTarget)).isFile()?localTarget:undefined;
     if(!directEntry&&(typeof manifest.main!=='string'||manifest.exports!==undefined))throw Error('Unrecognized Superpowers package entry; repair the official installation');
     const entry=directEntry??resolve(base,manifest.main);
     const entryText=await metadataText(entry,canonical);
     if(!recognizableOpenCodeRegistration(entryText,v2))throw Error('Superpowers loader does not register native skills; repair the official plugin entry');
     const id=v2?entryText.match(/export\s+default\s*\{\s*id\s*:\s*['"]([^'"]+)['"]/)?.[1]:'superpowers';
     if(!id)throw Error('plugin registration ID unavailable; repair configuration');
     const before=sources.length;
     const skillRoot=join(base,'skills'),ctx:Context={origin:'plugin',bound:canonical,packageName:'superpowers',pathNames:v2,skillRoot,sourceFingerprint:digest(JSON.stringify({root:canonical,manifest:await realpath(manifestPath),manifestDigest:digest(manifestText),entry:await realpath(entry),entryDigest:digest(entryText),id}))};
     for(const name of await list(skillRoot))if(!name.startsWith('.')&&(await stat(join(skillRoot,name)).catch(()=>undefined))?.isDirectory())try{await add(join(skillRoot,name,'SKILL.md'),ctx);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')warn('superpowers',error);}
     loaded.set(target,{id,items:sources.splice(before)});
    }catch(error){warn('superpowers',error);}
   }
   const pluginSources=[...loaded.values()].flatMap(item=>item.items);
   const localNames=new Set(sources.map(source=>source.name)),pluginNames=new Set(pluginSources.map(source=>source.name));
   if(!v2)for(let i=sources.length-1;i>=0;i--)if(pluginNames.has(sources[i].name))sources.splice(i,1);
   sources.push(...pluginSources.filter(source=>!v2||!localNames.has(source.name)));
   const permission=config.permission?.skill;
   const denied=(name:string)=>typeof permission==='string'?permission==='deny':Object.entries(permission??{}).findLast(([pattern])=>matches(pattern,name))?.[1]==='deny';
   for(const source of sources)if(denied(source.name)){source.satisfies=false;source.problem='OpenCode skill permission denies '+source.name+'; allow the native skill in effective permission.skill';}
   if(disabled)unavailable('OPENCODE_DISABLE_PROJECT_CONFIG prevents Rigup project entries; unset it or set it to false before preparing this project');
   if(['change-prepare','change-ready','change-deliver'].some(denied))unavailable('OpenCode permission.skill denies a Rigup project entry; allow change-prepare, change-ready and change-deliver');
  }
  if(agent==='codex'){
   const plugins:Record<string,any>={};
   for(const file of [join(codex,'config.toml'),join(root,'.codex/config.toml')])try{Object.assign(plugins,toml(await metadataText(file,inside(root,file)?root:undefined)).plugins??{});}catch{}
   for(const [id,value] of Object.entries(plugins)){
    if(value?.enabled!==true||!/^([\w.-]+)@([\w.-]+)$/.test(id))continue;
    const [name,market]=id.split('@');if(options.sdd&&!options.customSkills?.length&&name!==options.sdd)continue;
    const base=join(codex,'plugins/cache',market,name),versions=await list(base);
    const version=versions.includes('local')?'local':versions.filter(v=>valid(v)).sort(rcompare)[0];
    if(!version){warn(id,{code:'ENOENT'});continue;}
    if(versions.some(item=>item!=='local'&&!valid(item)))warn(id,undefined);
    try{await plugin(join(base,version),'.claude-plugin/plugin.json',name,name);}catch(error){warn(id,error);}
   }
  }
  if(agent==='claude'||agent==='omp'){
   const installed=(await json(join(claude,'plugins/installed_plugins.json'))).plugins??{};
   const marketplaces=agent==='claude'?await json(join(claude,'plugins/known_marketplaces.json')):{};
   const records=new Map<string,{record:any;origin:'claude'|'omp';project:boolean}[]>();
   for(const [id,items] of Object.entries(installed)){
    if(!Array.isArray(items)){warn(id,undefined);continue;}
    for(const record of items){if(!record||record.enabled===false||claudeSettings[id]===false||agent==='claude'&&claudeSettings[id]!==true)continue;
     const project=await matchingProject(record);if(record.scope!=='user'&&!project)continue;
     records.set(id,[...records.get(id)??[],{record,origin:'claude',project}]);}
   }
   let settings:any={};
   if(agent==='omp'){
    for(const base of [omp,join(root,'.omp')]){
     let value=await json(join(base,'settings.json'));for(const name of base===omp?['config.yml','config.yaml']:['config.yml']){try{value=record(parse(await metadataText(join(base,name),inside(root,base)?root:undefined)));break;}catch{}}
     settings={...settings,...value,skills:{...settings.skills,...value.skills}};
    }
    for(const [registry,isProject] of [[join(ompPlugins,'installed_plugins.json'),false],[join(root,'.omp/plugins/installed_plugins.json'),true]] as const){
     for(const [id,items] of Object.entries((await json(registry)).plugins??{})){
      if(!Array.isArray(items)||!items.length)continue;
      const active=items.filter(record=>record&&record.enabled!==false&&typeof record.installPath==='string').map(record=>({record,origin:'omp' as const,project:isProject}));
      if(!isProject||active.length)records.set(id,active);
     }
    }
    const userClaude=!array(settings.disabledProviders).includes('claude-plugins')&&array(settings.enabledProviders).some(id=>['claude-plugins','claude','*','all'].includes(id));
    for(const [id,items] of records)records.set(id,items.filter(item=>item.origin==='omp'||item.project||userClaude));
   }
   for(const [id,items] of records){
    const name=id.split('@')[0];
    for(const {record,origin,project} of items){try{
     if(typeof record.installPath!=='string'||!isAbsolute(record.installPath))throw Error('Invalid plugin location');
     let path=record.installPath,selection:string|undefined;
     const marketplace=marketplaces[id.slice(id.indexOf('@')+1)];
     if(agent==='claude'&&marketplace?.source?.source==='directory'){
      if(typeof marketplace.source.path!=='string'||!isAbsolute(marketplace.source.path)||typeof marketplace.installLocation!=='string')throw Error('Invalid local marketplace location');
      const base=await realpath(marketplace.source.path);
      if(await realpath(marketplace.installLocation)!==base)throw Error('Local marketplace location mismatch');
      const catalogPath=join(base,'.claude-plugin/marketplace.json'),text=await metadataText(catalogPath,base),catalog=JSON.parse(text);
      const entries=Array.isArray(catalog?.plugins)?catalog.plugins.filter((entry:any)=>entry?.name===name):[];
      if(catalog?.name!==id.slice(id.indexOf('@')+1)||entries.length!==1||typeof entries[0].source!=='string'||!entries[0].source.startsWith('./'))throw Error('Invalid local marketplace plugin source');
      path=await realpath(resolve(base,entries[0].source));
      if(!inside(base,path))throw Error('Local marketplace plugin escapes its root');
      selection=digest(JSON.stringify({base,catalog:await realpath(catalogPath),digest:digest(text),source:marketplace.source,installLocation:marketplace.installLocation}));
     }else if(agent==='claude'&&!inside(await realpath(claude),await realpath(path)))throw Error('Invalid plugin location');
     await plugin(path,'.claude-plugin/plugin.json',name,agent==='claude'?name:undefined,undefined,origin==='omp'&&project?'project':'user',[],selection);
    }catch(error){warn(id,error);}}
   }
   if(agent==='omp'){
    const overrides=await json(join(root,'.omp/plugin-overrides.json'));
    const packages=new Map<string,{path:string;entries:string[];scope:'user'|'project'}>();
    for(const [base,scope] of [[ompPlugins,'user'],[join(root,'.omp/plugins'),'project']] as const){
     const pkg=await json(join(base,'package.json')),lock=await json(join(base,'omp-plugins.lock.json'));
     const declared=Object.keys(pkg.dependencies??{});
     for(const name of new Set([...declared,...Object.keys(lock.plugins??{})])){
      if(!/^(?:@[\w.-]+\/)?[\w.-]+$/.test(name)||lock.plugins?.[name]?.enabled===false||overrides.disabled?.includes(name))continue;
      const path=join(base,'node_modules',name);
      if(pkg.dependencies&&!declared.includes(name)&&!(await lstat(path).catch(()=>undefined))?.isSymbolicLink())continue;
      const manifest=await json(join(path,'package.json')),native=manifest.omp??manifest.pi;
      if(!native||manifest.name!==name)continue;
      packages.set(name,{path,entries:array(native.extensions),scope});
     }
    }
    for(const [name,{path,entries,scope}] of packages)try{await plugin(path,'package.json',name,undefined,['skills'],scope,entries);}catch(error){warn(name,error);}
    if(settings.skills?.enabled===false){sources.length=0;unavailable('skills.enabled:false blocks native and Rigup project skills; set skills.enabled to true in OMP settings');}
    else {
     const excluded=(name:string)=>array(settings.skills?.ignoredSkills).some(pattern=>matchesGlob(name,pattern))||array(settings.disabledExtensions).includes('skill:'+name)||array(settings.skills?.includeSkills).length>0&&!array(settings.skills?.includeSkills).some(pattern=>matchesGlob(name,pattern));
     for(let i=sources.length-1;i>=0;i--){
      const source=sources[i];
      if(commandSources.has(source.identity))continue;
      const nativeProject=source.identity.startsWith('.omp/skills/');
      const nativeUser=isAbsolute(source.identity)&&inside(join(omp,'skills'),source.identity);
      if(excluded(source.name)||nativeProject&&settings.skills?.enablePiProject===false||nativeUser&&settings.skills?.enablePiUser===false)sources.splice(i,1);
     }
     if(settings.skills?.enablePiProject===false||['change-prepare','change-ready','change-deliver'].some(excluded))unavailable('OMP project skill settings prevent Rigup project entries; enable skills.enablePiProject and allow change-prepare, change-ready and change-deliver in ignoredSkills/includeSkills/disabledExtensions');
    }
   }
  }
  if(agent!=='opencode'){
   const priority=(source:SkillSource)=>source.origin==='plugin'?0:agent==='claude'?(isAbsolute(source.identity)?2:1):(isAbsolute(source.identity)?1:2);
   const ranks=new Map<string,number>();for(const source of sources)ranks.set(source.name,Math.max(ranks.get(source.name)??0,priority(source)));
   for(let i=sources.length-1;i>=0;i--)if(priority(sources[i])<ranks.get(sources[i].name)!)sources.splice(i,1);
  }
  if(options.sdd==='spec-kit'&&sources.length&&!sources.some(source=>source.problem)){
   const checked=new Map<string,string>(),templates=new Set<string>();let failure:string|undefined;
   const present=async(path:string)=>(await stat(join(root,path)).catch(()=>undefined))?.isFile();
   const readChecked=async(path:string)=>{
    if(checked.size>=100&&!checked.has(path))throw Error('Spec Kit dependency budget exceeded');
    const target=await safePath(root,path),text=await metadataText(target,root);checked.set(path,JSON.stringify([await realpath(target),digest(text)]));return text;
   };
   const templateIds=(text:string)=>[...text.matchAll(/(?:resolve_template(?:_content)?(?:\s+|\(\s*)|Resolve-Template(?:Content)?\s+-TemplateName\s+)['"]([a-z-]+-template)['"]/g)].map(match=>match[1]);
   const template=async(name:string,depth:number)=>{
    if(templates.has(name))return;templates.add(name);
    const override='.specify/templates/overrides/'+name+'.md';
    if(await present(override)){await inspect(override,depth,true);return;}
    let baseFound=false;
    for(const kind of ['presets','extensions'] as const){
     const base='.specify/'+kind,registryPath=base+'/.registry';
     let registry:Record<string,any>|undefined;
     if(await present(registryPath)){
      try{const parsed=JSON.parse(await readChecked(registryPath));if(!parsed||typeof parsed!=='object'||!parsed[kind]||typeof parsed[kind]!=='object'||Array.isArray(parsed[kind]))throw Error('invalid template registry');registry=parsed[kind];}
      catch{if(kind==='extensions')throw Error('invalid extension template registry');}
     }
     const candidates=new Map<string,number>();
     for(const [id,value] of Object.entries(registry??{}))if(/^[a-z0-9-]+$/.test(id)&&value&&typeof value==='object'&&value.enabled!==false)candidates.set(id,Number.isInteger(Number(value.priority))&&Number(value.priority)>0?Number(value.priority):10);
     if(!registry||kind==='extensions')for(const id of await list(join(root,base)))if(/^[a-z0-9-]+$/.test(id)&&!Object.hasOwn(registry??{},id))candidates.set(id,10);
     for(const [id] of [...candidates].sort(([a,ap],[b,bp])=>ap-bp||a.localeCompare(b))){
      let strategy='replace',declared=false,candidate:string|undefined;
      const manifest=base+'/'+id+'/preset.yml';
      if(kind==='presets'&&await present(manifest)){
       const value=parse(await readChecked(manifest)),provided=value?.provides?.templates;
       if(!Array.isArray(provided)||!provided.length)throw Error('invalid preset template manifest');
       for(const entry of provided)if(!entry||!['template','command','script'].includes(entry.type)||typeof entry.name!=='string'||typeof entry.file!=='string'||!['replace','append','prepend','wrap'].includes((entry.strategy??'replace').toLowerCase()))throw Error('invalid preset template declaration');
       const entry=provided.find(item=>item.type==='template'&&item.name===name);
       if(entry){declared=true;strategy=(entry.strategy??'replace').toLowerCase();const target=resolve(root,base,id,entry.file);if(!inside(join(root,base,id),target))throw Error('preset template escapes its root');if(await present(relative(root,target)))candidate=relative(root,target);}
      }
      if(!declared)for(const path of [base+'/'+id+'/templates/'+name+'.md',base+'/'+id+'/'+name+'.md'])if(await present(path)){candidate=path;break;}
      if(!candidate)continue;
      await inspect(candidate,depth,true);
      if(strategy==='wrap'&&!(await readChecked(candidate)).includes('{CORE_TEMPLATE}'))throw Error('wrap template missing CORE_TEMPLATE');
      if(strategy==='replace'){baseFound=true;break;}
     }
     if(baseFound)break;
    }
    if(!baseFound)await inspect('.specify/templates/'+name+'.md',depth,true);
   };
   const inspect=async(path:string,depth=0,selectedTemplate=false):Promise<void>=>{
    if(checked.has(path)||depth>8)return;
    try{
     if(!selectedTemplate&&/^\.specify\/templates\/[^/]+\.md$/.test(path)){await template(path.slice('.specify/templates/'.length,-3),depth+1);return;}
     const text=await readChecked(path);
     if(path.startsWith('.specify/scripts/')){
      for(const ref of references(text))await inspect(ref,depth+1);
      for(const ref of text.matchAll(/\$(?:SCRIPT_DIR|PSScriptRoot)[\/\\]([\w.-]+\.(?:sh|ps1))/g))await inspect(join(dirname(path),ref[1]),depth+1);
      for(const ref of text.matchAll(/Join-Path\s+\$PSScriptRoot\s+['"]([\w.-]+\.ps1)['"]/g))await inspect(join(dirname(path),ref[1]),depth+1);
      if(path.endsWith('.py')&&/^\s*from\s+\.?common\s+import\s/m.test(text))await inspect(join(dirname(path),'common.py'),depth+1);
      for(const name of templateIds(text))await template(name,depth+1);
     }
    }catch{failure??='missing or invalid native dependency: '+path+'; restore it from the current Spec Kit integration before retrying';}
   };
   const references=(text:string)=>[...text.matchAll(/\.specify\/(?:scripts|templates)\/[\w./-]+\.(?:sh|ps1|py|md|json|ya?ml)\b/g)].map(match=>match[0]).filter(path=>!path.startsWith('.specify/templates/overrides/'));
   await inspect('.specify/memory/constitution.md');
   const required=new Set(sddDiscoveryNames('spec-kit',false));
   for(const source of sources.filter(source=>required.has(source.name))){
    try{const text=inlineBodies.get(source.identity)??await metadataText(isAbsolute(source.identity)?source.identity:join(root,source.identity));for(const path of references(text))await inspect(path);
     // Upstream resolves these fixed template IDs through the current resolver.
     for(const match of text.matchAll(/resolve-template\.(?:sh|ps1|py)[`'" ]+([a-z-]+)/g))if(/^(?:spec|plan|tasks|constitution|checklist)(?:-template)?$/.test(match[1]))await inspect('.specify/templates/'+match[1].replace(/-template$/,'')+'-template.md');
    }catch{/* Inline host commands carry their own source digest. */}
   }
   for(const hook of hooks){
    if(typeof hook.command!=='string')continue;
    const entry=sources.find(source=>[hook.command,hook.command.replaceAll('.','-')].includes(source.name)&&source.satisfies);
    if(!entry)failure??='missing mandatory native hook: '+hook.command+'; reinstall or repair the enabled Spec Kit extension';
   }
   const fingerprint=digest(JSON.stringify({dependencies:[...checked].sort(),hooks}));
   for(const source of sources){source.sourceFingerprint=digest((source.sourceFingerprint??'')+fingerprint);if(failure){source.satisfies=false;source.problem=failure;}}
  }
  if(metadataExhausted){sources.length=0;unavailable('Native metadata read budget exceeded; reduce or repair the effective native installation');}
  if(!sources.length)delete result[agent];
 }
 return result;
}

// Recognize the audited upstream registration, without importing or executing a plugin.
// Unknown loaders must be repaired or exposed as native skills before binding.
function recognizableOpenCodeRegistration(source:string,v2:boolean):boolean {
 const code=source.replace(/\/\*[\s\S]*?\*\//g,'').replace(/^\s*\/\/.*$/gm,'').replace(/\s+/g,'');
 if(!/constsuperpowersSkillsDir=path\.resolve\(__dirname,['"]\.\.\/\.\.\/skills['"]\)/.test(code))return false;
 if(!v2)return /exportconstSuperpowersPlugin=async\(/.test(code)&&code.includes('config:async(config)=>{')&&code.includes('config.skills.paths.push(superpowersSkillsDir)');
 return code.includes('asyncfunctionsetup(ctx){')&&/exportdefault\{id:['"][^'"]+['"],server:SuperpowersPlugin,setup,?\}/.test(code)&&
  code.includes('fs.readdirSync(superpowersSkillsDir,{withFileTypes:true})')&&code.includes("path.join(superpowersSkillsDir,entry.name,'SKILL.md')")&&
  code.includes('id:entry.name,')&&code.includes('path:skillPath,')&&code.includes('awaitctx.skill.transform((draft)=>{')&&code.includes('draft.add(skill)');
}
