import Anthropic from '@anthropic-ai/sdk';
import {ResearchFailure,type AnalysisBackend} from './backend.js';
import {providerBackend,readTools,totalProviderTokens,type ProviderOptions} from './provider-loop.js';
import {validateProviderBaseURL} from './provider-url.js';
import {researchPrompt} from './prompts.js';

export function nativeBackend(options:ProviderOptions={apiKey:process.env.ANTHROPIC_API_KEY,model:process.env.ANTHROPIC_MODEL}):AnalysisBackend {
 return providerBackend<Anthropic.Message>(options,({apiKey,model},input)=>{
  const baseURL=options.baseURL??(process.env.ANTHROPIC_BASE_URL?.trim()||undefined);
  const fetcher=options.fetch??fetch;
  const client=new Anthropic({
   apiKey,baseURL:baseURL===undefined?undefined:validateProviderBaseURL(baseURL).href,
   // The SDK reads ANTHROPIC_CUSTOM_HEADERS from the caller's shell.
   // Send only the selected credential and the Messages protocol headers.
   fetch:(input,init)=>fetcher(input,{...init,headers:{'x-api-key':apiKey,'anthropic-version':'2023-06-01','content-type':'application/json'},redirect:'error'}),
   maxRetries:0,timeout:60000,logLevel:'off',
  });
  const messages:Anthropic.MessageParam[]=[{role:'user',content:input}];
  const body={model,system:researchPrompt,messages,tools:readTools};
  return {
   countsInputRemotely:true,
   countInput:async()=>(await client.messages.countTokens(body,{signal:options.signal}))?.input_tokens,
   generate:maxTokens=>client.messages.create({...body,max_tokens:maxTokens},{signal:options.signal}),
   usage:response=>{
    const usage=response?.usage;
    return totalProviderTokens(usage?.input_tokens,usage?.output_tokens,usage?.cache_creation_input_tokens??0,usage?.cache_read_input_tokens??0);
   },
   outcome:response=>{
    const content=response.content;
    if(!Array.isArray(content))throw new ResearchFailure('provider returned invalid research response');
    const toolBlocks=content.filter(block=>block.type==='tool_use');
    if(response.stop_reason==='end_turn' && !toolBlocks.length){
     const text=content.filter(block=>block.type==='text').map(block=>block.text).join('');
     return {kind:'final',text,model:response.model};
    }
    if(response.stop_reason!=='tool_use')throw new ResearchFailure('research incomplete: provider stopped before completing research');
    return {
     kind:'tools',calls:toolBlocks.map(({id,name,input})=>({id,name,input})),
     replay:results=>{
      messages.push({role:'assistant',content});
      messages.push({role:'user',content:results.map(({id,content})=>({type:'tool_result',tool_use_id:id,content}))});
     },
    };
   },
  };
 });
}
