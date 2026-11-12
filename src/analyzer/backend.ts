import {validateOptions} from '../config.js';
import {scopeContains,scopesOverlap,type Evidence,type StepResult} from '../types.js';
import type {EvidenceRead,ReadEvidence} from './evidence.js';
import {digest} from './evidence.js';
import {isConventionScope} from '../project-conventions.js';
import type {GuidanceBinding} from '../generator/project-rules.js';
export interface SearchSelection {paths:ReadonlySet<string>;limit:number}
export interface RepositoryReader {
 list():Promise<string[]>;
 read:ReadEvidence;
 /** A fresh reader that can share file loads within a single verification. */
 evidencePass?():ReadEvidence;
 readonly sourceScopes?:ReadonlyMap<string,readonly string[]>;
 search(query:string,selection?:SearchSelection):Promise<EvidenceRead[]>;
}
export interface ResearchRequest {kind:'analyze'|'artifact-plan'|'artifact-content';runId:string;root:string;fingerprint:string;options:unknown;sourceGuidance?:GuidanceBinding[];effectiveModel?:import('../types.js').SetupOptions['model'];versions:Record<string,string>;budget:{maxCalls:number;maxTokens:number};spent?:{calls:number;tokens:number|'unknown'};artifact?:string;expectedOutput?:'plan'|'content'|'acceptance';input?:unknown;previousInventoryDigest:string;templateSourcesDigest:string}
export interface ResearchResult {data:unknown;model:string;unknowns:string[];usage:{calls:number|'unknown';tokens:number|'unknown'}}
export interface AnalysisBackend {
 /** Revision of content/acceptance evidence; does not reset run accounting or the unchanged plan. */
 artifactContextVersion?:string;
 topicEvidence?:boolean;
 /** This backend checks the durable budget before dispatch, including zero-cost recovery. */
 durableBudget?:true;
 run(request:ResearchRequest,reader:RepositoryReader):Promise<StepResult<ResearchResult>>;
}
const searched=new WeakMap<RepositoryReader,Set<string>>();
const guidanceLists=['scope','consumers','gaps'] as const;
const stringArray=(value:unknown)=>Array.isArray(value)&&value.every(item=>typeof item==='string');

function normalizeGuidance(output:Record<string,unknown>):Record<string,unknown>{
 if(!Array.isArray(output.guidance))return output;
 const guidance=output.guidance.map(source=>{
  if(!source||typeof source!=='object'||Array.isArray(source))return source;
  const normalized={...source};
  for(const field of guidanceLists)if(typeof normalized[field]==='string')normalized[field]=[normalized[field]];
  return normalized;
 });
 return {...output,guidance};
}

export function selectResearchOutput(request:ResearchRequest,data:unknown):unknown {
 if(!data||typeof data!=='object'||Array.isArray(data))return data;
 const output=normalizeGuidance(data as Record<string,unknown>);
 if(request.expectedOutput==='plan'&&Array.isArray(output.observations)){
  const observations=output.observations.map(observation=>{
   const supports=observation?.coverage?.independentSupports;
   if(observation?.classification!=='convention'||!Array.isArray(supports)||!Array.isArray(observation.supportingEvidence))return observation;
   const citedPaths=new Set(observation.supportingEvidence.map((e:Evidence)=>e?.path));
   if(!supports.every(path=>typeof path==='string'&&citedPaths.has(path)))return observation;
   return {...observation,coverage:{...observation.coverage,independentSupports:new Set(supports).size}};
  });
  return {...output,observations};
 }
 const job=(request.input as {job?:{ruleSources?:unknown}}|undefined)?.job;
 if(!Array.isArray(job?.ruleSources))return output;
 const {rulebook,accepted,reason,unknowns,rejectedRuleIds}=output;
 if(request.expectedOutput==='content')return {rulebook,unknowns,observations:[]};
 if(request.expectedOutput==='acceptance')return {accepted,reason,unknowns,observations:[],...(rejectedRuleIds!==undefined?{rejectedRuleIds}:{})};
 return output;
}

const citationKey=(path:unknown,startLine:unknown,endLine:unknown,digest:unknown)=>JSON.stringify([path,startLine,endLine,digest]);

/** Only fixed validation reasons and structural field/index positions belong in this error. */
export class ResearchValidationError extends Error {
 constructor(reason:string,location?:string){super(location?location+': '+reason:reason);this.name='ResearchValidationError';}
}
const diagnosticFields=new Set(['observations','guidance','supportingEvidence','counterEvidence','sourceRef','evidence','coverage','scope','unknowns']);

export async function validateResearch(data:unknown,reader:RepositoryReader,exportedEvidence?:readonly Evidence[],exportedSourceEvidence?:readonly (EvidenceRead|Evidence)[]):Promise<void>{
 if(!data || typeof data !== 'object' || Array.isArray(data)) throw new ResearchValidationError('research: expected object');
 const verified=new Set<string>();
 const exported=exportedEvidence&&new Set(exportedEvidence.map(e=>citationKey(e.path,e.startLine,e.endLine,e.digest)));
 const read=reader.evidencePass?.()??reader.read.bind(reader);
 async function walk(value:unknown,location='research'):Promise<void>{
  if(!value || typeof value !== 'object') return;
  if(Array.isArray(value)) {for(const [index,item] of value.entries()) await walk(item,location+'['+index+']');return;}
  const obj=value as Record<string,unknown>;
  if('digest' in obj || ('startLine' in obj && 'path' in obj)) {
   if(typeof obj.path !== 'string' || !Number.isInteger(obj.startLine) || !Number.isInteger(obj.endLine) || typeof obj.digest !== 'string') throw new ResearchValidationError('evidence: invalid structure',location);
   const key=citationKey(obj.path,obj.startLine,obj.endLine,obj.digest);
   if(verified.has(key))return;
   if(exported&&!exported.has(key))throw new ResearchValidationError('evidence: citation was not exported for this analysis',location);
   if(exportedSourceEvidence&&reader.sourceScopes?.has(obj.path)&&!exportedSourceEvidence.some(item=>{
    const ref='evidence' in item?item.evidence:item;
    if(ref.path!==obj.path)return false;
    if(!('content' in item))return citationKey(ref.path,ref.startLine,ref.endLine,ref.digest)===key;
    const start=Number(obj.startLine),end=Number(obj.endLine);
    return ref.startLine<=start&&ref.endLine>=end&&start<=end&&
     digest(item.content.split('\n').slice(start-ref.startLine,end-ref.startLine+1).join('\n'))===obj.digest;
   }))throw new ResearchValidationError('evidence: scoped source body was not exported for this request',location);
   let real:EvidenceRead;
   try{real=await read(obj.path,Number(obj.startLine),Number(obj.endLine));}
   catch{throw new ResearchValidationError('evidence: source unavailable, denied, or range invalid',location);}
   if(real.evidence.digest !== obj.digest) throw new ResearchValidationError('evidence: digest mismatch',location);
   verified.add(key);
   return;
  }
  for(const [field,value] of Object.entries(obj)) await walk(value,location.length<128?location+'.'+(diagnosticFields.has(field)?field:'[field]'):'research.[nested]');
 }
 await walk(data);
 const observations=(data as Record<string,unknown>).observations;
 if(!Array.isArray(observations)) throw new ResearchValidationError('observations: required');
 const guidance=(data as Record<string,unknown>).guidance;
 if(guidance !== undefined && !Array.isArray(guidance)) throw new ResearchValidationError('guidance: expected array');
 const checkScope=(scope:unknown,refs:unknown[],location:string)=>{
  for(const ref of refs){
   const path=ref&&typeof ref==='object'?(ref as Partial<Evidence>).path:undefined;
   const authorized=path&&reader.sourceScopes?.get(path);
   if(authorized&&(!Array.isArray(scope)||!scope.length||scope.some(child=>typeof child!=='string'||
    !isConventionScope(child.replace(/\/+$/,''))||!authorized.some(parent=>scopeContains(parent,child)))))throw new ResearchValidationError('evidence: claim scope exceeds the source authorization',location);
  }
 };
 for(const [index,source] of ((guidance ?? []) as Record<string,unknown>[]).entries()) {
  const location='guidance['+index+']';
  if(!source||typeof source.topic !== 'string'||!['reusable','partial','missing','conflicting','unavailable'].includes(String(source.coverageStatus))||!guidanceLists.every(field=>stringArray(source[field])))throw new ResearchValidationError('guidance: invalid source assessment',location);
  const scopes=source.scope as string[];
  checkScope(scopes,[source.sourceRef],location);
  const derived=observations.filter(item=>item?.topic === source.topic && (source.topicId===undefined||item.topicId===undefined||item.topicId===source.topicId) &&
   item.classification !== 'explicit-rule'&&stringArray(item.scope)&&scopesOverlap(scopes,item.scope));
  if(['reusable','partial','conflicting','unavailable'].includes(String(source.coverageStatus))&&
   derived.some(item=>item.scope.some((scope:string)=>!scopes.some(parent=>scopeContains(parent,scope)))))throw new ResearchValidationError('guidance: narrow or split the overlapping observation scope',location);
  if(source.coverageStatus === 'reusable' && derived.length) throw new ResearchValidationError('guidance: reuse sufficient source before inference',location);
  if(source.coverageStatus === 'partial' && derived.some(item=>!(source.gaps as unknown[]).includes(item.gap))) throw new ResearchValidationError('guidance: research must address declared gap',location);
  if(['conflicting','unavailable'].includes(String(source.coverageStatus)) && derived.some(item=>item.guidanceDisposition === 'follow-existing')) throw new ResearchValidationError('guidance: unresolved source requires decision',location);
  if(['reusable','partial'].includes(String(source.coverageStatus))) {
   const ref=source.sourceRef as Record<string,unknown>|undefined;
   if(!ref || typeof ref !== 'object' || typeof ref.path !== 'string' || typeof ref.digest !== 'string' || !Number.isInteger(ref.startLine) || !Number.isInteger(ref.endLine)) throw new ResearchValidationError('guidance.sourceRef: verifiable evidence required',location);
  }
 }
 for(const [index,item] of observations.entries()) {
  const location='observations['+index+']';
  if(!item || typeof item !== 'object' || typeof item.statement !== 'string' || !Array.isArray(item.scope) || !Array.isArray(item.supportingEvidence) || !Array.isArray(item.counterEvidence)) throw new ResearchValidationError('observation: required fields',location);
  checkScope(item.scope,[...item.supportingEvidence,...item.counterEvidence],location);
  if(!['explicit-rule','convention','local-pattern','suggestion'].includes(item.classification)) throw new ResearchValidationError('classification: invalid',location);
  if(item.classification === 'convention' && (!Number.isInteger(item.coverage?.independentSupports) || item.coverage.independentSupports < 2 || item.coverage?.counterexampleSearched !== true || new Set(item.supportingEvidence.map((e:Evidence)=>e.digest)).size < 2)) throw new ResearchValidationError('convention: independent support and counterexample search required',location);
  if(item.classification === 'convention') {
   if(!Array.isArray(item.coverage?.counterexampleQueries) || !item.coverage.counterexampleQueries.length || item.coverage.counterexampleQueries.some((q:unknown)=>typeof q !== 'string' || !q.trim())) throw new ResearchValidationError('convention: counterexample query evidence required',location);
   const completed=searched.get(reader)??new Set<string>();searched.set(reader,completed);
   for(const query of item.coverage.counterexampleQueries)if(!completed.has(query)){
    try{await reader.search(query);}catch{throw new ResearchValidationError('convention: counterexample search unavailable',location);}completed.add(query);
   }
  }
  if(item.counterEvidence.length && !item.exceptions?.length && item.guidanceDisposition !== 'needs-decision') throw new ResearchValidationError('unexplained counterexample requires decision',location);
  if(item.classification === 'suggestion' && !['reference-only','needs-decision'].includes(item.guidanceDisposition)) throw new ResearchValidationError('suggestion: cannot become a rule',location);
  if(item.classification !== 'suggestion' && !item.supportingEvidence.length) throw new ResearchValidationError('evidence: support required',location);
 }
}

export class ResearchFailure extends Error {
 constructor(message:string,readonly unknowns:string[]=['Research incomplete; no semantic result accepted'],readonly usage?:{calls:number;tokens:number|'unknown'}) {super(message);this.name='ResearchFailure';}
}

export function validateResearchRequest(request:ResearchRequest):void {
 if(!['analyze','artifact-plan','artifact-content'].includes(request.kind)) throw new Error('research.kind: invalid');
 for(const field of ['runId','root','fingerprint','previousInventoryDigest','templateSourcesDigest'] as const) if(typeof request[field] !== 'string' || !request[field]) throw new Error('research.'+field+': required');
 if(!request.options || typeof request.options !== 'object' || Array.isArray(request.options)) throw new Error('research.options: expected object');
 validateOptions(request.options as Record<string,unknown>);
 if(request.effectiveModel)validateOptions({model:request.effectiveModel});
 for(const field of ['maxCalls','maxTokens'] as const) if(!Number.isSafeInteger(request.budget?.[field]) || request.budget[field]<0) throw new Error('research.budget.'+field+': invalid');
}
