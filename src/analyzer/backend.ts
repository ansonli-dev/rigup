import {validateOptions} from '../config.js';
import type {Evidence,StepResult} from '../types.js';
import type {EvidenceRead,ReadEvidence} from './evidence.js';
export interface SearchSelection {paths:ReadonlySet<string>;limit:number}
export interface RepositoryReader {
 list():Promise<string[]>;
 read:ReadEvidence;
 /** A fresh reader that can share file loads within a single verification. */
 evidencePass?():ReadEvidence;
 search(query:string,selection?:SearchSelection):Promise<EvidenceRead[]>;
}
export interface ResearchRequest {kind:'analyze'|'artifact-plan'|'artifact-content';runId:string;root:string;fingerprint:string;options:unknown;effectiveModel?:import('../types.js').SetupOptions['model'];versions:Record<string,string>;budget:{maxCalls:number;maxTokens:number};spent?:{calls:number;tokens:number|'unknown'};artifact?:string;expectedOutput?:'plan'|'content'|'acceptance';input?:unknown;previousInventoryDigest:string;templateSourcesDigest:string}
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

export function selectResearchOutput(request:ResearchRequest,data:unknown):unknown {
 if(!data||typeof data!=='object'||Array.isArray(data))return data;
 const output=data as Record<string,unknown>;
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
 if(!Array.isArray(job?.ruleSources))return data;
 const {rulebook,accepted,reason,unknowns,rejectedRuleIds}=output;
 if(request.expectedOutput==='content')return {rulebook,unknowns,observations:[]};
 if(request.expectedOutput==='acceptance')return {accepted,reason,unknowns,observations:[],...(rejectedRuleIds!==undefined?{rejectedRuleIds}:{})};
 return data;
}

const citationKey=(path:unknown,startLine:unknown,endLine:unknown,digest:unknown)=>JSON.stringify([path,startLine,endLine,digest]);

export async function validateResearch(data:unknown,reader:RepositoryReader,exportedEvidence?:readonly Evidence[]):Promise<void>{
 if(!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('research: expected object');
 const verified=new Set<string>();
 const exported=exportedEvidence&&new Set(exportedEvidence.map(e=>citationKey(e.path,e.startLine,e.endLine,e.digest)));
 const read=reader.evidencePass?.()??reader.read.bind(reader);
 async function walk(value:unknown):Promise<void>{
  if(!value || typeof value !== 'object') return;
  if(Array.isArray(value)) {for(const item of value) await walk(item);return;}
  const obj=value as Record<string,unknown>;
  if('digest' in obj || ('startLine' in obj && 'path' in obj)) {
   if(typeof obj.path !== 'string' || !Number.isInteger(obj.startLine) || !Number.isInteger(obj.endLine) || typeof obj.digest !== 'string') throw new Error('evidence: invalid structure');
   const key=citationKey(obj.path,obj.startLine,obj.endLine,obj.digest);
   if(verified.has(key))return;
   if(exported&&!exported.has(key))throw new Error('evidence: citation was not exported for this analysis');
   const real=await read(obj.path,Number(obj.startLine),Number(obj.endLine));
   if(real.evidence.digest !== obj.digest) throw new Error('evidence: digest mismatch');
   verified.add(key);
   return;
  }
  for(const value of Object.values(obj)) await walk(value);
 }
 await walk(data);
 const observations=(data as Record<string,unknown>).observations;
 if(!Array.isArray(observations)) throw new Error('observations: required');
 const guidance=(data as Record<string,unknown>).guidance;
 if(guidance !== undefined && !Array.isArray(guidance)) throw new Error('guidance: expected array');
 for(const source of (guidance ?? []) as Record<string,unknown>[]) {
  if(typeof source.topic !== 'string' || !['reusable','partial','missing','conflicting','unavailable'].includes(String(source.coverageStatus)) || !Array.isArray(source.scope) || !Array.isArray(source.consumers) || !Array.isArray(source.gaps)) throw new Error('guidance: invalid source assessment');
  const derived=observations.filter(item=>item.topic === source.topic && (source.topicId===undefined||item.topicId===undefined||item.topicId===source.topicId) && item.classification !== 'explicit-rule');
  if(source.coverageStatus === 'reusable' && derived.length) throw new Error('guidance: reuse sufficient source before inference');
  if(source.coverageStatus === 'partial' && derived.some(item=>!(source.gaps as unknown[]).includes(item.gap))) throw new Error('guidance: research must address declared gap');
  if(['conflicting','unavailable'].includes(String(source.coverageStatus)) && derived.some(item=>item.guidanceDisposition === 'follow-existing')) throw new Error('guidance: unresolved source requires decision');
  if(['reusable','partial'].includes(String(source.coverageStatus))) {
   const ref=source.sourceRef as Record<string,unknown>|undefined;
   if(!ref || typeof ref !== 'object' || typeof ref.path !== 'string' || typeof ref.digest !== 'string' || !Number.isInteger(ref.startLine) || !Number.isInteger(ref.endLine)) throw new Error('guidance.sourceRef: verifiable evidence required');
  }
 }
 for(const item of observations) {
  if(!item || typeof item !== 'object' || typeof item.statement !== 'string' || !Array.isArray(item.scope) || !Array.isArray(item.supportingEvidence) || !Array.isArray(item.counterEvidence)) throw new Error('observation: required fields');
  if(!['explicit-rule','convention','local-pattern','suggestion'].includes(item.classification)) throw new Error('classification: invalid');
  if(item.classification === 'convention' && (!Number.isInteger(item.coverage?.independentSupports) || item.coverage.independentSupports < 2 || item.coverage?.counterexampleSearched !== true || new Set(item.supportingEvidence.map((e:Evidence)=>e.digest)).size < 2)) throw new Error('convention: independent support and counterexample search required');
  if(item.classification === 'convention') {
   if(!Array.isArray(item.coverage?.counterexampleQueries) || !item.coverage.counterexampleQueries.length || item.coverage.counterexampleQueries.some((q:unknown)=>typeof q !== 'string' || !q.trim())) throw new Error('convention: counterexample query evidence required');
   const completed=searched.get(reader)??new Set<string>();searched.set(reader,completed);
   for(const query of item.coverage.counterexampleQueries)if(!completed.has(query)){
    await reader.search(query);completed.add(query);
   }
  }
  if(item.counterEvidence.length && !item.exceptions?.length && item.guidanceDisposition !== 'needs-decision') throw new Error('unexplained counterexample requires decision');
  if(item.classification === 'suggestion' && !['reference-only','needs-decision'].includes(item.guidanceDisposition)) throw new Error('suggestion: cannot become a rule');
  if(item.classification !== 'suggestion' && !item.supportingEvidence.length) throw new Error('evidence: support required');
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
