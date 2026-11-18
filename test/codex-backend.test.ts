import {test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,readdir,mkdir,readFile,rm} from 'node:fs/promises';
import {delimiter,join} from 'node:path';
import {project,testEnvironment} from './helpers.js';
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

async function fakeCodexExecutable(cache:string,script:string){
 const bin=join(cache,'bin');
 await mkdir(bin);
 if(process.platform==='win32'){
  const pkg=join(bin,'node_modules','@openai','codex');
  await mkdir(join(pkg,'bin'),{recursive:true});
  await writeFile(join(pkg,'package.json'),JSON.stringify({name:'@openai/codex',version:'9.7.1',bin:{codex:'bin/codex.js'}}));
  await writeFile(join(pkg,'bin','codex.js'),script);
  await writeFile(join(bin,'codex.cmd'),'@echo off\r\nexit /b 91\r\n');
 }else await writeFile(join(bin,'codex'),'#!'+process.execPath+'\n'+script,{mode:0o755});
 return [bin,process.env.PATH].filter(Boolean).join(delimiter);
}

const codexFixture=[
 "const fs=require('node:fs'),args=process.argv.slice(2);",
 "if(args[0]==='--version'){console.log('codex-cli '+process.env.RIGUP_TEST_CODEX_VERSION);process.exit();}",
 "if(args[args.indexOf('--sandbox')+1]!=='read-only'||!args.includes('--ignore-user-config'))process.exit(92);",
 "process.stdin.resume();",
 "process.stdin.on('end',()=>{",
 " if(process.env.RIGUP_TEST_CODEX_WAIT==='yes')return setInterval(()=>{},500);",
 " fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify({observations:[],unknowns:[]}));",
 " console.log(JSON.stringify({type:'item.completed',item:{type:'context_compaction'}}));",
 " console.log(JSON.stringify({type:'turn.completed'}));",
 "});",
].join('\n');

test('runnable Codex records each actual version and accepts unknown events and usage',t=>fixture(async(_root,cache,request,reader)=>{
 const path=await fakeCodexExecutable(cache,codexFixture);
 testEnvironment(t,{PATH:path,RIGUP_TEST_CODEX_VERSION:'9.7.1',RIGUP_TEST_CODEX_WAIT:'no'});
 const messages:string[]=[];
 const backend=await createBackend({cacheRoot:cache,onDiagnostic:(message:string)=>messages.push(message)});
 const bounded={...request,budget:{...request.budget,maxCalls:1}};
 const first=await backend.run(bounded,reader);
 assert.equal(first.status,'complete');
 assert.match(first.value.model,/codex-cli 9\.7\.1/);
 assert.deepEqual(first.value.usage,{calls:1,tokens:'unknown'});
 process.env.RIGUP_TEST_CODEX_VERSION='9.7.2';
 const resumed=await backend.run(bounded,reader);
 assert.match(resumed.value.model,/codex-cli 9\.7\.1/);
 assert.equal(resumed.value.usage.calls,0);
 const later=await backend.run({...bounded,kind:'artifact-plan',expectedOutput:'plan'},reader);
 assert.match(later.value.model,/codex-cli 9\.7\.2/);
 assert.match(messages.join('\n'),/budget/i);
}));

test('Codex configured timeout and cancellation allow a new durable attempt',t=>fixture(async(_root,cache,request,reader)=>{
 const path=await fakeCodexExecutable(cache,codexFixture);
 testEnvironment(t,{PATH:path,RIGUP_CODEX_TIMEOUT_MS:'80',RIGUP_TEST_CODEX_WAIT:'yes',RIGUP_TEST_CODEX_VERSION:'0.166.0'});
 const first=await createBackend({cacheRoot:cache,signal:AbortSignal.timeout(4000)});
 await assert.rejects(first.run(request,reader),/response limit/);
 process.env.RIGUP_CODEX_TIMEOUT_MS='3000';
 const cancel=new AbortController();
 const interrupted=await createBackend({cacheRoot:cache,signal:cancel.signal,onDispatch:()=>setTimeout(()=>cancel.abort(),120)});
 await assert.rejects(interrupted.run(request,reader),/cancel/i);
 process.env.RIGUP_TEST_CODEX_WAIT='no';
 assert.equal((await (await createBackend({cacheRoot:cache})).run(request,reader)).status,'complete');
 const name=(await readdir(cache)).find(path=>path.endsWith('.usage.json'))!;
 const ledger=JSON.parse(await readFile(join(cache,name),'utf8'));
 assert.equal(Object.keys(ledger.attempts).length,3);
}));
async function legacyExchange(cache:string,request:ResearchRequest,reader:Awaited<ReturnType<typeof repositoryReader>>,attempts:{status:'reserved'|'observed';tokens:number|'unknown'}[],adapter='1'){
 const exchange=cache+'/ordinary/exchange'+(adapter==='1'?'':'/codex-'+adapter),context={...request,spent:undefined,versions:{...request.versions,codex:'0.166.0',codexAdapter:adapter}};
 const prior=await hostBackend({cacheRoot:exchange,omitDependencyLocks:adapter!=='1'}).run(context,reader);assert.equal(prior.status,'pending-host');if(prior.status!=='pending-host')throw Error('expected legacy export');
 await mkdir(cache+'/durable',{mode:0o700});const ledgerPath=cache+'/durable/'+signature({root:request.root,run:request.runId})+'.usage.json';
 const charged=Object.fromEntries(attempts.map((attempt,index)=>[index?signature({legacy:prior.requestId,index}):prior.requestId,attempt]));
 await writeFile(ledgerPath,JSON.stringify({attempts:charged}),{mode:0o600});
 const budgetPath=exchange+'/legacy.budget.json',budget=JSON.stringify({requests:[prior.requestId],tokens:'unknown'});
 await writeFile(budgetPath,budget);
 return {ledgerPath,charged,budgetPath,budget};
}
test('Codex adapter upgrade continues a known charged run without resetting consumption',async()=>{for(const adapter of ['1','2'])await fixture(async(_root,cache,request,reader)=>{
 const legacy=await legacyExchange(cache,request,reader,[{status:'observed',tokens:18}],adapter);let calls=0;const usage:any[]=[];
 const backend=await createBackend({cacheRoot:cache+'/ordinary',stateRoot:cache+'/durable',onUsage:async(u:any)=>{usage.push(u);},invoke:async(input:any)=>{calls++;assert.doesNotMatch(input.prompt,/LOCK_BODY_IN_CODEX_PROMPT/);return result();}});
 const next=await backend.run({...request,kind:'artifact-plan',expectedOutput:'plan',spent:{calls:1,tokens:18}},reader);
 assert.equal(next.status,'complete');assert.equal(calls,1);assert.deepEqual(usage.at(-1),{calls:2,tokens:36});
 const ledger=JSON.parse(await readFile(legacy.ledgerPath,'utf8'));for(const [id,attempt] of Object.entries(legacy.charged))assert.deepEqual(ledger.attempts[id],attempt);
 assert.equal(await readFile(legacy.budgetPath,'utf8'),legacy.budget,'old exchange bookkeeping remains intact');
});});
test('Codex adapter upgrade retains legacy charges and reports an advisory budget',async()=>{
 for(const attempts of [[{status:'reserved' as const,tokens:'unknown' as const}],[{status:'observed' as const,tokens:18},{status:'observed' as const,tokens:18},{status:'observed' as const,tokens:18}],[{status:'observed' as const,tokens:10000}]])await fixture(async(_root,cache,request,reader)=>{
  const legacy=await legacyExchange(cache,request,reader,attempts);let calls=0;
  const messages:string[]=[];
  const backend=await createBackend({cacheRoot:cache+'/ordinary',stateRoot:cache+'/durable',onDiagnostic:(message:string)=>messages.push(message),invoke:async()=>{calls++;return result();}});
  assert.equal((await backend.run({...request,kind:'artifact-plan',expectedOutput:'plan'},reader)).status,'complete');
  assert.equal(calls,1);assert.match(messages.join('\n'),/budget/);
  const ledger=JSON.parse(await readFile(legacy.ledgerPath,'utf8'));
  for(const [id,attempt] of Object.entries(legacy.charged))assert.deepEqual(ledger.attempts[id],attempt);
  assert.equal(await readFile(legacy.budgetPath,'utf8'),legacy.budget);
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
  const accepted=await backend.run(plan,reader);assert.equal(accepted.status,'complete');
  if(invalid)assert.match(accepted.value.unknowns.join('\n'),/independent support/i);
  else assert.deepEqual((accepted.value.data as {observations:typeof observation[]}).observations[0].coverage.independentSupports,2);
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
test('failed Codex attempts are recorded before dispatch and explicit retry starts a new one',()=>fixture(async(root,cache,request,reader)=>{
 let calls=0;const usage:any[]=[];const backend=await createBackend({cacheRoot:cache,onUsage:async(u:any)=>{usage.push(u);},invoke:async()=>{if(++calls===1)throw Error('private transport failure');return result();}});
 await assert.rejects(()=>backend.run(request,reader),/Codex|attempt/);assert.deepEqual(usage[0],{calls:1,tokens:'unknown'});
 assert.equal((await backend.run(request,reader)).status,'complete');
 assert.equal(calls,2);assert.deepEqual(usage.at(-1),{calls:2,tokens:'unknown'});
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
test('Codex warns before dispatch when the configured alert threshold is exceeded',()=>fixture(async(root,cache,request,reader)=>{
 const warnings:string[]=[];let calls=0;const settings={cacheRoot:cache,onDiagnostic:(text:string)=>warnings.push(text),invoke:async()=>{calls++;return result();}};
 const bounded={...request,budget:{maxCalls:3,maxTokens:1000}};
 const backend=await createBackend(settings);
 assert.equal((await backend.run(bounded,reader)).status,'complete');
 assert.equal(calls,1);assert.match(warnings.join('\n'),/budget/);
 assert.equal((await (await createBackend({...settings,tokenLimit:10000})).run(bounded,reader)).status,'complete');
 assert.equal(calls,1);
}));
test('observed Codex token overrun is charged and recovered without a repeated call',()=>fixture(async(root,cache,request,reader)=>{
 const usage:any[]=[],warnings:string[]=[];let calls=0;const settings={cacheRoot:cache,onDiagnostic:(text:string)=>warnings.push(text),onUsage:async(u:any)=>{usage.push(u);},invoke:async()=>{calls++;return {code:0,lastMessage:JSON.stringify(data),stdout:JSON.stringify({type:'turn.completed',usage:{input_tokens:10000,output_tokens:1}})};}};
 const backend=await createBackend(settings);
 assert.equal((await backend.run(request,reader)).status,'complete');assert.deepEqual(usage.at(-1),{calls:1,tokens:10001});
 assert.match(warnings.join('\n'),/budget/);
 assert.ok((await readdir(cache+'/exchange',{recursive:true})).some(p=>p.endsWith('.accepted.json')));
 const recovered=await (await createBackend({...settings,tokenLimit:20000})).run({...request,spent:{calls:1,tokens:10001}},reader);
 assert.equal(recovered.status,'complete');assert.equal(calls,1);
}));
test('explicit retry after cache deletion uses a new attempt and retains the prior charge',()=>fixture(async(root,cache,request,reader)=>{
 let calls=0;const settings={cacheRoot:cache+'/ordinary',stateRoot:cache+'/durable',invoke:async()=>{if(++calls===1)throw Error('transport lost');return result();}};
 await assert.rejects(()=>(createBackend(settings)).then(b=>b.run(request,reader)));
 await rm(cache+'/ordinary',{recursive:true});
 assert.equal((await (await createBackend(settings)).run(request,reader)).status,'complete');assert.equal(calls,2);
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
test('Codex rejects tool events and accepts valid evidence with unknown usage',()=>fixture(async(root,cache,request,reader)=>{
 const tool=await createBackend({cacheRoot:cache+'/tool',invoke:async()=>result(data,[{type:'item.completed',item:{type:'command_execution',command:'unexpected'}}])});
 await assert.rejects(()=>tool.run(request,reader),/tool|Codex/);
 const unknown=await createBackend({cacheRoot:cache+'/unknown',invoke:async()=>({code:0,lastMessage:JSON.stringify(data),stdout:''})});
 assert.deepEqual((await unknown.run(request,reader)).value.usage,{calls:1,tokens:'unknown'});
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
 assert.equal(calls,0);
}));
test('missing local Codex reports unavailable without asking for an unrelated API key',()=>fixture(async(root,cache,request,reader)=>{
 const prior=process.env.PATH;process.env.PATH='/private/tmp/rigup-no-codex-binary';try{const backend=await createBackend({cacheRoot:cache});await assert.rejects(()=>backend.run(request,reader),/Codex.*(available|installed|unavailable)/);}finally{process.env.PATH=prior;}
}));
test('Codex never starts if its durable process ID cannot be recorded',()=>project(async control=>{
 const {invokeCodex}=await import('../src/analyzer/codex-process.js');
 const bin=join(control,'bin'),root=join(control,'workspace'),launched=join(control,'launched');
 await mkdir(bin);await mkdir(root);
 const script='require("node:fs").writeFileSync('+JSON.stringify(launched)+',"started");setInterval(()=>{},1000);';
 if(process.platform==='win32'){
  const pkg=join(bin,'node_modules','@openai','codex');
  await mkdir(join(pkg,'bin'),{recursive:true});
  await writeFile(join(pkg,'package.json'),JSON.stringify({name:'@openai/codex',version:'0.166.0',bin:{codex:'bin/codex.js'}}));
  await writeFile(join(pkg,'bin','codex.js'),script);
  await writeFile(join(bin,'codex.cmd'),'@echo off\r\nexit /b 91\r\n');
 }else await writeFile(join(bin,'codex'),'#!'+process.execPath+'\n'+script,{mode:0o755});
 const old=process.env.PATH;process.env.PATH=[bin,old].filter(Boolean).join(delimiter);
 let pid:number|undefined;
 try{
  await assert.rejects(()=>invokeCodex({cwd:root,args:[],prompt:'must not be delivered',output:join(control,'output'),onStart:async identity=>{
   pid=identity.pid;throw Error('durable identity failed');
  }}),/durable identity failed/);
  assert.ok(pid);
  assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
  await assert.rejects(readFile(launched),{code:'ENOENT'});
 }finally{if(old===undefined)delete process.env.PATH;else process.env.PATH=old;}
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

test('harness exports confirmed authority and scope in the actual Codex request',()=>fixture(async(root,cache,request)=>{
 const {confirmedHarnessSource}=await import('./helpers.js');
 const options={agents:['codex' as const],backend:'codex' as const,projectRules:true};
 const authority=await confirmedHarnessSource(root,options);
 const backend=await createBackend({cacheRoot:cache,invoke:async(input:any)=>{
  const payload=JSON.parse(input.prompt.slice(input.prompt.indexOf('{')));
  assert.deepEqual(payload.context.sourceGuidance,authority.sourceGuidance);
  assert.ok(payload.evidence.some((item:any)=>item.evidence.path===authority.path&&item.content.includes(authority.body)));
  assert.ok(payload.evidence.every((item:any)=>!item.content.includes('status: confirmed')));
  return result({observations:[],unknowns:[],guidance:authority.sourceGuidance});
 }});
 assert.equal((await backend.run({...request,options,fingerprint:authority.profile.fingerprint,sourceGuidance:authority.sourceGuidance},authority.reader)).status,'complete');
}));
