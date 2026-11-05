import Anthropic from '@anthropic-ai/sdk';
import {ResearchFailure,validateResearchRequest,validateResearch,selectResearchOutput,type AnalysisBackend} from './backend.js';
import {researchPrompt} from './prompts.js';
const tools:Anthropic.Tool[]=[
 {name:'list',description:'List allowed source paths',input_schema:{type:'object',properties:{},additionalProperties:false}},
 {name:'read',description:'Read filtered evidence and visible digest',input_schema:{type:'object',properties:{path:{type:'string'},startLine:{type:'integer'},endLine:{type:'integer'}},required:['path','startLine','endLine'],additionalProperties:false}},
 {name:'search',description:'Search filtered project text',input_schema:{type:'object',properties:{query:{type:'string'}},required:['query'],additionalProperties:false}},
];
export function nativeBackend(options:{apiKey?:string;model?:string;fetch?:typeof fetch;signal?:AbortSignal;onUsage?:(usage:{calls:number;tokens:number|'unknown'})=>Promise<void>}={apiKey:process.env.ANTHROPIC_API_KEY,model:process.env.ANTHROPIC_MODEL}):AnalysisBackend {
 return {run:async(request,reader)=>{
  validateResearchRequest(request);
  if(!options.apiKey || !options.model) throw new Error('model configuration: API key and model required');
  if(request.budget.maxCalls<1 || request.budget.maxTokens<1) throw new ResearchFailure('research budget exhausted');
  const spent=request.spent ?? {calls:0,tokens:0};
  if(spent.tokens === 'unknown' || spent.calls>=request.budget.maxCalls || spent.tokens>=request.budget.maxTokens) throw new ResearchFailure('restored research budget exhausted or unknown');
  const client=new Anthropic({apiKey:options.apiKey,fetch:options.fetch,maxRetries:0,timeout:60000});
  const messages:Anthropic.MessageParam[]=[{role:'user',content:JSON.stringify(request)}];
  let tokens=0;let requests=0;let usageKnown=true;
  try {
  for(let calls=1;calls<=request.budget.maxCalls;calls++) {
   if(requests+spent.calls+2>request.budget.maxCalls) throw new ResearchFailure('research request budget exhausted');
   requests++;
   await options.onUsage?.({calls:requests,tokens});
   const count=await client.messages.countTokens({model:options.model,system:researchPrompt,messages,tools},{signal:options.signal}).catch(()=>{throw new ResearchFailure('provider request failed; research incomplete');});
   if(!Number.isSafeInteger(count.input_tokens) || count.input_tokens<0 || count.input_tokens>=request.budget.maxTokens-tokens-spent.tokens) throw new ResearchFailure('research input token budget exhausted');
   requests++;
   usageKnown=false;
   await options.onUsage?.({calls:requests,tokens:'unknown'});
   const response=await client.messages.create({model:options.model,max_tokens:Math.min(4096,request.budget.maxTokens-tokens-spent.tokens-count.input_tokens),system:researchPrompt,messages,tools},{signal:options.signal}).catch(()=>{throw new ResearchFailure('provider request failed; research incomplete');});
   usageKnown=true;
   tokens+=response.usage.input_tokens+response.usage.output_tokens+(response.usage.cache_creation_input_tokens??0)+(response.usage.cache_read_input_tokens??0);
   await options.onUsage?.({calls:requests,tokens});
   if(tokens+spent.tokens>request.budget.maxTokens) throw new ResearchFailure('research token budget exhausted; incomplete research');
   if(response.stop_reason === 'end_turn') {
    const text=response.content.filter(b=>b.type === 'text').map(b=>b.text).join('');
    let data:unknown;try {data=selectResearchOutput(request,JSON.parse(text));}catch{throw new ResearchFailure('provider returned invalid research JSON');}
    await validateResearch(data,reader);
    const unknowns=(data as {unknowns?:unknown}).unknowns;
    if(!Array.isArray(unknowns)||unknowns.some(x=>typeof x !== 'string')) throw new Error('unknowns: string array required');
    return {status:'complete',value:{data,model:response.model,unknowns,usage:{calls:requests,tokens}}};
   }
   if(response.stop_reason !== 'tool_use') throw new ResearchFailure('research incomplete: '+response.stop_reason);
   messages.push({role:'assistant',content:response.content});
   const results:Anthropic.ToolResultBlockParam[]=[];
   for(const block of response.content) if(block.type === 'tool_use') {
    const input=block.input as Record<string,unknown>;let result:unknown;
    if(block.name === 'list') result=await reader.list();
    else if(block.name === 'read' && typeof input.path === 'string' && Number.isInteger(input.startLine) && Number.isInteger(input.endLine)) result=await reader.read(input.path,Number(input.startLine),Number(input.endLine));
    else if(block.name === 'search' && typeof input.query === 'string') result=await reader.search(input.query);
    else throw new Error('unsupported read tool or arguments');
    results.push({type:'tool_result',tool_use_id:block.id,content:JSON.stringify(result)});
   }
   messages.push({role:'user',content:results});
  }
  throw new ResearchFailure('research call budget exhausted; incomplete research');
  } catch(error) {
   throw new ResearchFailure(error instanceof Error?error.message:'research failed',error instanceof ResearchFailure?error.unknowns:undefined,{calls:requests,tokens:usageKnown?tokens:'unknown'});
  }
 }};
}
