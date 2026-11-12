import {ResearchFailure,type AnalysisBackend} from './backend.js';
import {estimateProviderInput,ProviderRequestFailure,providerBackend,providerObject,readTools,totalProviderTokens,type ProviderOptions} from './provider-loop.js';
import {validateProviderBaseURL} from './provider-url.js';
import {researchPrompt} from './prompts.js';

interface FunctionCall {id:string;type:'function';function:{name:string;arguments:string}}
type Message={role:'system'|'user';content:string}
 | {role:'assistant';content:string|null;tool_calls?:FunctionCall[]}
 | {role:'tool';content:string;tool_call_id:string};
const tools=readTools.map(({name,description,input_schema})=>({type:'function',function:{name,description,parameters:input_schema}}));

function parseCall(value:unknown):FunctionCall {
 const call=providerObject(value);
 const fn=providerObject(call?.function);
 if(call?.type!=='function'||typeof call.id!=='string'||typeof fn?.name!=='string'||typeof fn.arguments!=='string')throw new ResearchFailure('invalid provider tool call');
 return {id:call.id,type:'function',function:{name:fn.name,arguments:fn.arguments}};
}

function parseArguments(value:string):unknown {
 try{return JSON.parse(value);}catch{throw new ResearchFailure('invalid provider tool arguments');}
}

function completionUsage(response:unknown):number|'unknown' {
 const usage=providerObject(providerObject(response)?.usage);
 const sum=totalProviderTokens(usage?.prompt_tokens,usage?.completion_tokens);
 if(usage?.total_tokens===undefined)return sum;
 const total=totalProviderTokens(usage.total_tokens);
 if(usage.prompt_tokens===undefined&&usage.completion_tokens===undefined)return total;
 return total===sum?total:'unknown';
}

export function openAICompatibleBackend(options:ProviderOptions):AnalysisBackend {
 return providerBackend<unknown>(options,({apiKey,model},input)=>{
  const url=validateProviderBaseURL(options.baseURL??'https://api.openai.com/v1');
  url.pathname=url.pathname.replace(/\/+$/,'')+'/chat/completions';
  const fetcher=options.fetch??fetch;
  const messages:Message[]=[{role:'system',content:researchPrompt},{role:'user',content:input}];
  let repair=false;
  const body=()=>({model,messages,...(repair?{}:{tools})});
  return {
   countsInputRemotely:false,
   countInput:maxTokens=>estimateProviderInput({...body(),max_completion_tokens:maxTokens}),
   generate:async maxTokens=>{
    const timeout=AbortSignal.timeout(60_000);
    const signal=options.signal?AbortSignal.any([options.signal,timeout]):timeout;
    let response:Response;
    try{response=await fetcher(url.href,{
      method:'POST',redirect:'error',signal,
      headers:{'Authorization':`Bearer ${apiKey}`,'Content-Type':'application/json'},
      body:JSON.stringify({...body(),max_completion_tokens:maxTokens}),
     });}
    catch{throw new ProviderRequestFailure('chat/completions');}
    if(!response.ok){
     try{await response.body?.cancel();}catch{/* The status remains the useful safe diagnostic. */}
     throw new ProviderRequestFailure('chat/completions',response.status);
    }
    return await response.json() as unknown;
   },
   repair:(candidate,reason)=>{
    repair=true;
    messages.push({role:'assistant',content:candidate},{role:'user',content:reason});
   },
   usage:completionUsage,
   outcome:response=>{
    const completion=providerObject(response);
    const choices=completion?.choices;
    const choice=Array.isArray(choices)&&choices.length===1?providerObject(choices[0]):undefined;
    const message=providerObject(choice?.message);
    if(message?.role!=='assistant'||message.refusal)throw new ResearchFailure('provider returned no usable research message');
    const {content,tool_calls:toolCalls}=message;
    if(choice?.finish_reason==='stop'){
     const hasTools=toolCalls!=null && (!Array.isArray(toolCalls)||toolCalls.length>0);
     if(hasTools||typeof content!=='string'||typeof completion?.model!=='string')throw new ResearchFailure('provider returned invalid final research message');
     return {kind:'final',model:completion.model,text:content};
    }
    if(choice?.finish_reason!=='tool_calls'||!Array.isArray(toolCalls)||(content!=null&&typeof content!=='string'))throw new ResearchFailure('research incomplete: provider stopped before completing research');
    const calls=toolCalls.map(parseCall);
    return {
     kind:'tools',calls:calls.map(call=>({id:call.id,name:call.function.name,input:parseArguments(call.function.arguments)})),
     replay:results=>{
      messages.push({role:'assistant',content:content??null,tool_calls:calls});
      for(const result of results)messages.push({role:'tool',tool_call_id:result.id,content:result.content});
     },
    };
   },
  };
 });
}
