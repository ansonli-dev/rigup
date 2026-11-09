import {discoverNativeSources,nativeSkillMetadata,type NativeDiscoveryOptions} from './native-sources.js';
import {agents} from '../integrations/agents/index.js';
import type {Agent} from '../types.js';
import {readdir,readFile,realpath,stat,lstat} from 'node:fs/promises';
import {join,relative,dirname} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import type {SetupOptions,CommandSpec} from '../types.js';
import {projectInput,type Ownership} from '../managed-input.js';
import {digest,safePath,sliceEvidence,type EvidenceRead,type ReadEvidence} from './evidence.js';
import {filterContent,secretName,READ_POLICY_VERSION} from './read-policy.js';
import type {SearchSelection} from './backend.js';
import {loadResearchIgnore,workflowEvidenceKind} from './research-ignore.js';
import {checkPrerequisites,hasTestDatabaseGuard,jestSetupPath,linkDatabaseGuards,type SpecializedCheck} from './check-prerequisites.js';
const exec=promisify(execFile);
const specializedScripts=['test:e2e','test-e2e','check-types','typecheck','deps:validate','test'];
export interface ProjectProfile {research?:import('./backend.js').ResearchResult;installedTools?:Record<string,{version:string;packageLockDigest:string}>;initializedTools?:Record<string,import('../types.js').NativeInitializationReceipt>;nativeEntries?:Partial<Record<import('../types.js').Agent,string[]>>;skillSources?:Partial<Record<import('../types.js').Agent,import('../integrations/registry.js').SkillSource[]>>;root:string;fingerprint:string;files:string[];researchFiles?:string[];ignoreFingerprint?:string;git:{available:boolean;head?:string};commands:Record<string,CommandSpec[]>;specializedChecks:SpecializedCheck[];unknowns:string[];truncated:boolean;readPolicyVersion:string;researchBlocked?:string}
export async function scanRepository(root:string,options:SetupOptions,discovery:NativeDiscoveryOptions={},generatedScopes:string[]=[]):Promise<ProjectProfile>{
 return (await inventory(root,options,discovery,generatedScopes)).profile;
}
async function inventory(root:string,options:SetupOptions,discovery:NativeDiscoveryOptions={},generatedScopes:string[]=[]){
 root=await realpath(root);
 if(options.scope?.some(s=>s.startsWith('/')||s.split('/').includes('..')||s.includes('\\'))) throw new Error('scope: invalid relative path');
 const profile:ProjectProfile={root,fingerprint:'',files:[],git:{available:false},commands:{build:[],lint:[],test:[],environment:[],eval:[]},specializedChecks:[],unknowns:[],truncated:false,readPolicyVersion:READ_POLICY_VERSION};
 try {
  await exec('git',['-C',root,'rev-parse','--show-toplevel'],{env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}});
  profile.git.available=true;
  try {profile.git.head=(await exec('git',['-C',root,'rev-parse','--verify','HEAD'],{env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}})).stdout.trim();}catch{profile.unknowns.push('Git HEAD: unborn');}
 }catch{/* Non-Git repositories are valid. */}
 const managed=await loadManaged(root,profile);
 const inputs:string[]=[];let bytes=0;
 const ignored=await loadResearchIgnore(root);
 if(ignored.fingerprint){profile.ignoreFingerprint=ignored.fingerprint;inputs.push('.rigupignore\0'+ignored.fingerprint);}
 if(options.projectRules||ignored.fingerprint)profile.researchFiles=[];
 const quality=options.quality;
 const configuredScripts=[...(quality?.preCommit??[]),...(quality?.prePush??[]),...(quality?.gitlab?.checks??[])]
  .filter(ref=>typeof ref!=='string');
 const jestSetups=new Map<string,string>(),testGuards=new Set<string>();
 const maxFiles=options.readBudget?.maxFiles ?? 2000;const maxBytes=options.readBudget?.maxBytes ?? 8_000_000;
 async function walk(dir:string):Promise<void>{
  for(const entry of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
   if(['.git','node_modules','dist','.superpowers'].includes(entry.name)||secretName.test(entry.name)) continue;
   const file=join(dir,entry.name);const path=relative(root,file).split('\\').join('/');
   if(generatedScopes.some(scope=>path===scope||path.startsWith(scope+'/')))continue;
   if(path==='.rigupignore')continue;
   const outsideScope=!!options.scope?.length&&!options.scope.some(s=>path === s || path.startsWith(s+'/') || s.startsWith(path+'/'));
   const excluded=ignored.excludes(path,entry.isDirectory())||outsideScope;
   const workflow=options.projectRules?workflowEvidenceKind(path,entry.isDirectory()):undefined;
   if(workflow==='generated')continue;
   if(outsideScope&&!options.projectRules)continue;
   if((managed.get(path)??[]).some(o=>o.kind==='file')) continue;
   if(path.startsWith('.rigup/baseline/')||path === '.rigup/manifest.json'||path === '.rigup/config.yaml'||path.startsWith('.rigup/tools/')||path==='.rigup/check-results') continue;
   if(entry.isSymbolicLink()){profile.unknowns.push(path+': symlink skipped');continue;}
   if(entry.isDirectory()){
    try{await walk(file);}catch(error){if(!excluded||!['EACCES','EPERM'].includes((error as NodeJS.ErrnoException).code??''))throw error;}
    continue;
   }
   if(!entry.isFile()) continue;
   const discoveryEntry=Object.values(agents).some(host=>path.startsWith(host.skillDirectory+'/')&&path.endsWith('/SKILL.md'))||/^\.(?:claude|opencode|omp)\/commands\/.+\.md$/.test(path);
   if(excluded&&!discoveryEntry&&entry.name!=='package.json')continue;
   if(profile.files.length>=maxFiles){profile.truncated=true;profile.unknowns.push('file budget reached');return;}
   let raw:Buffer;let visible:string;
   try {const filePath=await safePath(root,path);if((await stat(filePath)).size+bytes>maxBytes){profile.truncated=true;profile.unknowns.push(path+': byte budget reached');continue;}raw=await readFile(filePath);if(bytes+raw.length>maxBytes){profile.truncated=true;profile.unknowns.push(path+': byte budget reached');continue;}}
   catch {profile.unknowns.push(path+': unreadable or denied by policy');continue;}
   bytes+=raw.length;
   const text=raw.toString('utf8'),ownership=managed.get(path)??[];
   let projected:string|null;
   try {projected=projectInput(text,ownership);}catch {profile.truncated=true;profile.unknowns.push(path+': ownership projection failed');continue;}
   if(projected === null || projected === '' && managed.has(path)) continue;
   try{visible=visibleText(path,text,ownership);}catch{profile.unknowns.push(path+': unreadable or denied by policy');continue;}
   profile.files.push(path);
   if(workflow!=='entry'&&!excluded)profile.researchFiles?.push(path);
   for(const agent of Object.keys(agents) as Agent[]) {
    const host=agents[agent];
    if(path.startsWith(host.skillDirectory+'/') && path.endsWith('/SKILL.md')) {
     try {
       const metadata=nativeSkillMetadata(visible);
      if(metadata) {
       profile.nativeEntries ??= {};profile.nativeEntries[agent] ??= [];profile.nativeEntries[agent]!.push(metadata.name);
       profile.skillSources ??= {};profile.skillSources[agent] ??= [];profile.skillSources[agent]!.push({name:metadata.name,origin:'local',identity:path,digest:digest(raw),satisfies:metadata.satisfies});
      }
     }catch {profile.unknowns.push(path+': native skill metadata invalid');}
    }
    const commandDir=agent === 'codex' ? undefined : agent === 'claude' ? '.claude/commands/' : agent === 'omp' ? '.omp/commands/' : '.opencode/commands/';
    if(commandDir && path.startsWith(commandDir) && path.endsWith('.md')) {
     profile.nativeEntries ??= {};profile.nativeEntries[agent] ??= [];const name=path.slice(commandDir.length,-3);profile.nativeEntries[agent]!.push(name);profile.skillSources??={};profile.skillSources[agent]??=[];profile.skillSources[agent]!.push({name,origin:'local',identity:path,digest:digest(raw),satisfies:!/^dependencies:/m.test(visible)});
    }
   }
   inputs.push(path+'\0'+digest(ownership.length?filterContent(path,projected):visible));
   if(/\.[cm]?[jt]s$/.test(entry.name)&&hasTestDatabaseGuard(visible))testGuards.add(path);
   if(/jest.*\.json$/i.test(entry.name)){
    try{
     const setup=jestSetupPath(path,JSON.parse(visible).globalSetup);
     if(setup)jestSetups.set(path,setup);
    }catch{/* Other JSON configuration has no recognized Jest setup. */}
   }
   if(entry.name === 'package.json') {
    try {
     const manifest=JSON.parse(visible),{scripts}=manifest;
     const cwd=dirname(path);
     for(const kind of Object.keys(profile.commands))if(typeof scripts?.[kind]==='string')profile.commands[kind].push({executable:'npm',args:['run',kind],cwd,envRefs:[]});
     const checks=new Set([...specializedScripts,...configuredScripts.filter(ref=>ref.cwd===cwd).map(ref=>ref.script)]);
     for(const script of checks){
      if(typeof scripts?.[script]!=='string'||!scripts[script].trim())continue;
      const command={executable:'npm',args:['run',script],cwd,envRefs:[]};
      profile.specializedChecks.push({command,source:path,...checkPrerequisites(scripts[script],manifest,cwd)});
     }
    }catch{profile.unknowns.push(path+': unsupported package manifest');}
   }
  }
 }
 await walk(root);profile.specializedChecks=linkDatabaseGuards(profile.specializedChecks,jestSetups,testGuards);const external=await discoverNativeSources(root,options,discovery);for(const [key,sources]of Object.entries(external)){const agent=key as Agent;profile.skillSources??={};profile.skillSources[agent]=[...(profile.skillSources[agent]??[]),...sources];profile.nativeEntries??={};profile.nativeEntries[agent]=[...(profile.nativeEntries[agent]??[]),...sources.map(s=>s.name)];}inputs.push('native-sources\0'+digest(JSON.stringify(external)));profile.fingerprint=digest(inputs.join('\n')+'\n'+READ_POLICY_VERSION+'\n'+JSON.stringify({unknowns:profile.unknowns,truncated:profile.truncated}));return {profile,managed};
}

function visibleText(path:string,raw:string,ownership:Ownership[]):string {
 const projected=projectInput(raw,ownership,true);
 return projected===null?'':filterContent(path,projected);
}

export interface ReaderDependencies {budget?:{calls:number;bytes:number};persist?:()=>Promise<void>;expectedFingerprint?:string}
export async function repositoryReader(root:string,options:SetupOptions,dependencies:ReaderDependencies={}){
 const {profile,managed}=await inventory(root,options);
 root=profile.root;
 if(dependencies.expectedFingerprint&&profile.fingerprint!==dependencies.expectedFingerprint)throw new Error('reader source fingerprint changed during preparation');
 if(profile.researchBlocked)throw new Error(profile.researchBlocked);
 const allowed=new Set(profile.researchFiles??profile.files);
 const spent=dependencies.budget??{bytes:0,calls:0};if(!Number.isSafeInteger(spent.bytes)||spent.bytes<0||!Number.isSafeInteger(spent.calls)||spent.calls<0)throw new Error('reader budget state invalid');
 const maxBytes=options.readBudget?.maxBytes ?? 8_000_000;const maxCalls=options.readBudget?.maxFiles ?? 2000;
 let budgetWrites=Promise.resolve();
 const charge=async(size:number)=>{
  if(spent.calls>=maxCalls||spent.bytes+size>maxBytes)throw new Error('reader budget exceeded');
  spent.calls++;spent.bytes+=size;
  if(dependencies.persist){budgetWrites=budgetWrites.then(dependencies.persist);await budgetWrites;}
 };
 const loadLines=async(path:string)=>{
  if(!allowed.has(path)) throw new Error('path outside reader inventory');
  await charge((await stat(await safePath(root,path))).size);
  const raw=await readFile(await safePath(root,path),'utf8');
  return visibleText(path,raw,managed.get(path)??[]).split('\n');
 };
 const cacheLines=()=>{
  const files=new Map<string,Promise<string[]>>();
  return (path:string)=>{
   let pending=files.get(path);
   if(!pending){pending=loadLines(path);files.set(path,pending);}
   return pending;
  };
 };
 const read:ReadEvidence=async(path,start,end)=>sliceEvidence(path,await loadLines(path),start,end);
 // Searches share filtered files while loading only the paths they need.
 const searchLines=cacheLines();
 return {
  list:async()=>[...allowed],read,
  evidencePass:():ReadEvidence=>{
   const passLines=cacheLines();
   return async(path,start,end)=>sliceEvidence(path,await passLines(path),start,end);
  },
  search:async(query:string,selection?:SearchSelection)=>{
   if(selection&&(!Number.isSafeInteger(selection.limit)||selection.limit<1))throw new Error('invalid search match limit');
   const matches:EvidenceRead[]=[];
   for(const path of allowed){
    if(selection&&!selection.paths.has(path))continue;
    const lines=await searchLines(path);
    for(let i=0;i<lines.length;i++)if(lines[i].includes(query)){
     matches.push(sliceEvidence(path,lines,i+1,i+1));
     if(selection&&matches.length>=selection.limit)return matches;
    }
   }
   return matches;
  }
 };
}

async function loadManaged(root:string,profile:Pick<ProjectProfile,'unknowns'|'truncated'|'researchBlocked'>):Promise<Map<string,Ownership[]>>{
 const managed=new Map<string,Ownership[]>();const committedNative=new Set<string>();let sawManifest=false;let untrusted=false;
 try{
  const manifest=JSON.parse(await readFile(await safePath(root,'.rigup/manifest.json'),'utf8'));sawManifest=true;
  if(manifest.schemaVersion!==1||!Array.isArray(manifest.assets))throw new Error('manifest structure');
  for(const [id,receipt] of Object.entries(manifest.initializedTools??{}) as [string,import('../types.js').NativeInitializationReceipt][]){
   if(!['codegraph','openwiki'].includes(id)){untrusted=true;continue;}
   committedNative.add(id);
   const target=id==='codegraph'?'.codegraph':'openwiki',control='.rigup/native/'+id;
   // Quarantine a known native output even when its ownership proof broke.
   for(const scope of [target,control,...(id==='codegraph'?['.codegraph-rigup-init']:[])])managed.set(scope,[{kind:'file'}]);
   try{
    const info=await lstat(await safePath(root,target));const marker=JSON.parse(await readFile(await safePath(root,control+'/promotion.json'),'utf8'));
    if(!info.isDirectory()||receipt.target!==target||receipt.identity!==String(info.dev)+':'+String(info.ino)||marker.root!==root||marker.id!==id||marker.version!==receipt.version||marker.target!==target||marker.identity!==receipt.identity)throw Error('native ownership mismatch');
   }catch{untrusted=true;}
  }
  for(const asset of manifest.assets){
   const target=asset?.target;
   if(typeof target!=='string'||target.startsWith('/')||target.includes('\\')||target.split('/').some((p:string)=>!p||p==='.'||p==='..')){untrusted=true;continue;}
   const ownership=asset.ownership as Ownership;
   if(!ownership||!['file','block','json-key','toml-table'].includes(ownership.kind)){managed.set(target,[{kind:'file'}]);untrusted=true;continue;}
   managed.set(target,[...(managed.get(target)??[]),ownership]);
   try{if(typeof asset.baseline!=='string'||!asset.baseline.startsWith('.rigup/baseline/'))throw new Error('baseline path');const baseline=await readFile(await safePath(root,asset.baseline));if(digest(baseline)!==asset.digest)throw new Error('baseline digest');}catch{untrusted=true;}
  }
 }catch(error){
  if(sawManifest||(error as NodeJS.ErrnoException).code!=='ENOENT')untrusted=true;
  else {try{await safePath(root,'.rigup/baseline');untrusted=true;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')untrusted=true;}}
 }
 for(const id of ['openwiki','codegraph']){
  if(committedNative.has(id))continue;
  const control='.rigup/native/'+id,target=id==='openwiki'?'openwiki':'.codegraph';let pending=false;
  // These are explicit Rigup intent/promotion metadata, not a directory-name
  // heuristic. An interrupted or ambiguous record blocks research rather than
  // claiming ownership of similarly named user material.
  for(const marker of ['intent.json','promotion.json'])try{await lstat(await safePath(root,control+'/'+marker));pending=true;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')pending=true;}
  if(!pending)continue;
  for(const scope of [control,target,...(id==='codegraph'?['.codegraph-rigup-init']:[])])managed.set(scope,[{kind:'file'}]);
  profile.unknowns.push(id+': native ownership pending; semantic research blocked');profile.truncated=true;profile.researchBlocked='native initialization has no committed ownership receipt; resume or reconcile before semantic research';
 }
 if(untrusted){for(const target of managed.keys())managed.set(target,[{kind:'file'}]);profile.unknowns.push('ownership metadata untrusted; semantic cache disabled');profile.truncated=true;profile.researchBlocked='ownership/baseline untrusted; reconcile metadata before semantic research or reuse';}
 return managed;
}
