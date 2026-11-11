import {discoverNativeSources,nativeSkillMetadata,type NativeDiscoveryOptions} from './native-sources.js';
import {agents} from '../integrations/agents/index.js';
import type {Agent} from '../types.js';
import {readdir,readFile,realpath,stat,lstat} from 'node:fs/promises';
import {join,relative,posix} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {scopeContains,scopesOverlap,type SetupOptions,type CommandSpec,type GitlabJobBinding,type Evidence} from '../types.js';
import {discoverGitlabJobs} from '../integrations/gitlab/ci.js';
import {projectChecks,npmScript} from '../integrations/tools/check-catalog.js';
import {documentTargetKey,readConventionDocument,validateConventionReceipts,type ConventionPage,type ConventionReceipt} from '../project-conventions.js';
import {projectInput,type Ownership} from '../managed-input.js';
import {digest,safePath,sliceEvidence,type EvidenceRead,type ReadEvidence} from './evidence.js';
import {filterContent,secretName,READ_POLICY_VERSION} from './read-policy.js';
import type {SearchSelection} from './backend.js';
import {loadResearchIgnore,workflowEvidenceKind} from './research-ignore.js';
import {checkPrerequisites,hasTestDatabaseGuard,jestSetupPath,linkDatabaseGuards,type SpecializedCheck} from './check-prerequisites.js';
const exec=promisify(execFile);
const specializedScripts=['test:e2e','test-e2e','check-types','typecheck','deps:validate','test'];
export interface ProjectProfile {research?:import('./backend.js').ResearchResult;installedTools?:Record<string,{version:string;packageLockDigest:string}>;initializedTools?:Record<string,import('../types.js').NativeInitializationReceipt>;nativeEntries?:Partial<Record<import('../types.js').Agent,string[]>>;skillSources?:Partial<Record<import('../types.js').Agent,import('../integrations/registry.js').SkillSource[]>>;root:string;fingerprint:string;files:string[];researchFiles?:string[];ignoreFingerprint?:string;git:{available:boolean;head?:string};commands:Record<string,CommandSpec[]>;specializedChecks:SpecializedCheck[];gitlabJobs?:GitlabJobBinding[];gitlabReviewRequired?:true;checkCoverageIncomplete?:true;checkManifests?:string[];declaredSources?:Record<string,Evidence>;conventions?:ConventionPage[];conventionPaths?:string[];extraSourcePaths?:string[];unknowns:string[];truncated:boolean;readPolicyVersion:string;researchBlocked?:string}
export async function scanRepository(root:string,options:SetupOptions,discovery:NativeDiscoveryOptions={},generatedScopes:string[]=[]):Promise<ProjectProfile>{
 return (await inventory(root,options,discovery,generatedScopes)).profile;
}
export async function scanInstallationSources(root:string,options:SetupOptions,generatedScopes:string[]):Promise<ProjectProfile>{
 // Keep installation snapshot coverage stable when research evidence rules change.
 return (await inventory(root,options,{},generatedScopes,'installation')).profile;
}
async function inventory(root:string,options:SetupOptions,discovery:NativeDiscoveryOptions={},generatedScopes:string[]=[],purpose:'research'|'installation'='research'){
 root=await realpath(root);
 if(options.scope?.some(s=>s.startsWith('/')||s.split('/').includes('..')||s.includes('\\'))) throw new Error('scope: invalid relative path');
 const profile:ProjectProfile={root,fingerprint:'',files:[],git:{available:false},commands:{build:[],lint:[],test:[],environment:[],eval:[]},specializedChecks:[],unknowns:[],truncated:false,readPolicyVersion:READ_POLICY_VERSION};
 try {
  await exec('git',['-C',root,'rev-parse','--show-toplevel'],{env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}});
  profile.git.available=true;
  try {profile.git.head=(await exec('git',['-C',root,'rev-parse','--verify','HEAD'],{env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}})).stdout.trim();}catch{profile.unknowns.push('Git HEAD: unborn');}
 }catch{/* Non-Git repositories are valid. */}
 const {managed,receipts}=await loadManaged(root,profile);
 const inputs:string[]=[];let bytes=0;
 const ignored=await loadResearchIgnore(root);
 if(ignored.fingerprint){profile.ignoreFingerprint=ignored.fingerprint;inputs.push('.rigupignore\0'+ignored.fingerprint);}
 const gitlabPath='.gitlab-ci.yml';
 const scopes=options.scope?.length?options.scope:['.'];
 const declaredSources=new Map<string,string[]>();
 for(const topic of options.projectConventions?.topics??[])if(topic.source){
  declaredSources.set(topic.source,[...(declaredSources.get(topic.source)??[]),...topic.scope]);
 }
 const extraSources=[
  ...[...declaredSources].filter(([,scope])=>scopesOverlap(scopes,scope)).map(([path])=>path),
  ...receipts.filter(receipt=>!profile.researchBlocked&&scopesOverlap(scopes,[receipt.scope])).map(receipt=>receipt.target),
 ];
 if(extraSources.length)profile.extraSourcePaths=extraSources;
 const registered=new Map(receipts.map(receipt=>[documentTargetKey(receipt.target),receipt]));
 const projection=(path:string,raw:string)=>projectSource(path,raw,managed.get(path)??[],scopes,registered.get(documentTargetKey(path)),declaredSources.get(path));
 const selectedScope=(path:string)=>!options.scope?.length||options.scope.some(scope=>scopeContains(scope,path));
 if(purpose==='research'&&(!selectedScope(gitlabPath)||ignored.excludes(gitlabPath,false))){
  profile.gitlabReviewRequired=true;
  profile.unknowns.push(gitlabPath+': outside approved inventory; existing GitLab coverage is unverified');
 }
 const workflowScope=options.projectRules?(purpose==='installation'?'installation':'all'):
  purpose==='research'&&options.sdd==='spec-kit'?'spec-kit':undefined;
 if(workflowScope||ignored.fingerprint)profile.researchFiles=[];
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
   const outsideBusinessScope=!selectedScope(path)&&!(entry.isDirectory()&&options.scope?.some(scope=>scopeContains(path,scope)));
   const extraSource=extraSources.some(source=>source===path||entry.isDirectory()&&scopeContains(path,source));
   const outsideScope=outsideBusinessScope&&!extraSource;
   const excluded=ignored.excludes(path,entry.isDirectory())||outsideScope;
   const workflow=workflowScope?workflowEvidenceKind(path,entry.isDirectory(),workflowScope):undefined;
   if(workflow==='generated')continue;
   if(outsideScope&&!options.projectRules)continue;
   if((managed.get(path)??[]).some(o=>o.kind==='file')) continue;
   if(path.startsWith('.rigup/baseline/')||path === '.rigup/manifest.json'||path === '.rigup/config.yaml'||path.startsWith('.rigup/tools/')||path==='.rigup/check-results') continue;
   if(entry.isSymbolicLink()){profile.unknowns.push(path+': symlink skipped');continue;}
   if(entry.isDirectory()){
    try{await walk(file);}catch(error){
     if(!excluded||!['EACCES','EPERM'].includes((error as NodeJS.ErrnoException).code??''))throw error;
     if(purpose==='research')profile.checkCoverageIncomplete=true;
    }
    continue;
   }
   if(!entry.isFile()) continue;
   const discoveryEntry=Object.values(agents).some(host=>path.startsWith(host.skillDirectory+'/')&&path.endsWith('/SKILL.md'))||/^\.(?:claude|opencode|omp)\/commands\/.+\.md$/.test(path);
   if(excluded&&entry.name==='package.json'&&purpose==='research')profile.checkCoverageIncomplete=true;
   if(excluded&&!discoveryEntry)continue;
   if(profile.files.length>=maxFiles){profile.truncated=true;profile.unknowns.push('file budget reached');return;}
   let raw:Buffer;
   try {const filePath=await safePath(root,path);if((await stat(filePath)).size+bytes>maxBytes){profile.truncated=true;profile.unknowns.push(path+': byte budget reached');continue;}raw=await readFile(filePath);if(bytes+raw.length>maxBytes){profile.truncated=true;profile.unknowns.push(path+': byte budget reached');continue;}}
   catch {profile.unknowns.push(path+': unreadable or denied by policy');continue;}
   bytes+=raw.length;
   const text=raw.toString('utf8'),ownership=managed.get(path)??[];
   let projected:string|null;
   try {projected=projectInput(text,ownership);}catch {profile.truncated=true;profile.unknowns.push(path+': ownership projection failed');continue;}
   if(projected === null || projected === '' && managed.has(path)) continue;
   let source:ReturnType<typeof projectSource>;
   try{source=projection(path,text);}catch{profile.unknowns.push(path+': unreadable or denied by policy');continue;}
   const visible=source.researchText;
   profile.files.push(path);
   if(workflow!=='entry'&&!excluded)profile.researchFiles?.push(path);
   const convention=!!source.page||source.warnings.length>0;
   if(purpose==='research'&&workflow!=='entry'&&!excluded&&convention){
    (profile.conventionPaths??=[]).push(path);
    if(source.page)(profile.conventions??=[]).push(source.page);
    profile.unknowns.push(...source.warnings);
   }
   if(purpose==='research'&&workflow!=='entry'&&!excluded&&!convention&&extraSources.includes(path)&&declaredSources.has(path)){
    const lines=visible.split('\n');
    const start=lines.findIndex(line=>line.trim())+1;
    if(start){
     profile.declaredSources??=Object.create(null) as Record<string,Evidence>;
     profile.declaredSources[path]=sliceEvidence(path,lines,start,Math.min(lines.length,start+47)).evidence;
    }
   }
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
   // Invalidate legacy Spec Kit requests that included an entry still needed for binding.
   const evidenceRole=workflowScope==='spec-kit'&&workflow==='entry'&&!excluded?'\0native-entry':'';
   const metadata=source.page&&{topicId:source.page.topicId,title:source.page.title,scope:source.page.scope,status:source.page.status};
   inputs.push(path+'\0'+digest(convention?(source.page?.status==='confirmed'?visible:''):ownership.length?filterContent(path,projected):visible)+
    evidenceRole+(metadata?'\0'+JSON.stringify(metadata):''));
   if(outsideBusinessScope)continue;
   if(/\.[cm]?[jt]s$/.test(entry.name)&&hasTestDatabaseGuard(visible))testGuards.add(path);
   if(/jest.*\.json$/i.test(entry.name)){
    try{
     const setup=jestSetupPath(path,JSON.parse(visible).globalSetup);
     if(setup)jestSetups.set(path,setup);
    }catch{/* Other JSON configuration has no recognized Jest setup. */}
   }
   if(purpose==='research'&&path===gitlabPath)profile.gitlabJobs=discoverGitlabJobs(path,visible);
   if(entry.name === 'package.json') {
    try {
     const manifest=JSON.parse(visible),{scripts}=manifest;
     (profile.checkManifests??=[]).push(path);
     const cwd=posix.dirname(path);
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
 await walk(root);
 profile.specializedChecks=linkDatabaseGuards(profile.specializedChecks,jestSetups,testGuards);
 if(purpose==='research'){
  if(profile.truncated||!!options.scope?.length&&!options.scope.includes('.')||
    profile.unknowns.some(note=>/(?:^|\/)package\.json:/.test(note)))profile.checkCoverageIncomplete=true;
  if(profile.checkCoverageIncomplete||profile.unknowns.some(note=>note.startsWith(gitlabPath+':')))profile.gitlabReviewRequired=true;
  const available=new Set(projectChecks(profile).map(check=>JSON.stringify(npmScript(check.command))));
  for(const job of profile.gitlabJobs??[]){
   if(!job.command||available.has(JSON.stringify(npmScript(job.command))))continue;
   job.coverageStatus='unavailable';
   job.reason='Command could not be verified against scanned project checks';
  }
 }
 const external=await discoverNativeSources(root,options,discovery);for(const [key,sources]of Object.entries(external)){const agent=key as Agent;profile.skillSources??={};profile.skillSources[agent]=[...(profile.skillSources[agent]??[]),...sources];profile.nativeEntries??={};profile.nativeEntries[agent]=[...(profile.nativeEntries[agent]??[]),...sources.map(s=>s.name)];}inputs.push('native-sources\0'+digest(JSON.stringify(external)));profile.fingerprint=digest(inputs.join('\n')+'\n'+READ_POLICY_VERSION+'\n'+JSON.stringify({unknowns:profile.unknowns,truncated:profile.truncated}));return {profile,projection,declaredSources,scopes};
}

function projectSource(path:string,raw:string,ownership:Ownership[],selected:string[],registered?:ConventionReceipt,declared?:string[]):ReturnType<typeof readConventionDocument> {
 const projected=projectInput(raw,ownership,true);
 const visible=projected===null?'':filterContent(path,projected);
 const result=readConventionDocument(path,visible,!!registered);
 const page=result.page;
 if(!page)return result;
 if(registered&&(registered.scope!==page.scope||registered.topicId!==page.topicId)||declared&&!declared.includes(page.scope)||
    !scopesOverlap(selected,[page.scope])){
  return {researchText:visible.split('\n').map(()=>'').join('\n'),warnings:[path+': convention scope or identity unavailable; verify the declared mapping']};
 }
 return result;
}

export interface ReaderDependencies {budget?:{calls:number;bytes:number};persist?:()=>Promise<void>;expectedFingerprint?:string}
export async function repositoryReader(root:string,options:SetupOptions,dependencies:ReaderDependencies={}){
 const {profile,projection,declaredSources,scopes}=await inventory(root,options);
 root=profile.root;
 if(dependencies.expectedFingerprint&&profile.fingerprint!==dependencies.expectedFingerprint)throw new Error('reader source fingerprint changed during preparation');
 if(profile.researchBlocked)throw new Error(profile.researchBlocked);
 const allowed=new Set(profile.researchFiles??profile.files);
 const pages=new Map(profile.conventions?.map(page=>[page.path,page]));
 const conventionPaths=new Set(profile.conventionPaths);
 const sourceScopes=new Map<string,readonly string[]>();
 for(const [path,declared] of declaredSources)if(allowed.has(path))sourceScopes.set(path,declared.filter(scope=>scopesOverlap(scopes,[scope])));
 for(const path of conventionPaths){
  const page=pages.get(path);
  sourceScopes.set(path,page?.status==='confirmed'?[page.scope]:[]);
 }
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
  const source=projection(path,raw);
  const expected=pages.get(path),page=source.page;
  if(conventionPaths.has(path)||page||source.warnings.length){
   if(expected?.status!==page?.status||expected?.scope!==page?.scope||expected?.topicId!==page?.topicId||
    conventionPaths.has(path)&&!page&&!source.warnings.length)throw Error('convention source changed during research');
  }
  return source.researchText.split('\n');
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
  list:async()=>[...allowed],read,sourceScopes,
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

async function loadManaged(root:string,profile:Pick<ProjectProfile,'unknowns'|'truncated'|'researchBlocked'>):Promise<{managed:Map<string,Ownership[]>;receipts:ConventionReceipt[]}>{
 const managed=new Map<string,Ownership[]>();const committedNative=new Set<string>();let sawManifest=false;let untrusted=false;
 let receipts:ConventionReceipt[]=[];
 try{
  const manifest=JSON.parse(await readFile(await safePath(root,'.rigup/manifest.json'),'utf8'));sawManifest=true;
  if(manifest.schemaVersion!==1||!Array.isArray(manifest.assets))throw new Error('manifest structure');
  receipts=validateConventionReceipts(manifest.seededProjectDocuments);
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
 return {managed,receipts};
}
