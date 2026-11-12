import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {test} from 'node:test';
import {ResearchFailure,type RepositoryReader,type ResearchRequest} from '../src/analyzer/backend.js';
import {openAICompatibleBackend} from '../src/analyzer/openai-compatible.js';
import {repositoryReader} from '../src/analyzer/repository.js';
import {project} from './helpers.js';

const request:ResearchRequest={kind:'analyze',runId:'compatible-fixture',root:process.cwd(),fingerprint:'x',options:{agents:['claude']},versions:{policy:'1'},budget:{maxCalls:2,maxTokens:50_000},previousInventoryDigest:'none',templateSourcesDigest:'none'};
const reader:RepositoryReader={list:async()=>[],read:async()=>{throw Error('unknown source');},search:async()=>[]};
const credentials={apiKey:'fixture-api-key',model:'requested-model'};
const usage={prompt_tokens:16,completion_tokens:4,total_tokens:20};
const final={role:'assistant',content:JSON.stringify({observations:[],unknowns:['uncovered fixture']})};
const tool=(id:string,name:string,args:string)=>({id,type:'function',function:{name,arguments:args}});
const response=(message:unknown=final,finish_reason='stop',tokens:unknown=usage)=>Response.json({id:'chatcmpl-fixture',object:'chat.completion',created:1,model:'served-model',choices:[{index:0,message,finish_reason}],usage:tokens});

test('compatible backend correlates multiple filtered read results and durably records each turn',async()=>{
 await project(async root=>{
  await writeFile(join(root,'config.yaml'),'token: fixture-source-secret\nname: fixture-tool\n');
  const toolCalls=[tool('list-id','list','{}'),tool('read-id','read','{"path":"config.yaml","startLine":1,"endLine":2}'),tool('search-id','search','{"query":"fixture-tool"}')];
  const turns:{calls:number;tokens:number|'unknown'}[]=[];
  const bodies:string[]=[];
  const backend=openAICompatibleBackend({...credentials,baseURL:'https://example.test/compatible/v1/',onUsage:async value=>{turns.push(value);},fetch:async(url,init)=>{
   assert.equal(String(url),'https://example.test/compatible/v1/chat/completions');
   assert.equal(init?.redirect,'error');
   assert.equal(new Headers(init?.headers).get('Authorization'),'Bearer fixture-api-key');
   const body=String(init?.body);
   bodies.push(body);
   assert.deepEqual(turns.at(-1),{calls:bodies.length,tokens:'unknown'});
   const parsed=JSON.parse(body);
   assert.equal(parsed.model,'requested-model');
   assert.deepEqual(parsed.tools.map((entry:{function:{name:string}})=>entry.function.name),['list','read','search']);
   if(bodies.length===1)return response({role:'assistant',content:'Collecting evidence',tool_calls:toolCalls},'tool_calls');
   assert.deepEqual(parsed.messages[2],{role:'assistant',content:'Collecting evidence',tool_calls:toolCalls});
   assert.deepEqual(parsed.messages.slice(3).map((entry:{role:string;tool_call_id:string})=>[entry.role,entry.tool_call_id]),[['tool','list-id'],['tool','read-id'],['tool','search-id']]);
   assert.ok(JSON.parse(parsed.messages[3].content).includes('config.yaml'));
   assert.match(JSON.parse(parsed.messages[4].content).content,/fixture-tool/);
   assert.ok(JSON.parse(parsed.messages[5].content).some((hit:{content:string})=>hit.content.includes('fixture-tool')));
   return response();
  }});
  const result=await backend.run({...request,root},await repositoryReader(root,{agents:[],backend:'host'}));
  assert.deepEqual(result,{status:'complete',value:{data:{observations:[],unknowns:['uncovered fixture']},unknowns:['uncovered fixture'],model:'served-model',usage:{calls:2,tokens:40}}});
  assert.deepEqual(turns,[{calls:1,tokens:'unknown'},{calls:1,tokens:20},{calls:2,tokens:'unknown'},{calls:2,tokens:40}]);
  assert.doesNotMatch(bodies.join('\n'),/fixture-api-key|fixture-source-secret/);
 });
});

test('compatible backend enforces remaining calls and blocks restored unknown usage',async()=>{
 let sent=0;
 const backend=openAICompatibleBackend({...credentials,fetch:async()=>{
  sent++;
  return response({role:'assistant',content:null,tool_calls:[tool('list-id','list','{}')]},'tool_calls');
 }});
 await assert.rejects(backend.run({...request,spent:{calls:1,tokens:25}},reader),(error:unknown)=>{
  assert.ok(error instanceof ResearchFailure);
  assert.match(error.message,/budget/);
  assert.deepEqual(error.usage,{calls:1,tokens:20});
  return true;
 });
 await assert.rejects(backend.run({...request,spent:{calls:1,tokens:'unknown'}},reader),/budget|unknown/);
 assert.equal(sent,1);
});

test('compatible backend preflights input size and caps completion to the available allowance',async()=>{
 const requests:{bytes:number;limit:number}[]=[];
 const backend=openAICompatibleBackend({...credentials,fetch:async(_url,init)=>{
  const body=String(init?.body);
  requests.push({bytes:Buffer.byteLength(body),limit:JSON.parse(body).max_completion_tokens});
  return response();
 }});
 await assert.rejects(backend.run({...request,input:'x'.repeat(request.budget.maxTokens)},reader),/input token budget/);
 assert.equal(requests.length,0);
 await backend.run(request,reader);
 assert.equal(requests[0].limit,16384);
 const remaining=requests[0].bytes+2048;
 assert.equal((await backend.run({...request,spent:{calls:0,tokens:request.budget.maxTokens-remaining}},reader)).status,'complete');
 assert.ok(requests[1].limit>0 && requests[1].limit<=2048);
});

test('compatible backend passes a configured completion cap',async()=>{
 const caps:number[]=[];
 const backend=(maxOutputTokens:number)=>openAICompatibleBackend({...credentials,maxOutputTokens,fetch:async(_url,init)=>{
  caps.push(JSON.parse(String(init?.body)).max_completion_tokens);return response();
 }});
 for(const cap of [32_000,500])await backend(cap).run(request,reader);
 for(const cap of [0,-1,1.5,NaN,Number.MAX_SAFE_INTEGER+1])await assert.rejects(backend(cap).run(request,reader),/maximum output tokens/);
 assert.deepEqual(caps,[32_000,500]);
});

test('compatible cap reserves the full serialized UTF-8 request plus framing',async()=>{
 const maxTokens=50_000;let offered=0,bytes=0;
 const backend=openAICompatibleBackend({...credentials,maxOutputTokens:100_000,fetch:async(_url,init)=>{
  const body=String(init?.body);
  offered=JSON.parse(body).max_completion_tokens;bytes=Buffer.byteLength(body,'utf8');
  return response();
 }});
 assert.equal((await backend.run({...request,input:'🦦\\\"'.repeat(250),budget:{maxCalls:1,maxTokens}},reader)).status,'complete');
 assert.ok(offered+bytes+128<=maxTokens);
});

test('compatible backend reports generation status without echoing provider errors',async()=>{
 const backend=openAICompatibleBackend({...credentials,fetch:async()=>new Response('private gateway body fixture-api-key',{status:403})});
 await assert.rejects(backend.run(request,reader),(error:unknown)=>{
  assert.ok(error instanceof ResearchFailure);
  assert.match(error.message,/chat\/completions.*HTTP 403.*model/i);
  assert.doesNotMatch(error.message,/private gateway body|fixture-api-key/);
  return true;
 });
});

test('compatible backend sends the rejected citation location in one final repair',async()=>{
 const citation={path:'config.yaml',startLine:1,endLine:1,digest:'fixture-api-key'};
 const bad={role:'assistant',content:JSON.stringify({observations:[{supportingEvidence:[citation]}],unknowns:[]})};
 const source={...reader,read:async()=>({content:'config',evidence:{...citation,digest:'real'}})};
 const notices:string[]=[];
 for(const canRepair of [true,false]){
  let sent=0;
  const backend=openAICompatibleBackend({...credentials,onDiagnostic:message=>notices.push(message),fetch:async(_url,init)=>{
   if(++sent===1)return response(bad);
   const {messages}=JSON.parse(String(init?.body));
   assert.equal(messages.at(-2).content,bad.content);
   assert.match(messages.at(-1).content,/observations\[0\]\.supportingEvidence\[0\].*digest mismatch/);
   return response(canRepair?final:bad);
  }});
  const repairRequest={...request,budget:{...request.budget,maxCalls:3}};
  if(canRepair){
   const result=await backend.run(repairRequest,source);
   assert.equal(result.status,'complete');
   if(result.status==='complete')assert.deepEqual(result.value.usage,{calls:2,tokens:40});
  }else{
   await assert.rejects(backend.run(repairRequest,source),(error:unknown)=>{
    assert.ok(error instanceof ResearchFailure);
    assert.match(error.message,/observations\[0\]\.supportingEvidence\[0\].*digest mismatch/);
    assert.doesNotMatch(error.message,/fixture-api-key/);
    assert.deepEqual(error.usage,{calls:2,tokens:40});
    return true;
   });
  }
  assert.equal(sent,2);
 }
 assert.equal(notices.length,2);
 assert.ok(notices.every(notice=>notice.includes('digest mismatch')&&!notice.includes('fixture-api-key')));
});

test('repair rejects tools without reading and retains the charged usage',async()=>{
 let turns=0,reads=0;
 const backend=openAICompatibleBackend({...credentials,fetch:async(_url,init)=>{
  if(++turns===1)return response({role:'assistant',content:'{}'});
  const body=JSON.parse(String(init?.body));assert.equal(body.tools,undefined);
  return response({role:'assistant',content:null,tool_calls:[tool('new-read','list','{}')]},'tool_calls');
 }});
 await assert.rejects(backend.run(request,{...reader,list:async()=>{reads++;return [];}}),(error:unknown)=>{
  assert.ok(error instanceof ResearchFailure);assert.match(error.message,/repair.*tool/i);
  assert.deepEqual(error.usage,{calls:2,tokens:40});return true;
 });
 assert.equal(turns,2);assert.equal(reads,0);
});

test('repair cannot reset call or token budgets and preserves the original validation reason',async()=>{
 for(const [maxCalls,maxTokens,used] of [[1,50_000,20],[2,50_000,49_999]] as const){
  let turns=0;
  const backend=openAICompatibleBackend({...credentials,fetch:async()=>{
   turns++;return response({role:'assistant',content:'{}'},'stop',{total_tokens:used});
  }});
  await assert.rejects(backend.run({...request,budget:{maxCalls,maxTokens}},reader),(error:unknown)=>{
   assert.ok(error instanceof ResearchFailure);assert.match(error.message,/observations.*required/);
   assert.deepEqual(error.usage,{calls:1,tokens:used});return true;
  });
  assert.equal(turns,1);
 }
});

test('validation diagnostics never echo untrusted property names or reader errors',async()=>{
 for(const data of [{observations:[],unknowns:[],secretPropertyFixture:{path:'fixture-secret-path',startLine:1,endLine:1,digest:'bad'}},{observations:[],unknowns:[42]}]){
  const notices:string[]=[];
  const backend=openAICompatibleBackend({...credentials,onDiagnostic:message=>notices.push(message),fetch:async()=>response({role:'assistant',content:JSON.stringify(data)})});
  await assert.rejects(backend.run(request,{...reader,read:async()=>{throw Error('fixture-secret-reader');}}),(error:unknown)=>{
   assert.ok(error instanceof ResearchFailure);assert.doesNotMatch(error.message,/secretPropertyFixture|fixture-secret/);
   assert.match(error.message,/evidence|unknowns/);return true;
  });
  assert.equal(notices.length,1);assert.doesNotMatch(notices[0],/secretPropertyFixture|fixture-secret/);
 }
});

test('compatible backend accounts reported overages before rejecting the result',async()=>{
 const recorded:unknown[]=[];
 const backend=openAICompatibleBackend({...credentials,onUsage:async value=>{recorded.push(value);},fetch:async()=>response(final,'stop',{prompt_tokens:60_000,completion_tokens:10,total_tokens:60_010})});
 await assert.rejects(backend.run(request,reader),(error:unknown)=>{
  assert.ok(error instanceof ResearchFailure);
  assert.match(error.message,/token budget/);
  assert.deepEqual(error.usage,{calls:1,tokens:60_010});
  return true;
 });
 assert.deepEqual(recorded,[{calls:1,tokens:'unknown'},{calls:1,tokens:60_010}]);
});

test('compatible backend leaves cumulative usage unknown when an overage cannot be represented safely',async()=>{
 const maxTokens=Number.MAX_SAFE_INTEGER;
 const recorded:unknown[]=[];
 const backend=openAICompatibleBackend({...credentials,onUsage:async value=>{recorded.push(value);},fetch:async()=>response(final,'stop',{total_tokens:maxTokens})});
 const bounded={...request,budget:{...request.budget,maxTokens},spent:{calls:0,tokens:maxTokens-50_000}};
 await assert.rejects(backend.run(bounded,reader),(error:unknown)=>{
  assert.ok(error instanceof ResearchFailure);
  assert.deepEqual(error.usage,{calls:1,tokens:'unknown'});
  return true;
 });
 assert.deepEqual(recorded,[{calls:1,tokens:'unknown'}]);
});

test('compatible backend fails closed on missing usage or failed dispatch',async()=>{
 for(const fetch of [
  async()=>response(final,'stop',null),
  async()=>response(final,'stop',{prompt_tokens:1,completion_tokens:1,total_tokens:1}),
  async()=>new Response('provider-sensitive-payload',{status:500}),
  async()=>{throw Error('provider-sensitive-payload');},
 ]){
  const recorded:unknown[]=[];
  const backend=openAICompatibleBackend({...credentials,onUsage:async value=>{recorded.push(value);},fetch});
  await assert.rejects(backend.run(request,reader),(error:unknown)=>{
   assert.ok(error instanceof ResearchFailure);
   assert.doesNotMatch(error.message,/provider-sensitive-payload/);
   assert.deepEqual(error.usage,{calls:1,tokens:'unknown'});
   return true;
  });
  assert.deepEqual(recorded,[{calls:1,tokens:'unknown'}]);
 }
});

test('compatible backend will not dispatch when the reservation fails',async()=>{
 let sent=false;
 const backend=openAICompatibleBackend({...credentials,onUsage:async()=>{throw Error('ledger persistence failed');},fetch:async()=>{sent=true;return response();}});
 await assert.rejects(backend.run(request,reader),/usage|budget/);
 assert.equal(sent,false);
});

test('compatible backend validates a tool batch before using the reader',async()=>{
 for(const invalid of [tool('other-id','exec','{"command":"touch marker"}'),tool('other-id','search','{"query":"x","command":"touch marker"}'),tool('other-id','search','private-provider-payload'),tool('list-id','search','{"query":"x"}')]){
  let reads=0;
  const toolCalls=[tool('list-id','list','{}'),invalid];
  const backend=openAICompatibleBackend({...credentials,fetch:async()=>response({role:'assistant',content:null,tool_calls:toolCalls},'tool_calls')});
  await assert.rejects(backend.run(request,{...reader,list:async()=>{reads++;return [];}}),(error:unknown)=>{
   assert.ok(error instanceof ResearchFailure);
   assert.doesNotMatch(error.message,/private-provider-payload|touch marker/);
   assert.deepEqual(error.usage,{calls:1,tokens:20});
   return true;
  });
  assert.equal(reads,0);
 }
});

test('compatible backend rejects unverifiable final evidence and suppresses raw stop reasons',async()=>{
 const citation={path:'config.yaml',startLine:1,endLine:1,digest:'fabricated'};
 const bad={role:'assistant',content:JSON.stringify({observations:[{supportingEvidence:[citation]}],unknowns:[]})};
 const source={...reader,read:async()=>({content:'config',evidence:{...citation,digest:'real'}})};
 await assert.rejects(openAICompatibleBackend({...credentials,fetch:async()=>response(bad)}).run(request,source),/evidence/);
 await assert.rejects(openAICompatibleBackend({...credentials,fetch:async()=>response(final,'provider-sensitive-payload')}).run(request,source),(error:unknown)=>{
  assert.ok(error instanceof ResearchFailure);
  assert.doesNotMatch(error.message,/provider-sensitive-payload/);
  return true;
 });
});

test('compatible backend rejects insecure base URLs and permits explicit loopback HTTP',async()=>{
 const urls:string[]=[];
 const fetch:typeof globalThis.fetch=async url=>{urls.push(String(url));return response();};
 for(const baseURL of ['https://name:fixture-password@example.test/v1','https://example.test/v1?key=fixture-password','https://example.test/v1#fixture-password','http://localhost.example.test/v1']){
  await assert.rejects(openAICompatibleBackend({...credentials,baseURL,fetch}).run(request,reader),(error:unknown)=>{
   assert.ok(error instanceof Error);
   assert.match(error.message,/base URL/);
   assert.doesNotMatch(error.message,/fixture-password|example.test/);
   return true;
  });
 }
 assert.equal(urls.length,0);
 assert.equal((await openAICompatibleBackend({...credentials,baseURL:'http://127.0.0.1:8080/custom-prefix',fetch}).run(request,reader)).status,'complete');
 assert.deepEqual(urls,['http://127.0.0.1:8080/custom-prefix/chat/completions']);
});
