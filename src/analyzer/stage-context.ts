import {posix} from 'node:path';
import type {Evidence} from '../types.js';
import type {ResearchRequest,RepositoryReader} from './backend.js';
import {sliceEvidence,validEvidenceRange,type EvidenceRead} from './evidence.js';
import {markdownLinks} from '../generator/document-policy.js';

export const STAGE_EVIDENCE_POLICY='stage-evidence-v6';
const locks=new Set(['package-lock.json','npm-shrinkwrap.json','yarn.lock','pnpm-lock.yaml','bun.lock','bun.lockb','Cargo.lock','composer.lock','Gemfile.lock','go.sum','Pipfile.lock','poetry.lock','uv.lock']);
export const dependencyLock=(path:string)=>locks.has(posix.basename(path));
export interface EvidenceSlice {path:string;startLine:number;endLine?:number;digest?:string;seedPool?:SeedPool}
export interface StageContext {stage:string;input:unknown;sourceGuidance?:ResearchRequest['sourceGuidance'];slices:EvidenceSlice[];unavailable:string[]}
const record=(value:unknown):Record<string,any>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,any>:{};
const array=(value:unknown):any[]=>Array.isArray(value)?value:[];
const strings=(value:unknown):string[]=>array(value).filter((v:unknown)=>typeof v==='string');
const overlaps=(a:string,b:string)=>a==='.'||b==='.'||a===b||a.startsWith(b+'/')||b.startsWith(a+'/');
const within=(path:string,root:string)=>root==='.'||path===root||path.startsWith(root+'/');
const instruction=(path:string)=>/^(?:AGENTS|CLAUDE|GEMINI)\.md$/.test(posix.basename(path));
const manifest=(path:string)=>/^(?:package\.json|pyproject\.toml|Cargo\.toml|go\.mod|pom\.xml|build\.gradle(?:\.kts)?|Gemfile)$/.test(posix.basename(path));
// Separate allowances keep long documents and large source directories from consuming the survey.
const seedPools={
 instructions:{files:12,bytes:16_000,perFile:12_000,windows:4},
 native:{files:16,bytes:26_000,perFile:5_000,windows:3},
 configuration:{files:24,bytes:22_000,perFile:5_500,windows:3},
 guidance:{files:18,bytes:32_000,perFile:18_000,windows:8},
 implementation:{files:76,bytes:72_000,perFile:3_600,windows:3},
 tests:{files:24,bytes:20_000,perFile:3_600,windows:3},
};
type SeedPool=keyof typeof seedPools;
const seedChunkLines=64;
const automation=(path:string)=>/(^|\/)(?:\.github\/workflows|\.circleci|\.buildkite|\.husky)\/|(^|\/)(?:\.gitlab-ci\.ya?ml|azure-pipelines\.ya?ml|Jenkinsfile)$/.test(path);
const projectConfig=(name:string)=>/^(?:Makefile|CMakeLists\.txt|Dockerfile|docker-compose\.ya?ml|compose\.ya?ml|Pipfile|requirements(?:-[\w-]+)?\.txt|setup\.(?:cfg|py)|composer\.json|deno\.jsonc?|pubspec\.yaml|Package\.swift|mix\.exs|build\.sbt|.*\.csproj|\.dependency-cruiser\..+|\.eslintrc(?:\..+)?|\.prettierrc(?:\..+)?|\.jestrc(?:\..+)?|(?:tsconfig|jest|nest-cli)(?:[-.].+)?\.json|.*\.config\.[\w]+)$/.test(name);
const source=(name:string)=>/\.(?:[cm]?[jt]sx?|py|rb|php|swift|kt[s]?|java|scala|go|rs|[ch](?:pp|xx)?|cs|fs[x]?|exs?|vue|svelte|sql|sh|bash|lua|dart|r|R|ipynb|feature)$/.test(name)&&!/\.min\.[^.]+$/.test(name);

function seedPool(path:string,native:ReadonlySet<string>):SeedPool|undefined {
 const name=posix.basename(path);
 if(instruction(path))return 'instructions';
 if(native.has(path))return 'native';
 if(manifest(path)||automation(path)||projectConfig(name))return 'configuration';
 if(/^(?:README|CONTRIBUTING|ARCHITECTURE|DEVELOPMENT|SECURITY)(?:\..+)?$/i.test(name)||/(^|\/)(?:docs|documentation)\/.+\.(?:mdx?|rst|adoc|txt)$/i.test(path))return 'guidance';
 if(!source(name))return undefined;
 return /(^|\/)(?:__tests__|__mocks__|tests?|testing|e2e|specs?)\/|(?:[.-](?:test|spec|stories)|_test)\.[^.]+$|\.feature$/.test(path)?'tests':'implementation';
}

/** Interleave sibling directories at every level to sample separate areas early. */
function spreadPaths(paths:string[],offset=0):string[] {
 const files:string[]=[],children=new Map<string,string[]>();
 for(const path of paths){
  const split=path.indexOf('/',offset);
  if(split===-1){files.push(path);continue;}
  const child=path.slice(offset,split);
  const group=children.get(child)??[];group.push(path);children.set(child,group);
 }
 const groups=[files,...[...children.entries()].map(([child,group])=>spreadPaths(group,offset+child.length+1))];
 const result:string[]=[];
 for(let i=0;i<Math.max(...groups.map(group=>group.length));i++)for(const group of groups)if(i<group.length)result.push(group[i]);
 return result;
}

function analysisSeed(paths:string[],nativeEntries:ReadonlySet<string>):EvidenceSlice[] {
 const native=new Set(nativeEntries);
 for(const path of nativeEntries)if(/\/openspec-[^/]+\/SKILL\.md$/.test(path))native.add(posix.join(posix.dirname(posix.dirname(path)),'openspec-explore/SKILL.md'));
 const groups:Record<SeedPool,string[]>={instructions:[],native:[],configuration:[],guidance:[],implementation:[],tests:[]};
 for(const path of paths){
  if(dependencyLock(path))continue;
  const pool=seedPool(path,native);
  if(pool)groups[pool].push(path);
 }
 const support=(path:string)=>/\/(?:index\.[^/]+|[^/]+\.d\.ts)$/.test(path);
 return (Object.keys(groups) as SeedPool[]).flatMap(pool=>{
  const rank=(path:string)=>pool==='configuration'?Number(manifest(path)||automation(path)):Number(!support(path));
  const ordered=groups[pool].sort((a,b)=>rank(b)-rank(a)||a.localeCompare(b));
  const selected=pool==='configuration'?ordered:spreadPaths(ordered);
  return selected.slice(0,seedPools[pool].files).map(path=>({path,startLine:1,seedPool:pool}));
 });
}
function references(value:unknown):Evidence[]{
 const found:Evidence[]=[];
 const walk=(value:unknown)=>{
  if(!value||typeof value!=='object')return;
  if(Array.isArray(value)){for(const entry of value)walk(entry);return;}
  const item=record(value);
  if(typeof item.path==='string'&&('digest'in item||'startLine'in item||'endLine'in item)){
   if(!validEvidenceRange(item.startLine,item.endLine)||!/^[a-f0-9]{64}$/.test(item.digest))throw Error('Stage evidence has an invalid range or digest');
   found.push(item as Evidence);return;
  }
  for(const child of Object.values(item))walk(child);
 };
 walk(value);return found;
}

/** Select evidence by verified references and task paths, never by a prose score. */
export function stageContext(request:ResearchRequest,paths:string[],nativeEntryPaths:readonly string[]=[]):StageContext {
 if(request.kind==='analyze'?request.expectedOutput!==undefined:request.kind==='artifact-plan'?request.expectedOutput!=='plan':!['content','acceptance'].includes(request.expectedOutput??''))throw Error('Stage output does not match request kind');
 const stage=request.expectedOutput??'analyze',input=record(request.input),allowed=new Set(paths),unavailable=new Set<string>(),slices=new Map<string,EvidenceSlice>();
 const nativeEntries=new Set(nativeEntryPaths);
 const add=(slice:EvidenceSlice)=>{
  if(!allowed.has(slice.path))throw Error('Stage evidence path outside reader inventory: '+slice.path);
  if(dependencyLock(slice.path)){unavailable.add(slice.path+': dependency lock body omitted; locked/transitive versions are not supplied');return;}
  const key=JSON.stringify([slice.path,slice.startLine,slice.endLine]);const prior=slices.get(key);
  if(prior?.digest&&slice.digest&&prior.digest!==slice.digest)throw Error('Stage evidence has conflicting digests');
  slices.set(key,slice);
 };
 const refs=(value:unknown)=>{for(const e of references(value))add({path:e.path,startLine:e.startLine,endLine:e.endLine,digest:e.digest});};
 refs(request.sourceGuidance);
 const seed=(path:string)=>{
  const matches=paths.filter(p=>within(p,path));
  if(!matches.length)unavailable.add(path+': requested source unavailable in reader inventory');
  for(const path of matches)add({path,startLine:1});
 };
 let projected:unknown=request.input;
 if(stage==='analyze'){
  for(const slice of analysisSeed(paths,nativeEntries))add(slice);
 }else if(stage==='plan'){
  const profile=record(input.profile),research=record(profile.research);
  const data=record(research.data),analysis={ruleTopics:data.ruleTopics,guidance:data.guidance,observations:data.observations,unknowns:data.unknowns};
  const batches=array(record(input.topicEvidence).batches);
  projected={allowedRoots:input.allowedRoots,profile:{commands:profile.commands,research:{data:analysis,unknowns:research.unknowns},unknowns:profile.unknowns},previousInventory:input.previousInventory,previousRuleTopics:input.previousRuleTopics,inventoryPolicy:input.inventoryPolicy,topicEvidence:input.topicEvidence};
  if(batches.at(-1)?.from!=='plan')refs(analysis);
  for(const batch of batches)refs(batch.results);
  for(const path of paths)if(instruction(path)||nativeEntries.has(path)||manifest(path))add({path,startLine:1});
  if(!research.data)unavailable.add('Prior analysis unavailable; do not infer unprovided project conventions');
 }else {
  let job=record(input.job);
  const research=record(input.research);
  if(typeof job.logicalId!=='string'||typeof job.target!=='string')throw Error('Stage context requires the current artifact job');
  const repairs=new Set(stage==='content'?strings(record(input.rulebookRepair).ruleIds):[]);
  if(repairs.size){
   const ruleSources=array(job.ruleSources).filter(rule=>repairs.has(rule.id));
   if(ruleSources.length!==repairs.size)throw Error('Rule repair requires known source IDs');
   const ruleTopics=array(job.ruleTopics).filter(topic=>strings(topic.ruleIds).some(id=>repairs.has(id)));
   job={...job,ruleSources,ruleTopics,sourceRefs:references([ruleSources,ruleTopics])};
  }
  const ruleTopics=new Set(array(job.ruleTopics).filter(topic=>array(topic.ruleIds).length).map(topic=>topic.id));
  const topicEvidence=array(input.topicEvidence).map(batch=>({from:batch.from,results:array(batch.results).filter(result=>ruleTopics.has(result.topicId))})).filter(batch=>batch.results.length);
  refs(topicEvidence);
  const jobs=new Map(array(research.artifacts).map(j=>[j.logicalId,j]));jobs.set(job.logicalId,job);
  const connected=new Map<string,any>();
  const visit=(id:string)=>{if(connected.has(id))return;const current=jobs.get(id);if(!current){unavailable.add(id+': related artifact metadata unavailable');return;}connected.set(id,current);for(const related of strings(current.relatedArtifacts))visit(related);};
  visit(job.logicalId);
  const anchors=new Set<string>();
  const ruleRefs=new Set(job.ruleSources?references([job.sourceRefs,research.guidance]).map(ref=>ref.path):[]);
  for(const current of connected.values()){
   for(const ref of references(current.sourceRefs))anchors.add(ref.path);
   for(const path of strings(current.seedPaths))anchors.add(path);
   refs(current.sourceRefs);for(const path of strings(current.seedPaths))seed(path);
  }
  const candidatePages=stage==='acceptance'?array(input.candidatePages):[];
  if(stage==='acceptance'&&typeof input.candidate==='string'){
   const topicTargets=new Set(array(job.ruleTopics).map(topic=>topic.target).filter(target=>typeof target==='string'));
   if(candidatePages.length!==topicTargets.size||new Set(candidatePages.map(page=>page.target)).size!==candidatePages.length||
    candidatePages.some(page=>!topicTargets.has(page.target)||typeof page.content!=='string'))throw Error('Acceptance requires every planned topic page');
   for(const page of [{target:job.target,content:input.candidate},...candidatePages])for(const link of markdownLinks(page.content)){
    let raw=link[1].split('#')[0];if(!raw||/^(?:https?:|mailto:)/.test(raw))continue;
    try{raw=decodeURIComponent(raw);}catch{unavailable.add(raw+': invalid candidate link');continue;}
    const target=posix.normalize(posix.join(posix.dirname(page.target),raw));
    if(!raw.startsWith('/')&&(topicTargets.has(target)||target===job.target&&topicTargets.size))continue;
    if(raw.startsWith('/')||!allowed.has(target)){unavailable.add(raw+': candidate link outside supplied source inventory');continue;}
    if(ruleRefs.has(target)){anchors.add(target);continue;}
    anchors.add(target);add({path:target,startLine:1});
   }
  }
  const taskLocations=[...anchors,...[...connected.values()].map(j=>j.target).filter((target:unknown)=>typeof target==='string')];
  const applies=(path:string)=>taskLocations.some(anchor=>within(anchor,posix.dirname(path)));
  const guard=(path:string)=>nativeEntries.has(path)||instruction(path)&&applies(path);
  const relevant=(value:unknown)=>references(value).some(e=>[...anchors].some(anchor=>overlaps(e.path,anchor)));
  const scopes=(value:unknown)=>strings(value).filter(s=>s.trim()).map(s=>posix.normalize(s).replace(/\/+$/,'')||'/');
  const scopeApplies=(value:unknown)=>scopes(value).some(scope=>taskLocations.some(anchor=>overlaps(scope,anchor)));
  const authorityApplies=(value:unknown,topic:unknown)=>{
   const declared=scopes(value),unknown=!declared.length||declared.some(scope=>scope!=='.'&&![...paths,...taskLocations].some(path=>within(path,scope)));
   if(unknown)unavailable.add('Authority scope unresolved for '+String(topic??'unnamed source')+'; retained for review without assuming global applicability');
   return unknown||scopeApplies(value);
  };
  const hasTopic=(value:any)=>typeof value.topic==='string'&&!!value.topic.trim();
  const repairTopic=(value:any)=>repairs.size>0&&ruleTopics.has(value.topicId);
  const neededObservation=(o:any)=>relevant(o)||references(o).some(e=>guard(e.path))||
   repairTopic(o)&&o.guidanceDisposition==='needs-decision'||(o.classification==='explicit-rule'||!hasTopic(o))&&authorityApplies(o.scope,o.topic);
  const neededGuidance=(g:any)=>relevant(g.sourceRef)||repairTopic(g)&&['needs-decision','conflicting','unavailable'].includes(g.coverageStatus)||authorityApplies(g.scope,g.topic);
  const topics=new Set<string>();
  for(const o of array(research.observations))if(hasTopic(o)&&neededObservation(o))topics.add(o.topic);
  for(const g of array(research.guidance))if(hasTopic(g)&&neededGuidance(g))topics.add(g.topic);
  const observations=array(research.observations).filter(o=>neededObservation(o)||hasTopic(o)&&topics.has(o.topic));
  const guidance=array(research.guidance).filter(g=>neededGuidance(g)||hasTopic(g)&&topics.has(g.topic)||references(g.sourceRef).some(e=>guard(e.path)));
  if(array(research.observations).some(o=>!hasTopic(o)))unavailable.add('Research observations without topic labels use task references, scope and guardrails; cross-topic completeness is unknown');
  const scopedResearch={guidance,observations,unknowns:research.unknowns,artifacts:[...connected.values()].filter(artifact=>!job.ruleSources||artifact!==job),dispositions:array(research.dispositions).filter(d=>connected.has(d.logicalId))};
  refs(scopedResearch);
  for(const path of paths)if(guard(path)||manifest(path)&&applies(path))add({path,startLine:1});
  projected={job,research:scopedResearch,...(topicEvidence.length?{topicEvidence}:{}),...(stage==='acceptance'?{candidate:input.candidate,candidatePages:input.candidatePages}:{attempt:input.attempt,repairReason:input.repairReason,rulebookRepair:input.rulebookRepair})};
 }
 const selected=[...slices.values()];
 if(stage!=='analyze')selected.sort((a,b)=>a.path.localeCompare(b.path)||a.startLine-b.startLine||(a.endLine??Infinity)-(b.endLine??Infinity));
 return {stage,input:projected,...(request.sourceGuidance?{sourceGuidance:request.sourceGuidance}:{}),slices:selected,unavailable:[...unavailable].sort()};
}

export function stageSourceGuidance(reader:RepositoryReader,guidance:ResearchRequest['sourceGuidance']){
 return stageEvidence(reader,guidance?.flatMap(binding=>binding.sourceRef?[binding.sourceRef]:[])??[]);
}

/** Fit exact ranges within a file allowance, sampling later sections of long files. */
function seedSnippets(path:string,lines:string[],allowance:number,maxWindows:number):EvidenceRead[] {
 const chunkCount=Math.ceil(lines.length/seedChunkLines);
 const sampled=chunkCount>maxWindows||Buffer.byteLength(lines.join('\n'))>allowance;
 const windows=Math.min(chunkCount,maxWindows),result:EvidenceRead[]=[];
 let remaining=allowance;
 for(let i=0;i<windows;i++){
  const block=sampled&&windows>1?Math.round(i*(chunkCount-1)/(windows-1)):i;
  const start=block*seedChunkLines,limit=Math.min(start+seedChunkLines,lines.length);
  const budget=sampled?Math.floor(remaining/(windows-i)):remaining;
  let bytes=0,end=start;
  for(;end<limit;end++){
   const size=Buffer.byteLength(lines[end])+Number(end>start);
   if(bytes+size>budget)break;
   bytes+=size;
  }
  if(end>start)result.push(sliceEvidence(path,lines,start+1,end));
  remaining-=bytes;
 }
 return result;
}

/** Read each selected file once, export only requested ranges with exact digests. */
export async function stageEvidence(reader:RepositoryReader,slices:EvidenceSlice[]){
 const files=new Map<string,string[]>(),snippets=new Map<string,EvidenceRead>();
 const seedSpent=new Map<SeedPool,number>();
 const nativeCount=slices.filter(slice=>slice.seedPool==='native').length;
 for(const slice of slices){
  const pool=slice.seedPool;
  const limits=pool?seedPools[pool]:undefined,spent=pool?seedSpent.get(pool)??0:0;
  if(limits&&spent>=limits.bytes)continue;
  let lines=files.get(slice.path);
  if(!lines){
   const full=await reader.read(slice.path,1);
   lines=full.content.split('\n');
   if(lines.length!==full.evidence.endLine)throw Error('Stage evidence range outside source');
   files.set(slice.path,lines);
  }
  if(pool&&limits){
   const allowance=Math.min(limits.bytes-spent,limits.perFile,pool==='native'?Math.floor(limits.bytes/nativeCount):Infinity);
   const selected=seedSnippets(slice.path,lines,allowance,limits.windows);
   seedSpent.set(pool,spent+selected.reduce((size,item)=>size+Buffer.byteLength(item.content),0));
   for(const snippet of selected)snippets.set(JSON.stringify(snippet.evidence),snippet);
   continue;
  }
  const end=slice.endLine??lines.length;
  if(!validEvidenceRange(slice.startLine,end,lines.length))throw Error('Stage evidence range outside source');
  const snippet=sliceEvidence(slice.path,lines,slice.startLine,end);
  if(slice.digest&&slice.digest!==snippet.evidence.digest)throw Error('Stage evidence digest does not match visible source');
  snippets.set(JSON.stringify(snippet.evidence),snippet);
 }
 return [...snippets.values()];
}
