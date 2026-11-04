import {parse} from 'yaml';
import {agents} from '../integrations/agents/index.js';
import type {Agent} from '../types.js';
import {readdir,readFile,realpath,stat} from 'node:fs/promises';
import {join,relative,dirname} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import type {SetupOptions,CommandSpec} from '../types.js';
import {projectInput,type Ownership} from '../managed-input.js';
import {readEvidence} from './evidence.js';
import {digest,safePath} from './evidence.js';
import {filterContent,secretName,READ_POLICY_VERSION} from './read-policy.js';
const exec=promisify(execFile);
export interface ProjectProfile {research?:import('./backend.js').ResearchResult;installedTools?:Record<string,{version:string;packageLockDigest:string}>;nativeEntries?:Partial<Record<import('../types.js').Agent,string[]>>;skillSources?:Partial<Record<import('../types.js').Agent,import('../integrations/registry.js').SkillSource[]>>;root:string;fingerprint:string;files:string[];git:{available:boolean;head?:string};commands:Record<string,CommandSpec[]>;unknowns:string[];truncated:boolean;readPolicyVersion:string}
export async function scanRepository(root:string,options:SetupOptions):Promise<ProjectProfile>{
 root=await realpath(root);
 if(options.scope?.some(s=>s.startsWith('/')||s.split('/').includes('..')||s.includes('\\'))) throw new Error('scope: invalid relative path');
 const profile:ProjectProfile={root,fingerprint:'',files:[],git:{available:false},commands:{build:[],lint:[],test:[],environment:[],eval:[]},unknowns:[],truncated:false,readPolicyVersion:READ_POLICY_VERSION};
 try {
  await exec('git',['-C',root,'rev-parse','--show-toplevel'],{env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}});
  profile.git.available=true;
  try {profile.git.head=(await exec('git',['-C',root,'rev-parse','--verify','HEAD'],{env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}})).stdout.trim();}catch{profile.unknowns.push('Git HEAD: unborn');}
 }catch{/* Non-Git repositories are valid. */}
 const managed=await loadManaged(root,profile);
 const inputs:string[]=[];let bytes=0;
 const maxFiles=options.readBudget?.maxFiles ?? 2000;const maxBytes=options.readBudget?.maxBytes ?? 8_000_000;
 async function walk(dir:string):Promise<void>{
  for(const entry of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
   if(['.git','node_modules','dist','.superpowers'].includes(entry.name)||secretName.test(entry.name)) continue;
   const file=join(dir,entry.name);const path=relative(root,file).split('\\').join('/');
   if(options.scope?.length && !options.scope.some(s=>path === s || path.startsWith(s+'/') || s.startsWith(path+'/'))) continue;
   if((managed.get(path)??[]).some(o=>o.kind==='file')) continue;
   if(path.startsWith('.rigup/baseline/')||path === '.rigup/manifest.json'||path === '.rigup/config.yaml'||path.startsWith('.rigup/tools/')) continue;
   if(entry.isSymbolicLink()){profile.unknowns.push(path+': symlink skipped');continue;}
   if(entry.isDirectory()){await walk(file);continue;}
   if(!entry.isFile()) continue;
   if(profile.files.length>=maxFiles){profile.truncated=true;profile.unknowns.push('file budget reached');return;}
   let raw:Buffer;let visible:string;
   try {const filePath=await safePath(root,path);if((await stat(filePath)).size+bytes>maxBytes){profile.truncated=true;profile.unknowns.push(path+': byte budget reached');continue;}raw=await readFile(filePath);if(bytes+raw.length>maxBytes){profile.truncated=true;profile.unknowns.push(path+': byte budget reached');continue;}}
   catch {profile.unknowns.push(path+': unreadable or denied by policy');continue;}
   bytes+=raw.length;
   let projected:string|null=raw.toString('utf8');
   try {projected=projectInput(projected,managed.get(path)||[]);}catch {profile.truncated=true;profile.unknowns.push(path+': ownership projection failed');continue;}
   if(projected === null || projected === '' && managed.has(path)) continue;
   try{visible=filterContent(path,projectInput(raw.toString('utf8'),managed.get(path)||[],true)??'');}catch{profile.unknowns.push(path+': unreadable or denied by policy');continue;}
   profile.files.push(path);
   for(const agent of Object.keys(agents) as Agent[]) {
    const host=agents[agent];
    if(path.startsWith(host.skillDirectory+'/') && path.endsWith('/SKILL.md')) {
     try {
      const front=visible.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
      const metadata=front ? parse(front[1]) : undefined;
      if(metadata && typeof metadata.name === 'string' && typeof metadata.description === 'string') {
       profile.nativeEntries ??= {};profile.nativeEntries[agent] ??= [];profile.nativeEntries[agent]!.push(metadata.name);
       profile.skillSources ??= {};profile.skillSources[agent] ??= [];profile.skillSources[agent]!.push({name:metadata.name,origin:'local',identity:path,digest:digest(raw),satisfies:!metadata.dependencies});
      }
     }catch {profile.unknowns.push(path+': native skill metadata invalid');}
    }
    const commandDir=agent === 'codex' ? undefined : agent === 'claude' ? '.claude/commands/' : agent === 'omp' ? '.omp/commands/' : '.opencode/commands/';
    if(commandDir && path.startsWith(commandDir) && path.endsWith('.md')) {
     profile.nativeEntries ??= {};profile.nativeEntries[agent] ??= [];profile.nativeEntries[agent]!.push(path.slice(commandDir.length,-3));
    }
   }
   inputs.push(path+'\0'+digest(filterContent(path,projected)));
   if(entry.name === 'package.json') {
    try {const pkg=JSON.parse(visible);for(const kind of Object.keys(profile.commands)) if(typeof pkg.scripts?.[kind] === 'string') profile.commands[kind].push({executable:'npm',args:['run',kind],cwd:dirname(path),envRefs:[]});}catch{profile.unknowns.push(path+': unsupported package manifest');}
   }
  }
 }
 await walk(root);profile.fingerprint=digest(inputs.join('\n')+'\n'+READ_POLICY_VERSION+'\n'+JSON.stringify({unknowns:profile.unknowns,truncated:profile.truncated}));return profile;
}

export interface ReaderDependencies {budget?:{calls:number;bytes:number};persist?:()=>Promise<void>;expectedFingerprint?:string}
export async function repositoryReader(root:string,options:SetupOptions,dependencies:ReaderDependencies={}){
 const profile=await scanRepository(root,options);
 if(dependencies.expectedFingerprint&&profile.fingerprint!==dependencies.expectedFingerprint)throw new Error('reader source fingerprint changed during preparation');
 const allowed=new Set(profile.files);
 const managed=await loadManaged(root,profile);
 const visibleText=async(path:string)=>{
  const raw=await readFile(await safePath(root,path),'utf8');
  const projected=projectInput(raw,managed.get(path)||[],true);
  return projected===null?'':filterContent(path,projected);
 };
 const spent=dependencies.budget??{bytes:0,calls:0};if(!Number.isSafeInteger(spent.bytes)||spent.bytes<0||!Number.isSafeInteger(spent.calls)||spent.calls<0)throw new Error('reader budget state invalid');
 const maxBytes=options.readBudget?.maxBytes ?? 8_000_000;const maxCalls=options.readBudget?.maxFiles ?? 2000;
 const charge=async(size:number)=>{if(spent.calls>=maxCalls||spent.bytes+size>maxBytes)throw new Error('reader budget exceeded');spent.calls++;spent.bytes+=size;await dependencies.persist?.();};
 const read=async(path:string,start:number,end?:number)=>{
  if(!allowed.has(path)) throw new Error('path outside reader inventory');
  const file=await safePath(root,path);const size=(await stat(file)).size;
  await charge(size);
  const lines=(await visibleText(path)).split('\n');
  end ??= lines.length;
  if(!Number.isInteger(start)||!Number.isInteger(end)||start<1||end<start||end>lines.length) throw new Error('invalid evidence range');
  const content=lines.slice(start-1,end).join('\n');
  return {content,evidence:{path,startLine:start,endLine:end,digest:digest(content)}};
 };
 return {
  list:async()=>[...allowed],read,
  search:async(query:string)=>{
   const matches:Awaited<ReturnType<typeof readEvidence>>[]=[];
   for(const path of allowed) {
    const file=await safePath(root,path);const size=(await stat(file)).size;
    await charge(size);const text=await visibleText(path);
    const lines=text.split('\n');
    for(let i=0;i<lines.length;i++) if(lines[i].includes(query)) matches.push({content:lines[i],evidence:{path,startLine:i+1,endLine:i+1,digest:digest(lines[i])}});
   }
   return matches;
  }
 };
}

async function loadManaged(root:string,profile:Pick<ProjectProfile,'unknowns'|'truncated'>):Promise<Map<string,Ownership[]>>{
 const managed=new Map<string,Ownership[]>();
 let sawManifest=false;
 try {
  const manifest=JSON.parse(await readFile(await safePath(root,'.rigup/manifest.json'),'utf8'));
  sawManifest=true;
  if(manifest.schemaVersion !== 1 || !Array.isArray(manifest.assets)) throw new Error('manifest structure');
  for(const asset of manifest.assets) {
   if(typeof asset.target !== 'string' || typeof asset.baseline !== 'string' || !['file','block','json-key','toml-table'].includes(asset.ownership?.kind)) throw new Error('asset metadata');
   const baseline=await readFile(await safePath(root,asset.baseline));
   if(digest(baseline) !== asset.digest) throw new Error('baseline digest');
   managed.set(asset.target,[...(managed.get(asset.target)||[]),asset.ownership]);
  }
 } catch(error) {
  if(sawManifest || (error as NodeJS.ErrnoException).code !== 'ENOENT') {profile.unknowns.push('ownership metadata untrusted; semantic cache disabled');profile.truncated=true;}
  managed.clear();
 }
 return managed;
}
