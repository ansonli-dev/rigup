import {ResearchFailure,selectResearchOutput,validateResearch,validateResearchRequest,type AnalysisBackend,type RepositoryReader,type ResearchRequest} from './backend.js';

export interface ProviderOptions {
 apiKey?:string;
 model?:string;
 baseURL?:string;
 fetch?:typeof fetch;
 signal?:AbortSignal;
 onUsage?:(usage:{calls:number;tokens:number|'unknown'})=>Promise<void>;
}

export const readTools=[
 {name:'list',description:'List allowed source paths',input_schema:{type:'object' as const,properties:{},additionalProperties:false}},
 {name:'read',description:'Read filtered evidence and visible digest',input_schema:{type:'object' as const,properties:{path:{type:'string'},startLine:{type:'integer'},endLine:{type:'integer'}},required:['path','startLine','endLine'],additionalProperties:false}},
 {name:'search',description:'Search filtered project text',input_schema:{type:'object' as const,properties:{query:{type:'string'}},required:['query'],additionalProperties:false}},
];

interface ReadToolCall {id:string;name:string;input:unknown}
interface ReadToolResult {id:string;content:string}
type ProviderOutcome={kind:'final';text:string;model:string}|{kind:'tools';calls:ReadToolCall[];replay(results:ReadToolResult[]):void};
interface ProviderSession<Response> {
 countsInputRemotely:boolean;
 countInput():Promise<unknown>|number;
 generate(maxTokens:number):Promise<Response>;
 usage(response:Response):number|'unknown';
 outcome(response:Response):ProviderOutcome;
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

async function acceptedResult(request:ResearchRequest,reader:RepositoryReader,text:string,model:string){
 if(typeof model!=='string'||!model.trim())throw new ResearchFailure('provider did not identify the research model');
 let data:unknown;
 try{data=selectResearchOutput(request,JSON.parse(text));}catch{throw new ResearchFailure('provider returned invalid research JSON');}
 try{await validateResearch(data,reader);}catch{throw new ResearchFailure('provider returned invalid research evidence or structure');}
 const unknowns=providerObject(data)?.unknowns;
 if(!Array.isArray(unknowns)||unknowns.some(x=>typeof x!=='string'))throw new ResearchFailure('unknowns: string array required');
 return {data,model,unknowns};
}

async function dispatch<T>(send:()=>Promise<T>):Promise<T> {
 try{return await send();}catch{throw new ResearchFailure('provider request failed; research incomplete');}
}

export function providerBackend<Response>(options:ProviderOptions,createSession:(credentials:{apiKey:string;model:string},input:string)=>ProviderSession<Response>):AnalysisBackend {
 return {run:async(request,reader)=>{
  validateResearchRequest(request);
  const {apiKey,model,signal}=options;
  if(!apiKey?.trim()||!model?.trim())throw new Error('model configuration: API key and model required');
  if(request.budget.maxCalls<1||request.budget.maxTokens<1)throw new ResearchFailure('research budget exhausted');
  const spent=request.spent??{calls:0,tokens:0};
  if(!isNonNegativeInteger(spent.calls)||!isNonNegativeInteger(spent.tokens)||spent.calls>=request.budget.maxCalls||spent.tokens>=request.budget.maxTokens)throw new ResearchFailure('restored research budget exhausted or unknown');
  const maxCalls=request.budget.maxCalls-spent.calls;
  const maxTokens=request.budget.maxTokens-spent.tokens;
  const session=createSession({apiKey,model},JSON.stringify(request));
  const callsPerTurn=session.countsInputRemotely?2:1;
  let calls=0;
  let tokens=0;
  let usageKnown=true;
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
    if(callsPerTurn>maxCalls-calls)throw new ResearchFailure('research request budget exhausted');
    if(tokens>=maxTokens)throw new ResearchFailure('research token budget exhausted; incomplete research');
    if(session.countsInputRemotely){
     calls++;
     await persistUsage();
     checkCancellation();
    }
    const inputTokens=await dispatch(async()=>session.countInput());
    const remaining=maxTokens-tokens;
    if(!isNonNegativeInteger(inputTokens)||inputTokens>=remaining)throw new ResearchFailure('research input token budget exhausted');
    checkCancellation();
    calls++;
    usageKnown=false;
    await persistUsage();
    checkCancellation();
    const response=await dispatch(()=>session.generate(Math.min(4096,remaining-inputTokens)));
    const used=session.usage(response);
    if(used==='unknown'||!Number.isSafeInteger(spent.tokens+tokens+used))throw new ResearchFailure('provider token usage unknown; research incomplete');
    tokens+=used;
    usageKnown=true;
    await persistUsage();
    if(tokens>maxTokens)throw new ResearchFailure('research token budget exhausted; incomplete research');
    checkCancellation();
    const outcome=session.outcome(response);
    if(outcome.kind==='final')return {status:'complete',value:{...await acceptedResult(request,reader,outcome.text,outcome.model),usage:{calls,tokens}}};

    const ids=new Set(outcome.calls.map(call=>call.id));
    if(!outcome.calls.length||ids.size!==outcome.calls.length||outcome.calls.some(call=>typeof call.id!=='string'||!call.id.trim()))throw new ResearchFailure('invalid provider tool call IDs');
    const actions=outcome.calls.map(call=>prepareReadTool(call,reader));
    const results:ReadToolResult[]=[];
    for(const [index,action] of actions.entries()){
     checkCancellation();
     try{results.push({id:outcome.calls[index].id,content:JSON.stringify(await action())});}
     catch{throw new ResearchFailure('repository read failed; research incomplete');}
    }
    outcome.replay(results);
   }
  }catch(error){
   if(error instanceof ResearchFailure)throw new ResearchFailure(error.message,error.unknowns,usage());
   throw new ResearchFailure('provider returned invalid research response',undefined,usage());
  }
 }};
}
