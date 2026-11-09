import {test} from 'node:test';
import {join} from 'node:path';import assert from 'node:assert/strict';
import {openspecFixturePath,project} from './helpers.js';import {mkdir,writeFile,readFile,readdir} from 'node:fs/promises';
import {runCli} from '../src/cli.js';
import {scanRepository} from '../src/analyzer/repository.js';
import {signature} from '../src/generator/cache.js';
import {absentDigest,preview} from '../src/installer/preview.js';
import {apply} from '../src/installer/apply.js';
import {loadContinuation} from '../src/lifecycle.js';
import {CodexTokenLimit} from '../src/analyzer/budget.js';
import {parse,stringify} from 'smol-toml';
async function fixture(fn:(root:string,cache:string,state:string)=>Promise<void>){await project(async root=>project(async cache=>project(async state=>fn(root,cache,state))));}
test('CLI budget handoff continues the same run with its saved selections and mode',()=>fixture(async(root,cache,state)=>{
 for(const name of ['openspec-propose','openspec-apply-change','openspec-archive-change']){
  const dir=root+'/.agents/skills/'+name;await mkdir(dir,{recursive:true});
  await writeFile(dir+'/SKILL.md','---\nname: '+name+'\ndescription: Native fixture\n---\n');
 }
 let output='';const ids:string[]=[];
 const io={cwd:root,isTTY:false,write:(s:string)=>output+=s,services:{cacheRoot:cache,stateRoot:state,backend:{run:async (request:import('../src/analyzer/backend.js').ResearchRequest)=>{
  ids.push(request.runId);assert.equal(request.budget.maxTokens,1_200_000);
  if(ids.length===1)throw new CodexTokenLimit(0,1000,5000);
  return {status:'complete' as const,value:{data:{observations:[],unknowns:[],artifacts:[],dispositions:[]},model:'fixture',unknowns:[],usage:{calls:1,tokens:1}}};
 }}}};
 const first=await runCli(['init','--agents','codex','--sdd','openspec','--dry-run','--research-tokens','1000','--json'],io);
 assert.equal(first,3);const pending=JSON.parse(output);
 assert.equal(pending.reason,'research-token-budget');assert.equal(pending.researchBudget.estimatedNextTokens,5000);
 const id=pending.nextCommand.match(/--continue ([a-f0-9]{64}) --research-tokens 1200000$/)[1];
 output='';assert.equal(await runCli(['update','--continue',id,'--research-tokens','1200000','--json'],io),0);
 assert.equal(new Set(ids).size,1);assert.equal(ids.length,3);assert.equal(JSON.parse(output).phase,'preview');
 await assert.rejects(readFile(root+'/.rigup/manifest.json'),{code:'ENOENT'});
}));
test('research continuation keeps its explicit limit and stops at an unrelated interrupted apply',()=>fixture(async(root,cache,state)=>{
 for(const name of ['openspec-propose','openspec-apply-change','openspec-archive-change']){
  const dir=root+'/.agents/skills/'+name;await mkdir(dir,{recursive:true});
  await writeFile(dir+'/SKILL.md','---\nname: '+name+'\ndescription: Native fixture\n---\n');
 }
 let output='';
 const io={cwd:root,isTTY:false,write:(s:string)=>output+=s,services:{cacheRoot:cache,stateRoot:state}};
 assert.equal(await runCli(['init','--agents','codex','--sdd','openspec','--review','--research-tokens','1','--json'],io),3,output);
 const id=JSON.parse(output).nextCommand.match(/--continue ([a-f0-9]{64})/)[1];
 const continuation=await loadContinuation(root,id,io.services);
 assert.equal(JSON.parse(await readFile(state+'/runs/'+id+'.json','utf8')).researchTokens,1);
 output='';assert.equal(await runCli(['update','--continue',id,'--json'],io),3);
 assert.equal(JSON.parse(output).researchBudget.limit,1);

 const options=continuation.options;
 const plan=await preview({root,options,fingerprint:(await scanRepository(root,options)).fingerprint,
  assets:[{logicalId:'fixture',target:'unrelated.md',content:'unrelated\n',ownership:{kind:'file'},source:{kind:'test',ref:'test'}}],
  operations:[],requirements:[],warnings:[],versions:{},dispositions:[]},[],{cacheRoot:cache+'/previews'});
 await assert.rejects(()=>apply(plan.previewId,{cacheRoot:cache+'/previews',stateRoot:state,hook:async()=>{throw Error('interrupted');}}),/interrupted/);
 output='';assert.equal(await runCli(['update','--continue',id,'--research-tokens','1200000','--resume','--json'],io),3);
 const blocked=JSON.parse(output);
 assert.equal(blocked.reason,'interrupted-install');
 assert.equal(blocked.interruptedPreviewId,plan.previewId);
 await assert.rejects(readFile(root+'/.rigup/manifest.json'),{code:'ENOENT'});
}));
test('configured_automation_runs_without_yes_or_no_prompt_switches_and_json_is_one_object',()=>fixture(async(root,cache,state)=>{
 await mkdir(root+'/.rigup');await writeFile(root+'/.rigup/config.yaml','agents: [codex]\nbackend: host\nmcp:\n  - id: docs\n    agents: [codex]\n    url: https://example.org/mcp\n');let stdout='',stderr='',reads=0;
 const code=await runCli(['init','--json'],{cwd:root,isTTY:true,write:s=>stdout+=s,writeError:s=>stderr+=s,read:async()=>{reads++;throw Error('JSON must not read stdin');},services:{cacheRoot:cache,stateRoot:state}});assert.equal(code,0);assert.equal(reads,0);const report=JSON.parse(stdout);assert.equal(report.installStatus,'complete');assert.equal(report.phase,'apply');assert.match(stderr,/Generate/);assert.ok((await readdir(root+'/.codex')).includes('config.toml'));
}));
test('required_missing_credentials_are_pending_before_research_not_placeholder_success',()=>fixture(async(root,cache,state)=>{
 let out='',calls=0;const code=await runCli(['init','--agents','codex','--sdd','openspec','--backend','native','--json'],{cwd:root,isTTY:false,write:s=>out+=s,services:{cacheRoot:cache,stateRoot:state}});assert.equal(code,3);const report=JSON.parse(out);assert.ok(report.requiredInput.length);assert.deepEqual(await readdir(root),[]);
}));
test('deterministic_only_setup_does_not_require_model_credentials',()=>fixture(async(root,cache,state)=>{
 let out='';const code=await runCli(['init','--agents','codex','--json'],{cwd:root,isTTY:false,write:s=>out+=s,services:{cacheRoot:cache,stateRoot:state,backend:{run:async()=>{throw Error('no backend call');}}}});assert.equal(code,0);assert.equal(JSON.parse(out).installStatus,'complete');assert.ok((await readdir(root+'/.rigup')).includes('manifest.json'));
}));
test('explicit_host_request_stays_private_and_response_may_be_an_explicit_external_file',()=>fixture(async(root,cache,state)=>{
 const requestPath=join(cache,'host','custom.request.json');let out='';const io={cwd:root,isTTY:false,write:(s:string)=>out+=s,services:{cacheRoot:cache,stateRoot:state}};
 assert.equal(await runCli(['init','--agents','codex','--sdd','openspec','--backend','host','--request',requestPath,'--json'],io),3);const report=JSON.parse(out);assert.equal(report.requestPath,requestPath);const exported=JSON.parse(await readFile(requestPath,'utf8'));const response=state+'/external.response.json';await writeFile(response,JSON.stringify({requestId:exported.requestId,requestDigest:exported.requestDigest,model:'fixture',data:{observations:[],unknowns:[],guidance:[]}}));const continuation=report.nextCommand.match(/--continue ([a-f0-9]{64})/)![1];out='';assert.equal(await runCli(['update','--continue',continuation,'--response',response,'--json'],io),3);assert.equal(JSON.parse(out).phase,'generation');assert.deepEqual(await readdir(root),[]);
}));
test('configure_persists_only_explicit_settings_and_following_update_reuses_them',()=>fixture(async(root,cache,state)=>{
 let output='';const io={cwd:root,isTTY:false,write:(s:string)=>output+=s,services:{cacheRoot:cache,stateRoot:state,backend:{run:async()=>{throw Error('deterministic setup');}}}};
 assert.equal(await runCli(['init','--agents','codex','--backend','host','--configure','--json'],io),0);assert.match(await readFile(root+'/.rigup/config.yaml','utf8'),/codex/);output='';assert.equal(await runCli(['update','--json'],io),0);assert.equal(JSON.parse(output).written.length,0);
}));
test('request_export_rejects_project_paths_as_input_error_without_writes',()=>fixture(async(root,cache,state)=>{
 let output='';const code=await runCli(['init','--agents','codex','--sdd','openspec','--backend','host','--request',root+'/request.json','--json'],{cwd:root,isTTY:false,write:s=>output+=s,services:{cacheRoot:cache,stateRoot:state}});assert.equal(code,2);assert.deepEqual(await readdir(root),[]);
}));
test('replaying_an_already_accepted_host_response_advances_the_same_run',()=>fixture(async(root,cache,state)=>{
 let output='';const io={cwd:root,isTTY:false,write:(s:string)=>output+=s,services:{cacheRoot:cache,stateRoot:state}};await runCli(['init','--agents','codex','--sdd','openspec','--backend','host','--json'],io);const first=JSON.parse(output);const exported=JSON.parse(await readFile(first.requestPath,'utf8'));const response=state+'/response.json';await writeFile(response,JSON.stringify({requestId:exported.requestId,requestDigest:exported.requestDigest,model:'fixture',data:{observations:[],unknowns:[]}}));const id=first.nextCommand.match(/--continue ([a-f0-9]{64})/)[1];
 for(let i=0;i<2;i++){output='';assert.equal(await runCli(['update','--continue',id,'--response',response,'--json'],io),3);assert.equal(JSON.parse(output).phase,'generation');}
}));
test('onboarding_collects_all_choices_before_first_backend_request_and_masks_key',()=>fixture(async(root,cache,state)=>{
 const events:string[]=[];const answers=['2','1','3','2','zh-CN','1','1','fixture-model','','temporary-secret'];let secret=false;const native=['superpowers:brainstorming','superpowers:writing-plans','superpowers:executing-plans','superpowers:verification-before-completion'];for(const name of native){const dir=join(root,'.agents','skills',name.split(':').at(-1)!);await mkdir(dir,{recursive:true});await writeFile(dir+'/SKILL.md','---\nname: '+name+'\ndescription: fixture\n---\nNative gates\n');}
 const keys=['ANTHROPIC_API_KEY','OPENAI_API_KEY','RIGUP_PROVIDER','HOME','USERPROFILE'];
 const saved=keys.map(key=>process.env[key]);for(const key of keys)delete process.env[key];
 process.env.HOME=cache;process.env.USERPROFILE=cache;
 try{
  let output='';const code=await runCli(['init'],{cwd:root,isTTY:true,write:s=>output+=s,read:async hidden=>{events.push('prompt');secret||=!!hidden;return answers.shift()??null;},services:{cacheRoot:cache,stateRoot:state,backend:{run:async r=>{events.push('backend');assert.equal(r.effectiveModel?.model,'fixture-model');return {status:'complete',value:{data:{observations:[],unknowns:[],artifacts:[],dispositions:[]},model:'fixture-model',unknowns:[],usage:{calls:1,tokens:1}}};}}}});
  assert.equal(code,0,output);assert.equal(secret,true);assert.doesNotMatch(output,/temporary-secret/);const first=events.indexOf('backend');assert.ok(first>0);assert.ok(!events.slice(first).includes('prompt'));
 }finally{keys.forEach((key,index)=>{if(saved[index]===undefined)delete process.env[key];else process.env[key]=saved[index];});}
}));
test('technical_continuation_cannot_silently_change_execution_mode',()=>fixture(async(root,cache,state)=>{
 let output='';const io={cwd:root,isTTY:false,write:(s:string)=>output+=s,services:{cacheRoot:cache,stateRoot:state}};await runCli(['init','--agents','codex','--sdd','openspec','--backend','host','--dry-run','--json'],io);const id=JSON.parse(output).nextCommand.match(/--continue ([a-f0-9]{64})/)[1];output='';assert.equal(await runCli(['update','--continue',id,'--review','--json'],io),2);assert.deepEqual(await readdir(root),[]);
}));
test('invalid_host_json_does_not_echo_response_fragments_into_reports',()=>fixture(async(root,cache,state)=>{
 let stdout='',stderr='';const io={cwd:root,isTTY:false,write:(s:string)=>stdout+=s,writeError:(s:string)=>stderr+=s,services:{cacheRoot:cache,stateRoot:state}};
 assert.equal(await runCli(['init','--agents','codex','--sdd','openspec','--backend','host','--json'],io),3);
 const id=JSON.parse(stdout).nextCommand.match(/--continue ([a-f0-9]{64})/)[1];const path=state+'/bad-response.json';await writeFile(path,'sk-secret-customer-response');stdout='';stderr='';
 assert.equal(await runCli(['update','--continue',id,'--response',path,'--json'],io),1);
 assert.doesNotMatch(stdout+stderr,/sk-secret/);assert.match(JSON.parse(stdout).error,/invalid.*JSON|JSON.*invalid/i);
}));
test('failure_after_preview_is_present_in_the_final_json_report',()=>fixture(async(root,cache,state)=>{
 let stdout='';const code=await runCli(['init','--agents','codex','--run-checks','test','--json'],{cwd:root,isTTY:false,write:s=>stdout+=s,services:{cacheRoot:cache,stateRoot:state,runChecks:async()=>{throw Error('existing check runner failed');}}});
 assert.equal(code,1);assert.match(JSON.parse(stdout).error,/existing check runner failed/);
}));
test('research_reader_budget_survives_lifecycle_pause_and_new_cli_instance',()=>fixture(async(root,cache,state)=>{
 await writeFile(root+'/source.txt','source');await mkdir(root+'/.rigup');await writeFile(root+'/.rigup/config.yaml',JSON.stringify({agents:['codex'],sdd:'openspec',backend:'host',readBudget:{maxFiles:1,maxBytes:1000}}));
 const backend={run:async(_r:any,reader:any)=>{await reader.read('source.txt',1);return {status:'pending-host' as const,requestId:'fixture',requestPath:cache+'/fixture.json',nextCommand:'continue'};}};
 let output='';const io=()=>({cwd:root,isTTY:false,write:(s:string)=>output+=s,services:{cacheRoot:cache,stateRoot:state,backend}});
 assert.equal(await runCli(['init','--json'],io()),3);output='';assert.equal(await runCli(['update','--json'],io()),1);assert.match(JSON.parse(output).error,/reader.*budget/);
}));
test('resume after upgrading refuses to silently replace a v0.1.1 research ledger',()=>fixture(async(root,cache,state)=>{
 const options={agents:['codex' as const],backend:'codex' as const,sdd:'openspec' as const};
 const {fingerprint}=await scanRepository(root,options);
 const consent=signature({root,options,configDigest:absentDigest,retireIds:[],runChecks:[],configure:false,executionMode:'dry-run',versions:{prompt:'4',template:'1',document:'1',read:'6'},fingerprint});
 const stored=JSON.stringify({root,options,mode:{dryRun:true},runId:'interrupted-research',spent:{calls:1,tokens:'unknown'},consent});
 await mkdir(state+'/runs',{mode:0o700});await writeFile(state+'/runs/'+consent+'.json',stored,{mode:0o600});
 let output='',calls=0;
 const backend={run:async()=>{calls++;throw Error('unexpected dispatch');}};
 const code=await runCli(['init','--agents','codex','--sdd','openspec','--dry-run','--resume','--json'],{cwd:root,isTTY:false,write:s=>output+=s,services:{cacheRoot:cache,stateRoot:state,backend}});
 assert.equal(code,1);assert.match(JSON.parse(output).error,/v0\.1\.1 evidence contract/);assert.equal(calls,0);
 assert.equal(await readFile(state+'/runs/'+consent+'.json','utf8'),stored);assert.deepEqual(await readdir(state+'/runs'),[consent+'.json']);
}));
test('resume finds the saved OpenSpec research after optional external entries become visible',()=>fixture(async(root,cache,state)=>project(async home=>{
 const previousHome=process.env.CODEX_HOME;
 process.env.CODEX_HOME=home;
 try{
  let output='',calls=0;
  const backend={run:async()=>{calls++;throw Error('simulated interrupted dispatch');}};
  const io={cwd:root,isTTY:false,write:(s:string)=>output+=s,services:{cacheRoot:cache,stateRoot:state,backend}};
  const args=['init','--agents','codex','--sdd','openspec','--backend','codex','--dry-run','--json'];
  assert.equal(await runCli(args,io),1);
  assert.equal(calls,1);
  const records=await readdir(state+'/runs');
  const oldRecord=await readFile(state+'/runs/'+records[0],'utf8');
  const external=home+'/skills/openspec-update-change';
  await mkdir(external,{recursive:true});
  await writeFile(external+'/SKILL.md','---\nname: openspec-update-change\ndescription: Fixture revision\n---\n');
  output='';
  assert.equal(await runCli([...args,'--resume'],io),1);
  assert.match(JSON.parse(output).error,/previous OpenSpec discovery/i);
  assert.equal(calls,1);
  assert.deepEqual(await readdir(state+'/runs'),records);
  assert.equal(await readFile(state+'/runs/'+records[0],'utf8'),oldRecord);
 }finally{
  if(previousHome===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=previousHome;
 }
})));
test('failed_native_research_retains_spent_budget_before_retry',()=>fixture(async(root,cache,state)=>{
 const {ResearchFailure}=await import('../src/analyzer/backend.js');await writeFile(root+'/source.txt','source');await mkdir(root+'/.rigup');await writeFile(root+'/.rigup/config.yaml',JSON.stringify({agents:['codex'],sdd:'openspec',backend:'native',researchBudget:{maxCalls:2,maxTokens:100}}));
 let requests=0;const backend={run:async(r:any)=>{if(r.spent?.calls>=2)throw new ResearchFailure('restored research budget exhausted');requests++;throw new ResearchFailure('provider returned invalid research JSON',undefined,{calls:2,tokens:20});}};
 for(let i=0;i<2;i++)assert.equal(await runCli(['init','--dry-run'],{cwd:root,isTTY:false,write:()=>{},services:{cacheRoot:cache,stateRoot:state,backend}}),1);
 assert.equal(requests,1);
}));
test('deselected_capability_requires_explicit_retirement_before_old_wiring_can_remain_active',()=>fixture(async(root,cache,state)=>{
 await mkdir(root+'/.rigup');const config=root+'/.rigup/config.yaml';await writeFile(config,JSON.stringify({agents:['codex'],backend:'host',mcp:[{id:'knowledge',agents:['codex'],url:'https://example.org/mcp'}]}));let output='';const io={cwd:root,isTTY:false,write:(s:string)=>output+=s,services:{cacheRoot:cache,stateRoot:state}};
 assert.equal(await runCli(['init','--json'],io),0);const first=JSON.parse(await readFile(root+'/.rigup/manifest.json','utf8'));assert.ok(first.assets.length);await writeFile(config,JSON.stringify({agents:['codex'],backend:'host'}));output='';
 assert.equal(await runCli(['update','--json'],io),3);const report=JSON.parse(output);assert.ok(report.pending.every((p:any)=>/Retirement is outside/.test(p.reason)));assert.match(await readFile(root+'/.codex/config.toml','utf8'),/knowledge/);
 output='';assert.equal(await runCli(['update','--retire',first.assets.map((a:any)=>a.logicalId).join(','),'--json'],io),0);assert.doesNotMatch(await readFile(root+'/.codex/config.toml','utf8'),/knowledge/);assert.deepEqual(JSON.parse(await readFile(root+'/.rigup/manifest.json','utf8')).assets,[]);
}));
test('upgrade replaces an owned MCP launcher after explicit retirement and preserves other entries',()=>fixture(async(root,cache,state)=>{
 const options={agents:['codex' as const],backend:'host' as const,mcp:[{id:'knowledge',agents:['codex' as const],command:{executable:'node',args:['server.mjs'],cwd:'.',envRefs:[]}}]};
 const runner='.rigup/mcp/knowledge.mjs';
 await mkdir(root+'/.rigup');await mkdir(root+'/.codex');
 await writeFile(root+'/.rigup/config.yaml',JSON.stringify(options));
 await writeFile(root+'/.codex/config.toml','[mcp_servers.customer]\nurl = "https://example.org/mcp"\n');
 const legacy=await preview({
  root,options,fingerprint:(await scanRepository(root,options)).fingerprint,
  assets:[
   {logicalId:'mcp-runner:knowledge',target:runner,content:'// Legacy MCP launcher\n',ownership:{kind:'file'},source:{kind:'customer-mcp',ref:'knowledge'}},
   {logicalId:'mcp:codex:knowledge',target:'.codex/config.toml',content:stringify({mcp_servers:{knowledge:{command:'node',args:[root+'/'+runner]}}}),ownership:{kind:'toml-table',path:['mcp_servers','knowledge']},source:{kind:'customer-mcp',ref:'knowledge'}}
  ],operations:[],requirements:[],warnings:[],versions:{},dispositions:[]
 },[],{cacheRoot:cache+'/previews'});
 assert.equal((await apply(legacy.previewId,{cacheRoot:cache+'/previews',stateRoot:state})).exitCode,0);
 let output='';
 const io={cwd:root,isTTY:false,write:(s:string)=>output+=s,services:{cacheRoot:cache,stateRoot:state}};
 assert.equal(await runCli(['update','--json'],io),3);
 assert.match(output,/--retire mcp-runner:knowledge/);
 assert.match(await readFile(root+'/.codex/config.toml','utf8'),/knowledge\.mjs/);
 output='';
 assert.equal(await runCli(['update','--retire','mcp-runner:knowledge','--json'],io),0,output);
 await assert.rejects(readFile(root+'/'+runner),{code:'ENOENT'});
 const config=parse(await readFile(root+'/.codex/config.toml','utf8')) as any;
 assert.deepEqual({...config.mcp_servers.knowledge},{command:'node',args:['server.mjs'],cwd:root,env_vars:[]});
 assert.equal(config.mcp_servers.customer.url,'https://example.org/mcp');
}));
test('model_cli_overrides_update_individual_fields_without_discarding_existing_key_reference',()=>fixture(async(root,cache,state)=>{
 await mkdir(root+'/.rigup');await writeFile(root+'/.rigup/config.yaml',JSON.stringify({agents:['codex'],sdd:'openspec',backend:'native',model:{provider:'anthropic',model:'existing-model',apiKeyEnv:'EXISTING_KEY'}}));
 for(const [args,model,ref]of [[['--api-key-env','NEW_KEY'],'existing-model','NEW_KEY'],[['--model','new-model'],'new-model','EXISTING_KEY']]as const){const requests:any[]=[];const code=await runCli(['init','--dry-run',...args],{cwd:root,isTTY:false,write:()=>{},services:{cacheRoot:cache,stateRoot:state,backend:{run:async r=>{requests.push(r);return{status:'complete',value:{data:{observations:[],unknowns:[],artifacts:[],dispositions:[]},model:'fixture',unknowns:[],usage:{calls:1,tokens:1}}};}}}});assert.equal(code,3);assert.equal(requests[0].options.model.model,model);assert.equal(requests[0].options.model.apiKeyEnv,ref);}
}));
test('deferred setup installs the selected workflow before a separately reviewed rules update',()=>fixture(async(root,cache,state)=>{
 for(const name of ['openspec-propose','openspec-apply-change','openspec-archive-change']){
  const directory=root+'/.agents/skills/'+name;await mkdir(directory,{recursive:true});
  await writeFile(directory+'/SKILL.md','---\nname: '+name+'\ndescription: Native fixture\n---\n');
 }
 const fixturePath=await openspecFixturePath(root,cache);
 await writeFile(root+'/policy.md','Project policy.\n');
 await mkdir(root+'/.rigup');await writeFile(root+'/.rigup/config.yaml','agents: [codex]\nbackend: host\n');
 const requests:string[]=[];
 const backend:import('../src/analyzer/backend.js').AnalysisBackend={run:async(request,reader)=>{
  assert.equal((request.options as {backend:string}).backend,'codex');
  requests.push(request.expectedOutput??request.kind);
  const data={observations:[],unknowns:[],artifacts:[],dispositions:[],...(request.expectedOutput==='plan'?{
   ruleTopics:[{id:'workflow',title:'Project workflow'}],
   guidance:[{topicId:'workflow',topic:'Policy',sourceRef:(await reader.read('policy.md',1,1)).evidence,scope:['.'],coverageStatus:'reusable',consumers:['change-prepare','change-deliver'],gaps:[]}],
  }:{})};
  return {status:'complete',value:{data,model:'fixture',unknowns:[],usage:{calls:1,tokens:5}}};
 }};
 const cli=async(...args:string[])=>{
  let output='';const code=await runCli([...args,'--json'],{cwd:root,isTTY:false,write:s=>output+=s,services:{cacheRoot:cache,stateRoot:state,backend}});
  return {code,...JSON.parse(output)};
 };
 const path=process.env.PATH;
 process.env.PATH=fixturePath;
 let installed;
 try{
  const base=await cli('init','--agents','codex','--sdd','openspec','--backend','codex','--defer-research');
  assert.equal(base.code,3);assert.equal(base.phase,'handoff');assert.equal(base.projectRules,'pending');assert.deepEqual(requests,[]);
  await assert.rejects(()=>readFile(root+'/.agents/skills/change-prepare/SKILL.md'),{code:'ENOENT'});
  installed=await cli('update','--apply',base.previewId,'--sessions-ended');
 }finally{process.env.PATH=path;}
 assert.equal(installed.code,0);assert.equal(installed.projectRules,'pending');assert.match(installed.nextCommand,/rigup update .*--review/);
 const reference=root+'/.agents/skills/change-prepare/references/project.md';
 assert.match(await readFile(reference,'utf8'),/Project rules are pending/);
 assert.equal((await cli('doctor')).projectRules,'pending');
 assert.equal((await cli('update','--defer-research')).code,2);
 const rules=await cli('update');
 assert.equal(rules.code,3);assert.equal(rules.phase,'handoff');assert.equal(rules.projectRules,'ready');assert.deepEqual(requests,['analyze','plan']);
 assert.match(await readFile(reference,'utf8'),/Project rules are pending/);
 const applied=await cli('update','--apply',rules.previewId,'--sessions-ended');
 assert.equal(applied.code,0);assert.equal(applied.projectRules,'ready');
 assert.match(await readFile(reference,'utf8'),/development-rules\.md/);
 assert.match(await readFile(root+'/docs/rigup/development-rules.md','utf8'),/policy\.md/);
}));
