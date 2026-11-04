import {posix} from 'node:path';
import type {Evidence} from '../types.js';
import type {ResearchRequest,RepositoryReader} from './backend.js';
import {digest} from './evidence.js';

export const STAGE_EVIDENCE_POLICY='stage-evidence-v2';
const locks=new Set(['package-lock.json','npm-shrinkwrap.json','yarn.lock','pnpm-lock.yaml','bun.lock','bun.lockb']);
export const dependencyLock=(path:string)=>locks.has(posix.basename(path));
export interface EvidenceSlice {path:string;startLine:number;endLine?:number;digest?:string}
export interface StageContext {stage:string;input:unknown;slices:EvidenceSlice[];unavailable:string[]}
const record=(value:unknown):Record<string,any>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,any>:{};
const array=(value:unknown):any[]=>Array.isArray(value)?value:[];
const strings=(value:unknown):string[]=>array(value).filter((v:unknown)=>typeof v==='string');
const overlaps=(a:string,b:string)=>a==='.'||b==='.'||a===b||a.startsWith(b+'/')||b.startsWith(a+'/');
const within=(path:string,root:string)=>root==='.'||path===root||path.startsWith(root+'/');
const native=(path:string)=>/^\.(?:agents|codex|claude|opencode|omp)\/(?:skills\/.+\/SKILL\.md|commands\/.+\.md)$/.test(path);
const instruction=(path:string)=>/^(?:AGENTS|CLAUDE|GEMINI)\.md$/.test(posix.basename(path));
const manifest=(path:string)=>/^(?:package\.json|pyproject\.toml|Cargo\.toml|go\.mod|pom\.xml|build\.gradle(?:\.kts)?|Gemfile)$/.test(posix.basename(path));
function references(value:unknown):Evidence[]{
 const found:Evidence[]=[];
 const walk=(value:unknown)=>{
  if(!value||typeof value!=='object')return;
  if(Array.isArray(value)){for(const entry of value)walk(entry);return;}
  const item=record(value);
  if(typeof item.path==='string'&&('digest'in item||'startLine'in item||'endLine'in item)){
   if(!Number.isInteger(item.startLine)||!Number.isInteger(item.endLine)||item.startLine<1||item.endLine<item.startLine||!/^[a-f0-9]{64}$/.test(item.digest))throw Error('Stage evidence has an invalid range or digest');
   found.push(item as Evidence);return;
  }
  for(const child of Object.values(item))walk(child);
 };
 walk(value);return found;
}

/** Select evidence by verified references and task paths, never by a prose score. */
export function stageContext(request:ResearchRequest,paths:string[]):StageContext {
 if(request.kind==='analyze'?request.expectedOutput!==undefined:request.kind==='artifact-plan'?request.expectedOutput!=='plan':!['content','acceptance'].includes(request.expectedOutput??''))throw Error('Stage output does not match request kind');
 const stage=request.expectedOutput??'analyze',input=record(request.input),allowed=new Set(paths),unavailable=new Set<string>(),slices=new Map<string,EvidenceSlice>();
 const add=(slice:EvidenceSlice)=>{
  if(!allowed.has(slice.path))throw Error('Stage evidence path outside reader inventory: '+slice.path);
  if(dependencyLock(slice.path)){unavailable.add(slice.path+': dependency lock body omitted; locked/transitive versions are not supplied');return;}
  const key=JSON.stringify([slice.path,slice.startLine,slice.endLine]);const prior=slices.get(key);
  if(prior?.digest&&slice.digest&&prior.digest!==slice.digest)throw Error('Stage evidence has conflicting digests');
  slices.set(key,slice);
 };
 const refs=(value:unknown)=>{for(const e of references(value))add({path:e.path,startLine:e.startLine,endLine:e.endLine,digest:e.digest});};
 const seed=(path:string)=>{
  const matches=paths.filter(p=>within(p,path));
  if(!matches.length)unavailable.add(path+': requested source unavailable in reader inventory');
  for(const path of matches)add({path,startLine:1});
 };
 let projected:unknown=request.input;
 if(stage==='analyze'){
  for(const path of paths)if(!dependencyLock(path))add({path,startLine:1});
 }else if(stage==='plan'){
  const profile=record(input.profile),research=record(profile.research);
  const data=record(research.data),analysis={guidance:data.guidance,observations:data.observations,unknowns:data.unknowns};
  projected={allowedRoots:input.allowedRoots,profile:{commands:profile.commands,research:{data:analysis,unknowns:research.unknowns},unknowns:profile.unknowns},previousInventory:input.previousInventory,inventoryPolicy:input.inventoryPolicy};
  refs(analysis);
  for(const path of paths)if(instruction(path)||native(path)||manifest(path))add({path,startLine:1});
  if(!research.data)unavailable.add('Prior analysis unavailable; do not infer unprovided project conventions');
 }else {
  const job=record(input.job),research=record(input.research);
  if(typeof job.logicalId!=='string'||typeof job.target!=='string')throw Error('Stage context requires the current artifact job');
  const jobs=new Map(array(research.artifacts).map(j=>[j.logicalId,j]));jobs.set(job.logicalId,job);
  const connected=new Map<string,any>();
  const visit=(id:string)=>{if(connected.has(id))return;const current=jobs.get(id);if(!current){unavailable.add(id+': related artifact metadata unavailable');return;}connected.set(id,current);for(const related of strings(current.relatedArtifacts))visit(related);};
  visit(job.logicalId);
  const anchors=new Set<string>();
  for(const current of connected.values()){
   for(const ref of references(current.sourceRefs))anchors.add(ref.path);
   for(const path of strings(current.seedPaths))anchors.add(path);
   refs(current.sourceRefs);for(const path of strings(current.seedPaths))seed(path);
  }
  if(stage==='acceptance'&&typeof input.candidate==='string')for(const link of input.candidate.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)){
   let raw=link[1].split('#')[0];if(!raw||/^(?:https?:|mailto:)/.test(raw))continue;
   try{raw=decodeURIComponent(raw);}catch{unavailable.add(raw+': invalid candidate link');continue;}
   const target=posix.normalize(posix.join(posix.dirname(job.target),raw));
   if(raw.startsWith('/')||!allowed.has(target)){unavailable.add(raw+': candidate link outside supplied source inventory');continue;}
   anchors.add(target);add({path:target,startLine:1});
  }
  const taskLocations=[...anchors,...[...connected.values()].map(j=>j.target).filter((target:unknown)=>typeof target==='string')];
  const applies=(path:string)=>taskLocations.some(anchor=>within(anchor,posix.dirname(path)));
  const guard=(path:string)=>native(path)||instruction(path)&&applies(path);
  const relevant=(value:unknown)=>references(value).some(e=>[...anchors].some(anchor=>overlaps(e.path,anchor)));
  const scopes=(value:unknown)=>strings(value).filter(s=>s.trim()).map(s=>posix.normalize(s).replace(/\/+$/,'')||'/');
  const scopeApplies=(value:unknown)=>scopes(value).some(scope=>taskLocations.some(anchor=>overlaps(scope,anchor)));
  const authorityApplies=(value:unknown,topic:unknown)=>{
   const declared=scopes(value),unknown=!declared.length||declared.some(scope=>scope!=='.'&&![...paths,...taskLocations].some(path=>within(path,scope)));
   if(unknown)unavailable.add('Authority scope unresolved for '+String(topic??'unnamed source')+'; retained for review without assuming global applicability');
   return unknown||scopeApplies(value);
  };
  const hasTopic=(value:any)=>typeof value.topic==='string'&&!!value.topic.trim();
  const neededObservation=(o:any)=>relevant(o)||references(o).some(e=>guard(e.path))||(o.classification==='explicit-rule'||!hasTopic(o))&&authorityApplies(o.scope,o.topic);
  const neededGuidance=(g:any)=>relevant(g.sourceRef)||authorityApplies(g.scope,g.topic);
  const topics=new Set<string>();
  for(const o of array(research.observations))if(hasTopic(o)&&neededObservation(o))topics.add(o.topic);
  for(const g of array(research.guidance))if(hasTopic(g)&&neededGuidance(g))topics.add(g.topic);
  const observations=array(research.observations).filter(o=>neededObservation(o)||hasTopic(o)&&topics.has(o.topic));
  const guidance=array(research.guidance).filter(g=>neededGuidance(g)||hasTopic(g)&&topics.has(g.topic)||references(g.sourceRef).some(e=>guard(e.path)));
  if(array(research.observations).some(o=>!hasTopic(o)))unavailable.add('Research observations without topic labels use task references, scope and guardrails; cross-topic completeness is unknown');
  const scopedResearch={guidance,observations,unknowns:research.unknowns,artifacts:[...connected.values()],dispositions:array(research.dispositions).filter(d=>connected.has(d.logicalId))};
  refs(scopedResearch);
  for(const path of paths)if(guard(path)||manifest(path)&&applies(path))add({path,startLine:1});
  projected={job,research:scopedResearch,...(stage==='acceptance'?{candidate:input.candidate}:{attempt:input.attempt,repairReason:input.repairReason})};
 }
 return {stage,input:projected,slices:[...slices.values()].sort((a,b)=>a.path.localeCompare(b.path)||a.startLine-b.startLine||(a.endLine??Infinity)-(b.endLine??Infinity)),unavailable:[...unavailable].sort()};
}

/** Read each selected file once, export only requested ranges with exact digests. */
export async function stageEvidence(reader:RepositoryReader,slices:EvidenceSlice[]){
 const files=new Map<string,Awaited<ReturnType<RepositoryReader['read']>>>(),snippets=new Map<string,Awaited<ReturnType<RepositoryReader['read']>>>();
 for(const slice of slices){
  let full=files.get(slice.path);if(!full){full=await reader.read(slice.path,1);files.set(slice.path,full);}
  const end=slice.endLine??full.evidence.endLine;
  if(slice.startLine<1||end<slice.startLine||end>full.evidence.endLine)throw Error('Stage evidence range outside source');
  const content=full.content.split('\n').slice(slice.startLine-1,end).join('\n');
  const evidence={path:slice.path,startLine:slice.startLine,endLine:end,digest:digest(content)};
  if(slice.digest&&slice.digest!==evidence.digest)throw Error('Stage evidence digest does not match visible source');
  snippets.set(JSON.stringify(evidence),{content,evidence});
 }
 return [...snippets.values()];
}
