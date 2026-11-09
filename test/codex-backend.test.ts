import {test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,readdir,mkdir,readFile,rm} from 'node:fs/promises';
import {delimiter,join} from 'node:path';
import {project} from './helpers.js';
import {scanRepository,repositoryReader} from '../src/analyzer/repository.js';
import {loadOptions} from '../src/config.js';
import type {ResearchRequest} from '../src/analyzer/backend.js';
import {hostBackend} from '../src/analyzer/host.js';
import {STAGE_EVIDENCE_POLICY} from '../src/analyzer/stage-context.js';
import {signature} from '../src/generator/cache.js';
async function fixture(fn:(root:string,cache:string,request:ResearchRequest,reader:Awaited<ReturnType<typeof repositoryReader>>)=>Promise<void>){await project(async root=>project(async cache=>{
 await writeFile(root+'/source.js','export function createOrder(id) { return {id}; }\n');
 await writeFile(root+'/config.yaml','auth:\n  password: should-never-leave\n');
 await writeFile(root+'/yarn.lock','LOCK_BODY_IN_CODEX_PROMPT must not be repeated\n');
 const options={agents:['codex' as const],backend:'codex' as const};
 const profile=await scanRepository(root,options);
 const request:ResearchRequest={kind:'analyze',runId:'fixture-codex',root,fingerprint:profile.fingerprint,options,versions:{prompt:'4',read:'4'},budget:{maxCalls:3,maxTokens:10000},previousInventoryDigest:'none',templateSourcesDigest:'none'};
 await fn(root,cache,request,await repositoryReader(root,options));
}));}
async function createBackend(options:any){return (await import('../src/analyzer/codex.js')).codexBackend(options);}
const data={observations:[],unknowns:[]};
const result=(body:unknown=data,extra:unknown[]=[])=>({code:0,lastMessage:JSON.stringify(body),stdout:[...extra,{type:'turn.completed',usage:{input_tokens:11,output_tokens:7,cached_input_tokens:3}}].map(v=>JSON.stringify(v)).join('\n')});
async function legacyExchange(cache:string,request:ResearchRequest,reader:Awaited<ReturnType<typeof repositoryReader>>,attempts:{status:'reserved'|'observed';tokens:number|'unknown'}[],adapter='1'){
 const exchange=cache+'/ordinary/exchange'+(adapter==='1'?'':'/codex-'+adapter),context={...request,spent:undefined,versions:{...request.versions,codex:'0.166.0',codexAdapter:adapter}};
 const prior=await hostBackend({cacheRoot:exchange,omitDependencyLocks:adapter!=='1'}).run(context,reader);assert.equal(prior.status,'pending-host');if(prior.status!=='pending-host')throw Error('expected legacy export');
 await mkdir(cache+'/durable',{mode:0o700});const ledgerPath=cache+'/durable/'+signature({root:request.root,run:request.runId})+'.usage.json';
 const charged=Object.fromEntries(attempts.map((attempt,index)=>[index?signature({legacy:prior.requestId,index}):prior.requestId,attempt]));
 await writeFile(ledgerPath,JSON.stringify({attempts:charged}),{mode:0o600});
 const budgetPath=exchange+'/'+(await readdir(exchange)).find(p=>p.endsWith('.budget.json'));
 return {ledgerPath,charged,budgetPath,budget:await readFile(budgetPath,'utf8')};
}
test('Codex adapter upgrade continues a known charged run without resetting consumption',async()=>{for(const adapter of ['1','2'])await fixture(async(_root,cache,request,reader)=>{
 const legacy=await legacyExchange(cache,request,reader,[{status:'observed',tokens:18}],adapter);let calls=0;const usage:any[]=[];
 const backend=await createBackend({cacheRoot:cache+'/ordinary',stateRoot:cache+'/durable',onUsage:async(u:any)=>{usage.push(u);},invoke:async(input:any)=>{calls++;assert.doesNotMatch(input.prompt,/LOCK_BODY_IN_CODEX_PROMPT/);return result();}});
 const next=await backend.run({...request,kind:'artifact-plan',expectedOutput:'plan',spent:{calls:1,tokens:18}},reader);
 assert.equal(next.status,'complete');assert.equal(calls,1);assert.deepEqual(usage.at(-1),{calls:2,tokens:36});
 const ledger=JSON.parse(await readFile(legacy.ledgerPath,'utf8'));for(const [id,attempt] of Object.entries(legacy.charged))assert.deepEqual(ledger.attempts[id],attempt);
 assert.equal(await readFile(legacy.budgetPath,'utf8'),legacy.budget,'old exchange bookkeeping remains intact');
});});
test('Codex adapter upgrade retains unknown and exhausted legacy charges before dispatch',async()=>{
 for(const attempts of [[{status:'reserved' as const,tokens:'unknown' as const}],[{status:'observed' as const,tokens:18},{status:'observed' as const,tokens:18},{status:'observed' as const,tokens:18}],[{status:'observed' as const,tokens:10000}]])await fixture(async(_root,cache,request,reader)=>{
  const legacy=await legacyExchange(cache,request,reader,attempts),before=await readFile(legacy.ledgerPath,'utf8');let calls=0;
  const backend=await createBackend({cacheRoot:cache+'/ordinary',stateRoot:cache+'/durable',invoke:async()=>{calls++;return result();}});
  await assert.rejects(()=>backend.run({...request,kind:'artifact-plan',expectedOutput:'plan'},reader),/budget|unknown|accounting/i);assert.equal(calls,0);
  assert.equal(await readFile(legacy.ledgerPath,'utf8'),before);assert.equal(await readFile(legacy.budgetPath,'utf8'),legacy.budget);
 });
});
test('fresh mainline selects local Codex without a provider API key',()=>project(async root=>{
 const selected=await loadOptions(root,{});assert.equal(selected.backend,'codex');assert.deepEqual(selected.agents,['codex']);assert.equal(selected.model,undefined);
}));
test('Codex receives only filtered evidence in a private cwd and cached acceptance costs no new call',()=>fixture(async(root,cache,request,reader)=>{
 let calls=0;const usage:any[]=[];
 const backend=await createBackend({cacheRoot:cache,onUsage:async(u:any)=>{usage.push(u);},invoke:async(input:any)=>{
  calls++;assert.ok(!input.cwd.startsWith(root+'/'));assert.notEqual(input.cwd,root);assert.deepEqual(await readdir(input.cwd),[]);
  assert.doesNotMatch(input.prompt,/should-never-leave/);assert.match(input.prompt,/createOrder/);
  assert.doesNotMatch(input.prompt,/LOCK_BODY_IN_CODEX_PROMPT/);assert.match(input.prompt,/omittedEvidence/);
  for(const feature of ['shell_tool','unified_exec','apps','multi_agent','browser_use'])assert.ok(input.args.some((v:string,i:number)=>v==='--disable'&&input.args[i+1]===feature));
  assert.ok(input.args.includes('--ignore-user-config'));assert.ok(!input.args.includes('--model'));
  return result();
 }});
 const first=await backend.run(request,reader);assert.equal(first.status,'complete');if(first.status==='complete')assert.deepEqual(first.value.usage,{calls:1,tokens:18});
 assert.deepEqual(usage[0],{calls:1,tokens:'unknown'});assert.deepEqual(usage.at(-1),{calls:1,tokens:18});
 const reused=await backend.run(request,reader);assert.equal(reused.status,'complete');if(reused.status==='complete')assert.deepEqual(reused.value.usage,{calls:0,tokens:0});assert.equal(calls,1);
}));
test('Codex planning prompt uses stage-selected evidence instead of repeating the source scan',()=>fixture(async(_root,cache,request,reader)=>{
 const prompts:string[]=[];const backend=await createBackend({cacheRoot:cache,invoke:async(input:any)=>{prompts.push(input.prompt);return result();}});
 await backend.run(request,reader);await backend.run({...request,kind:'artifact-plan',expectedOutput:'plan',input:{profile:{files:await reader.list(),research:{data:{observations:[],guidance:[],unknowns:[]}}},previousInventory:[]}},reader);assert.equal(prompts.length,2);
 assert.match(prompts[0],/createOrder/);assert.doesNotMatch(prompts[1],/export function createOrder/);const body=JSON.parse(prompts[1].slice(prompts[1].indexOf('{')));
 assert.equal(body.context.evidencePolicy,STAGE_EVIDENCE_POLICY);assert.ok(body.paths.includes('source.js'));assert.equal(body.evidence.length,0);assert.equal(body.context.input.profile.files,undefined);
}));
test('Codex counts named convention supports only when each path is independently cited',()=>fixture(async(root,cache,request)=>{
 await writeFile(root+'/alternate.js','export function createInvoice(id) { return {id}; }\n');
 const reader=await repositoryReader(root,request.options as Awaited<ReturnType<typeof loadOptions>>);
 const evidence=await Promise.all(['source.js','alternate.js'].map(async path=>(await reader.read(path,1)).evidence));
 const observation={classification:'convention',statement:'Return the input identifier.',scope:['.'],supportingEvidence:evidence,counterEvidence:[],coverage:{independentSupports:evidence.map(e=>e.path),counterexampleSearched:true,counterexampleQueries:['export function create']}};
 const plan={...request,kind:'artifact-plan' as const,expectedOutput:'plan' as const};
 for(const invalid of [false,true]){
  const candidate=structuredClone(observation);if(invalid)candidate.coverage.independentSupports[1]='uncited.js';
  const backend=await createBackend({cacheRoot:cache+'/'+invalid,invoke:async()=>result({observations:[candidate],unknowns:[]})});
  if(invalid)await assert.rejects(()=>backend.run(plan,reader),/invalid evidence/);
  else{
   const accepted=await backend.run(plan,reader);assert.equal(accepted.status,'complete');
   assert.deepEqual((accepted.value.data as {observations:typeof observation[]}).observations[0].coverage.independentSupports,2);
  }
 }
}));
test('Codex rulebook output keeps only the candidate and its unknowns without replaying planning evidence',()=>fixture(async(_root,cache,request,reader)=>{
 const rulebook={title:'Scoped conventions',rules:[]};
 const payload={rulebook,unknowns:['Scope checked'],observations:[{supportingEvidence:[{path:'unused.ts',startLine:1,endLine:1,digest:'uncited'}]}]};
 const backend=await createBackend({cacheRoot:cache,invoke:async()=>result(payload)});
 const job={logicalId:'project-development-rules',target:'docs/rigup/development-rules.md',ruleSources:[],sourceRefs:[]};
 const content={...request,kind:'artifact-content' as const,expectedOutput:'content' as const,artifact:job.logicalId,input:{job}};
 for(let i=0;i<2;i++){
  const value=await backend.run(content,reader);assert.equal(value.status,'complete');
  assert.deepEqual(value.value.data,{rulebook,unknowns:['Scope checked'],observations:[]});
  assert.equal(value.value.usage.calls,i===0?1:0);
 }
}));
test('failed Codex attempts are charged before dispatch and never silently repeated',()=>fixture(async(root,cache,request,reader)=>{
 let calls=0;const usage:any[]=[];const backend=await createBackend({cacheRoot:cache,onUsage:async(u:any)=>{usage.push(u);},invoke:async()=>{calls++;throw Error('private transport failure');}});
 await assert.rejects(()=>backend.run(request,reader),/Codex|attempt/);assert.deepEqual(usage[0],{calls:1,tokens:'unknown'});
 await assert.rejects(()=>backend.run(request,reader),/unresolved|attempt|reconcile/);assert.equal(calls,1);
 await assert.rejects(()=>backend.run({...request,kind:'artifact-plan',expectedOutput:'plan'},reader),/budget|unknown/);assert.equal(calls,1);
}));
test('corrupt Codex usage ledger cannot reset an already charged budget',()=>fixture(async(root,cache,request,reader)=>{
 const backend=await createBackend({cacheRoot:cache,invoke:async()=>result()});await backend.run(request,reader);
 const ledger=(await readdir(cache)).find(p=>p.endsWith('.usage.json'))!;await writeFile(cache+'/'+ledger,'{broken',{mode:0o600});
 await assert.rejects(()=>backend.run(request,reader),/ledger|corrupt|usage/i);
}));
test('missing durable Codex budget cannot erase known spent usage',()=>fixture(async(root,cache,request,reader)=>{
 const backend=await createBackend({cacheRoot:cache,invoke:async()=>result()});await backend.run(request,reader);
 await rm(cache+'/'+(await readdir(cache)).find(p=>p.endsWith('.usage.json')));
 await assert.rejects(()=>backend.run({...request,spent:{calls:1,tokens:18}},reader),/budget|ledger/i);
}));
test('Codex stops an oversized request before dispatch and resumes with the approved new token limit',()=>fixture(async(root,cache,request,reader)=>{
 const usage:any[]=[];let calls=0;const settings={cacheRoot:cache,onUsage:async(u:any)=>{usage.push(u);},invoke:async()=>{calls++;return result();}};
 const bounded={...request,budget:{maxCalls:3,maxTokens:1000}};
 const backend=await createBackend(settings);
 await assert.rejects(()=>backend.run(bounded,reader),/estimated.*remaining.*1000/i);
 assert.equal(calls,0);assert.deepEqual(usage,[]);
 assert.equal((await (await createBackend({...settings,tokenLimit:10000})).run(bounded,reader)).status,'complete');
 assert.equal(calls,1);
}));
test('observed Codex token overrun is charged and recovered without a repeated call',()=>fixture(async(root,cache,request,reader)=>{
 const usage:any[]=[];let calls=0;const settings={cacheRoot:cache,onUsage:async(u:any)=>{usage.push(u);},invoke:async()=>{calls++;return {code:0,lastMessage:JSON.stringify(data),stdout:JSON.stringify({type:'turn.completed',usage:{input_tokens:10000,output_tokens:1}})};}};
 const backend=await createBackend(settings);
 await assert.rejects(()=>backend.run(request,reader),/observed.*10001.*10000/i);assert.deepEqual(usage.at(-1),{calls:1,tokens:10001});
 assert.ok(!(await readdir(cache+'/exchange',{recursive:true})).some(p=>p.endsWith('.accepted.json')));
 const recovered=await (await createBackend({...settings,tokenLimit:20000})).run({...request,spent:{calls:1,tokens:10001}},reader);
 assert.equal(recovered.status,'complete');assert.equal(calls,1);
}));
test('ordinary cache deletion does not authorize repeating an unresolved Codex request',()=>fixture(async(root,cache,request,reader)=>{
 let calls=0;const settings={cacheRoot:cache+'/ordinary',stateRoot:cache+'/durable',invoke:async()=>{calls++;throw Error('transport lost');}};
 await assert.rejects(()=>(createBackend(settings)).then(b=>b.run(request,reader)));
 await rm(cache+'/ordinary',{recursive:true});
 await assert.rejects(()=>(createBackend(settings)).then(b=>b.run(request,reader)),/Unresolved|reconcile/);assert.equal(calls,1);
}));
test('completed durable Codex result survives cache loss without another charge',()=>fixture(async(root,cache,request,reader)=>{
 let calls=0;const settings={cacheRoot:cache+'/ordinary',stateRoot:cache+'/durable',invoke:async()=>{calls++;return result();}};
 await (await createBackend(settings)).run(request,reader);await rm(cache+'/ordinary',{recursive:true});
 const recovered=await (await createBackend(settings)).run({...request,spent:{calls:1,tokens:'unknown'}},reader);
 assert.equal(recovered.status,'complete');if(recovered.status==='complete')assert.deepEqual(recovered.value.usage,{calls:0,tokens:0});assert.equal(calls,1);
}));
test('verified durable Codex accounting supersedes stale unknown consumer totals',()=>fixture(async(root,cache,request,reader)=>{
 let calls=0;const backend=await createBackend({cacheRoot:cache,invoke:async()=>{calls++;return result();}});await backend.run(request,reader);
 const next=await backend.run({...request,kind:'artifact-plan',expectedOutput:'plan',input:{phase:'next'},spent:{calls:1,tokens:'unknown'}},reader);
 assert.equal(next.status,'complete');assert.equal(calls,2);
}));
test('Codex output with fabricated evidence never becomes accepted research',()=>fixture(async(root,cache,request,reader)=>{
 const invalid={observations:[{statement:'Invented',classification:'explicit-rule',scope:['source.js'],supportingEvidence:[{path:'source.js',startLine:1,endLine:1,digest:'sha256:invented'}],counterEvidence:[],guidanceDisposition:'follow-existing'}],unknowns:[]};
 const backend=await createBackend({cacheRoot:cache,invoke:async()=>result(invalid)});await assert.rejects(()=>backend.run(request,reader),/evidence|Codex/);
 assert.ok(!(await readdir(cache+'/exchange',{recursive:true})).some(p=>p.endsWith('.accepted.json')));
}));
test('Codex tool events and missing usage fail instead of claiming a safe accepted result',()=>fixture(async(root,cache,request,reader)=>{
 const tool=await createBackend({cacheRoot:cache+'/tool',invoke:async()=>result(data,[{type:'item.completed',item:{type:'command_execution',command:'unexpected'}}])});
 await assert.rejects(()=>tool.run(request,reader),/tool|Codex/);
 const unknown=await createBackend({cacheRoot:cache+'/unknown',invoke:async()=>({code:0,lastMessage:JSON.stringify(data),stdout:''})});await assert.rejects(()=>unknown.run(request,reader),/usage|Codex/);
}));
test('Codex feature-discovery startup warning is not mistaken for a tool call',()=>fixture(async(root,cache,request,reader)=>{
 const backend=await createBackend({cacheRoot:cache,invoke:async()=>result(data,[{type:'item.completed',item:{type:'error',message:'Under-development features enabled: skip_host_skill_discovery. Under-development features are incomplete and may behave unpredictably.'}}])});
 assert.equal((await backend.run(request,reader)).status,'complete');
}));
test('Codex HTTPS fallback notice preserves a completed response and its usage',()=>fixture(async(_root,cache,request,reader)=>{
 const backend=await createBackend({cacheRoot:cache,invoke:async()=>result(data,[
  {type:'item.completed',item:{type:'error',message:'Falling back from WebSockets to HTTPS transport. stream disconnected before completion: tls handshake eof'}}
 ])});
 const response=await backend.run(request,reader);
 assert.equal(response.status,'complete');
 assert.deepEqual(response.value.usage,{calls:1,tokens:18});
}));
test('remaining Codex budget and cancellation are checked before invoking the model',()=>fixture(async(root,cache,request,reader)=>{
 let calls=0;const signal=new AbortController();signal.abort();
 const backend=await createBackend({cacheRoot:cache,signal:signal.signal,invoke:async()=>{calls++;return result();}});await assert.rejects(()=>backend.run(request,reader),/cancel|abort/i);
 const bounded=await createBackend({cacheRoot:cache,invoke:async()=>{calls++;return result();}});await assert.rejects(()=>bounded.run({...request,spent:{calls:3,tokens:0}},reader),/budget/);assert.equal(calls,0);
}));
test('missing local Codex reports unavailable without asking for an unrelated API key',()=>fixture(async(root,cache,request,reader)=>{
 const prior=process.env.PATH;process.env.PATH='/private/tmp/rigup-no-codex-binary';try{const backend=await createBackend({cacheRoot:cache});await assert.rejects(()=>backend.run(request,reader),/Codex.*(available|installed|unavailable)/);}finally{process.env.PATH=prior;}
}));
test('Codex process is stopped if its durable process identity cannot be recorded',()=>project(async control=>{
 const {invokeCodex}=await import('../src/analyzer/codex-process.js');await mkdir(control+'/bin');await mkdir(control+'/workspace');
 if(process.platform==='win32'){
  const {windowsJobActive}=await import('../src/integrations/tools/windows-process.mjs');
  const bin=join(control,'bin'),pkg=join(bin,'node_modules','@openai','codex'),launched=join(control,'launched');
  await mkdir(join(pkg,'bin'),{recursive:true});
  await writeFile(join(pkg,'package.json'),JSON.stringify({name:'@openai/codex',version:'0.166.0',bin:{codex:'bin/codex.js'}}));
  await writeFile(join(pkg,'bin','codex.js'),`require('node:fs').writeFileSync(${JSON.stringify(launched)},'started');setInterval(()=>{},1000);`);
  await writeFile(join(bin,'codex.cmd'),'@echo off\r\nexit /b 91\r\n');
  const old=process.env.PATH;process.env.PATH=[bin,old].filter(Boolean).join(delimiter);
  let job:string|undefined;
  try{
   await assert.rejects(()=>invokeCodex({cwd:join(control,'workspace'),args:[],prompt:'must not be delivered',output:join(control,'output'),onStart:async identity=>{
    job=identity.windowsJob;throw Error('durable identity failed');
   }}),/durable identity failed/);
   assert.ok(job);
   assert.equal(await windowsJobActive(job),false);
   await assert.rejects(readFile(launched),{code:'ENOENT'});
  }finally{if(old===undefined)delete process.env.PATH;else process.env.PATH=old;}
  return;
 }
 await writeFile(control+'/bin/ps','#!/bin/sh\nexit 1\n',{mode:0o755});
 const release=join(control,'release');
 await writeFile(control+'/bin/codex','#!'+process.execPath+'\n'+
  `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(control+'/pid')},String(process.pid));process.stdin.resume();
  setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)}))process.exit(0);},25);setTimeout(()=>process.exit(0),5000);\n`,{mode:0o755});
 const old=process.env.PATH;process.env.PATH=control+'/bin:'+old;let pid:number|undefined;
 try{
  await assert.rejects(()=>invokeCodex({cwd:control+'/workspace',args:[],prompt:'must not be delivered',output:control+'/output',onStart:async()=>{}}));
  for(let i=0;i<50;i++){try{pid=Number(await readFile(control+'/pid','utf8'));break;}catch{await new Promise(done=>setTimeout(done,10));}}
  if(pid){await new Promise(done=>setTimeout(done,50));assert.throws(()=>process.kill(pid!,0),{code:'ESRCH'});}
 }finally{
  if(old===undefined)delete process.env.PATH;else process.env.PATH=old;
  await writeFile(release,'');
  for(let i=0;pid&&i<40;i++){
   try{process.kill(pid,0);}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')break;throw error;}
   await new Promise(done=>setTimeout(done,25));
  }
 }
}));

test('Codex recovery requires a well-formed saved outcome and its existing reservation',()=>fixture(async(_root,cache,request,reader)=>{
 let calls=0;
 const settings={cacheRoot:cache+'/ordinary',stateRoot:cache+'/durable',invoke:async()=>{calls++;return result();}};
 const backend=await createBackend(settings);
 await backend.run(request,reader);
 const files=await readdir(settings.stateRoot);
 const ledger=settings.stateRoot+'/'+files.find(path=>path.endsWith('.usage.json'))!;
 const outcome=settings.stateRoot+'/'+files.find(path=>path.endsWith('.outcome.json'))!;
 const previousLedger=await readFile(ledger,'utf8');
 const previousOutcome=await readFile(outcome,'utf8');

 const empty='{"attempts":{}}';
 await writeFile(ledger,empty);
 await assert.rejects(()=>backend.run(request,reader),/reconcil.*usage/i);
 await rm(settings.cacheRoot,{recursive:true});
 await assert.rejects(()=>backend.run(request,reader),/outcome.*reservation/i);
 assert.equal(await readFile(ledger,'utf8'),empty);

 await writeFile(ledger,previousLedger);
 const {lastMessage,...malformed}=JSON.parse(previousOutcome);
 await writeFile(outcome,JSON.stringify(malformed));
 await assert.rejects(()=>backend.run(request,reader),/outcome.*corrupt/i);
 assert.equal(await readFile(ledger,'utf8'),previousLedger);
 assert.equal(calls,1);
}));
