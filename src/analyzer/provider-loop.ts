import {ResearchFailure,ResearchValidationError,selectResearchOutput,validateResearch,validateResearchRequest,type AnalysisBackend,type RepositoryReader,type ResearchRequest} from './backend.js';
import {stageSourceGuidance,STAGE_EVIDENCE_POLICY} from './stage-context.js';
import {EvidenceRangeError,type EvidenceRead} from './evidence.js';

export interface ProviderOptions {
 apiKey?:string;
 model?:string;
 baseURL?:string;
 fetch?:typeof fetch;
 signal?:AbortSignal;
 maxOutputTokens?:number;
 onUsage?:(usage:{calls:number;tokens:number|'unknown'})=>Promise<void>;
 onDiagnostic?:(message:string)=>void;
}

export const DEFAULT_MAX_OUTPUT_TOKENS=16384;
export const isValidMaxOutputTokens=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0;
// Compatible APIs do not share a tokenizer; reserve one token per UTF-8 byte plus protocol framing.
export const estimateProviderInput=(body:unknown)=>Buffer.byteLength(JSON.stringify(body),'utf8')+128;

type ProviderOperation='count_tokens'|'messages'|'chat/completions';
export class ProviderRequestFailure extends ResearchFailure {
 constructor(operation:ProviderOperation,status?:number){
  const guidance=status===401?'check the API key':status===403?'check API key and model permission':
   status===404||status===405?'check the configured base URL and endpoint support':
   status===429?'provider rate limit reached; retry later':status!==undefined&&status>=500?'provider server failure; retry later':
   status===undefined?'check network connectivity and timeout':'check provider configuration and request limits';
  super('provider '+operation+' request failed'+(status===undefined?' (network or timeout)':' (HTTP '+status+')')+'; '+guidance+'; research incomplete');
 }
}

export const readTools=[
 {name:'list',description:'List allowed source paths',input_schema:{type:'object' as const,properties:{},additionalProperties:false}},
 {name:'read',description:'Read filtered evidence and visible digest',input_schema:{type:'object' as const,properties:{path:{type:'string'},startLine:{type:'integer'},endLine:{type:'integer'}},required:['path','startLine','endLine'],additionalProperties:false}},
 {name:'search',description:'Search filtered project text',input_schema:{type:'object' as const,properties:{query:{type:'string'}},required:['query'],additionalProperties:false}},
];

interface ReadToolCall {id:string;name:string;input:unknown}
interface ReadToolResult {id:string;content:string;isError?:true}
type ProviderOutcome={kind:'final';text:string;model:string}|{kind:'tools';calls:ReadToolCall[];replay(results:ReadToolResult[]):void};
interface ProviderSession<Response> {
 countsInputRemotely:boolean;
 countInput(maxTokens:number):Promise<unknown>|number;
 generate(maxTokens:number):Promise<Response>;
 usage(response:Response):number|'unknown';
 outcome(response:Response):ProviderOutcome;
 repair(candidate:string,reason:string):void;
}

export function providerObject(value:unknown):Record<string,unknown>|undefined {
 return value!==null && typeof value==='object' && !Array.isArray(value) ? value as Record<string,unknown> : undefined;
}

function isNonNegativeInteger(value:unknown):value is number {
 return typeof value==='number' && Number.isSafeInteger(value) && value>=0;
}

export function totalProviderTokens(...values:unknown[]):number|'unknown' {
 let total=0;
 for(const value of values){
  if(!isNonNegativeInteger(value))return 'unknown';
  total+=value;
 }
 return Number.isSafeInteger(total)?total:'unknown';
}

function prepareReadTool(call:ReadToolCall,reader:RepositoryReader):()=>Promise<unknown> {
 const input=providerObject(call.input);
 if(input){
  const keys=Object.keys(input).length;
  const {path,startLine,endLine,query}=input;
  if(call.name==='list' && keys===0)return ()=>reader.list();
  if(call.name==='read' && keys===3 && typeof path==='string' && path && isNonNegativeInteger(startLine) && startLine>0 && isNonNegativeInteger(endLine) && endLine>=startLine)return ()=>reader.read(path,startLine,endLine);
  if(call.name==='search' && keys===1 && typeof query==='string' && query)return ()=>reader.search(query);
 }
 throw new ResearchFailure('unsupported read tool or arguments');
}

async function acceptedResult(request:ResearchRequest,reader:RepositoryReader,text:string,model:string,exportedSourceEvidence:EvidenceRead[]){
 if(typeof model!=='string'||!model.trim())throw new ResearchFailure('provider did not identify the research model');
 let data:unknown;
 try{data=selectResearchOutput(request,JSON.parse(text));}catch{throw new ResearchValidationError('provider returned invalid research JSON');}
 try{await validateResearch(data,reader,undefined,exportedSourceEvidence);}catch(error){
  if(error instanceof ResearchValidationError)throw error;
  throw new ResearchValidationError('provider returned invalid research evidence or structure');
 }
 const unknowns=providerObject(data)?.unknowns;
 if(!Array.isArray(unknowns)||unknowns.some(x=>typeof x!=='string'))throw new ResearchValidationError('unknowns: string array required');
 return {data,model,unknowns};
}

async function dispatch<T>(send:()=>Promise<T>):Promise<T> {
 try{return await send();}catch(error){
  if(error instanceof ProviderRequestFailure)throw error;
  throw new ResearchFailure('provider request failed; research incomplete');
 }
}

export function providerBackend<Response>(options:ProviderOptions,createSession:(credentials:{apiKey:string;model:string},input:string)=>ProviderSession<Response>):AnalysisBackend {
 return {artifactContextVersion:STAGE_EVIDENCE_POLICY,run:async(request,reader)=>{
  validateResearchRequest(request);
  const {apiKey,model,signal}=options;
  if(!apiKey?.trim()||!model?.trim())throw new Error('model configuration: API key and model required');
  const outputCap=options.maxOutputTokens??DEFAULT_MAX_OUTPUT_TOKENS;
  if(!isValidMaxOutputTokens(outputCap))throw new Error('model configuration: maximum output tokens must be a positive integer');
  if(request.budget.maxCalls<1||request.budget.maxTokens<1)throw new ResearchFailure('research budget exhausted');
  const spent=request.spent??{calls:0,tokens:0};
  if(!isNonNegativeInteger(spent.calls)||!isNonNegativeInteger(spent.tokens)||spent.calls>=request.budget.maxCalls||spent.tokens>=request.budget.maxTokens)throw new ResearchFailure('restored research budget exhausted or unknown');
  const maxCalls=request.budget.maxCalls-spent.calls;
  const maxTokens=request.budget.maxTokens-spent.tokens;
  const sourceEvidence=await stageSourceGuidance(reader,request.sourceGuidance);
  const exportedSourceEvidence=[...sourceEvidence];
  const session=createSession({apiKey,model},JSON.stringify({...request,...(sourceEvidence.length?{sourceEvidence}:{})}));
  let calls=0;
  let tokens=0;
  let usageKnown=true;
  let repairReason:ResearchValidationError|undefined;
  const usage=()=>({calls,tokens:usageKnown?tokens:'unknown' as const});
  const persistUsage=async()=>{
   try{await options.onUsage?.(usage());}catch{throw new ResearchFailure('could not persist research usage');}
  };
  const checkCancellation=()=>{
   if(signal?.aborted)throw new ResearchFailure('provider request cancelled; research incomplete');
  };

  try{
   for(;;){
    checkCancellation();
    if((session.countsInputRemotely?2:1)>maxCalls-calls)throw repairReason??new ResearchFailure('research request budget exhausted');
    if(tokens>=maxTokens)throw repairReason??new ResearchFailure('research token budget exhausted; incomplete research');
    if(session.countsInputRemotely){
     calls++;
     await persistUsage();
     checkCancellation();
    }
    const inputTokens=await dispatch(async()=>session.countInput(outputCap));
    const remaining=maxTokens-tokens;
    if(!isNonNegativeInteger(inputTokens)||inputTokens>=remaining)throw repairReason??new ResearchFailure('research input token budget exhausted');
    checkCancellation();
    calls++;
    usageKnown=false;
    await persistUsage();
    checkCancellation();
    const response=await dispatch(()=>session.generate(Math.min(outputCap,remaining-inputTokens)));
    const used=session.usage(response);
    if(used==='unknown'||!Number.isSafeInteger(spent.tokens+tokens+used))throw new ResearchFailure('provider token usage unknown; research incomplete');
    tokens+=used;
    usageKnown=true;
    await persistUsage();
    if(tokens>maxTokens)throw new ResearchFailure('research token budget exhausted; incomplete research');
    checkCancellation();
    const outcome=session.outcome(response);
    if(outcome.kind==='final'){
     try{return {status:'complete',value:{...await acceptedResult(request,reader,outcome.text,outcome.model,exportedSourceEvidence),usage:{calls,tokens}}};}
     catch(error){
      if(!(error instanceof ResearchValidationError)||repairReason)throw error;
      repairReason=error;
      options.onDiagnostic?.('Research final validation failed; attempting one repair: '+error.message);
      session.repair(outcome.text,'Repair the final JSON using only evidence already provided. No tools are available. Validation failed: '+error.message);
      continue;
     }
    }
    if(repairReason)throw new ResearchFailure('provider final repair attempted tool operations; research incomplete');

    const ids=new Set(outcome.calls.map(call=>call.id));
    if(!outcome.calls.length||ids.size!==outcome.calls.length||outcome.calls.some(call=>typeof call.id!=='string'||!call.id.trim()))throw new ResearchFailure('invalid provider tool call IDs');
    const actions=outcome.calls.map(call=>prepareReadTool(call,reader));
    const results:ReadToolResult[]=[];
    for(const [index,action] of actions.entries()){
     checkCancellation();
     try{
      const value=await action();
      for(const item of Array.isArray(value)?value:[value]){
       const evidence=providerObject(item) as EvidenceRead|undefined;
       if(evidence?.evidence&&typeof evidence.content==='string'&&reader.sourceScopes?.has(evidence.evidence.path))exportedSourceEvidence.push(evidence);
      }
      results.push({id:outcome.calls[index].id,content:JSON.stringify(value)});
     }
     catch(error){
      if(error instanceof EvidenceRangeError)results.push({id:outcome.calls[index].id,isError:true,content:JSON.stringify({error:'evidence range beyond file',lineCount:error.lineCount})});
      else throw new ResearchFailure('repository read failed; research incomplete');
     }
    }
    outcome.replay(results);
   }
  }catch(error){
   if(error instanceof ResearchFailure)throw new ResearchFailure(error.message,error.unknowns,usage());
   if(error instanceof ResearchValidationError)throw new ResearchFailure(error.message,undefined,usage());
   throw new ResearchFailure('provider returned invalid research response',undefined,usage());
  }
 }};
}
