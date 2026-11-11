import {test} from 'node:test';
import {join} from 'node:path';import assert from 'node:assert/strict';
import {openspecFixturePath,project} from './helpers.js';import {mkdir,writeFile,readFile,readdir} from 'node:fs/promises';
import {runCli} from '../src/cli.js';
import {scanRepository} from '../src/analyzer/repository.js';
import {preview} from '../src/installer/preview.js';
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

test('unified harness uses one lifecycle for new mature and mixed repositories',async t=>{
 const {cp,rename}=await import('node:fs/promises');
 const {fileURLToPath}=await import('node:url');
 const {loadManifest}=await import('../src/installer/baseline.js');
 const {projectInput}=await import('../src/managed-input.js');
 const {validateResearch}=await import('../src/analyzer/backend.js');
 const {parse:yaml}=await import('yaml');
 const fixtureRoot=fileURLToPath(new URL('./fixtures/unified-harness/',import.meta.url));
 const cases=[
  {name:'new-service',checks:['.'],drafts:[['api-errors','.']]},
  {name:'mature-service',checks:['.'],drafts:[],authority:'docs/api-errors.md',authorityScope:'.'},
  {name:'mixed-repo',checks:['services/legacy','services/new','web'],drafts:[['api-errors','services/new'],['ui-states','web']],authority:'services/legacy/docs/api-errors.md',authorityScope:'services/legacy'},
 ];
 for(const scenario of cases)await t.test(scenario.name,()=>fixture(async(root,cache,state)=>{
  await cp(join(fixtureRoot,scenario.name),root,{recursive:true});
  const current=join(root,'profile.yaml');
  const profile=JSON.parse(await readFile(current,'utf8'));
  const originalCi=await readFile(join(root,'.gitlab-ci.yml'),'utf8');
  const entry=join(root,'AGENTS.md');
  const originalEntry=await readFile(entry,'utf8').catch(error=>{if(error.code==='ENOENT')return undefined;throw error;});
  const authorityPath=scenario.authority&&join(root,scenario.authority);
  const originalAuthority=authorityPath&&await readFile(authorityPath,'utf8');
  const backend:import('../src/analyzer/backend.js').AnalysisBackend={run:async(request,reader)=>{
   const guidance=scenario.authority?[{topicId:'api-errors',topic:'API error contract',scope:[scenario.authorityScope!],
    sourceRef:(await reader.read(scenario.authority,3,3)).evidence,coverageStatus:'reusable',consumers:['agent-entry'],gaps:[]}]:[];
   const data={observations:[],guidance,unknowns:[],ruleTopics:guidance.length?[{id:'api-errors',title:'API error contract'}]:[],
    ...(request.expectedOutput==='plan'?{artifacts:[],dispositions:[]}:{})};
   await validateResearch(data,reader);
   return {status:'complete',value:{data,model:'fixture',unknowns:[],usage:{calls:1,tokens:1}}};
  }};
  const run=async(args:string[],expected:number,semantic=false)=>{
   let out='';
   const code=await runCli([...args,'--json'],{cwd:root,isTTY:false,write:s=>out+=s,services:{cacheRoot:cache,stateRoot:state,...(semantic?{backend}:{})}});
   assert.equal(code,expected,out);
   return JSON.parse(out);
  };
  const install=async(review:any)=>{
   assert.equal(review.executable,true,JSON.stringify(review.blockers));
   return run(['update','--apply',review.previewId,'--sessions-ended'],0);
  };
  const review=await run(['init','--profile','profile.yaml','--backend','host','--sdd','none','--review'],3,true);
  assert.deepEqual(review.blockers,[]);
  assert.deepEqual(review.harness.checks.filter((item:any)=>item.command.args[1]==='build').map((item:any)=>item.command.cwd),scenario.checks);
  assert.deepEqual(review.harness.ci.map((job:any)=>[job.command.cwd,job.coverageStatus]),scenario.checks.map(cwd=>[cwd,'reusable']));
  if(scenario.authority)assert.ok(review.harness.guidance.some((binding:any)=>binding.sourceRef?.path===scenario.authority&&binding.coverageStatus==='reusable'));
  const installed=await install(review);
  assert.deepEqual(installed.checks,[]);
  const manifest=(await loadManifest(root))!;
  assert.equal(manifest.schemaVersion,1);
  assert.deepEqual((manifest.seededProjectDocuments??[]).map(doc=>[doc.topicId,doc.scope]),scenario.drafts);
  assert.equal(new Set((manifest.seededProjectDocuments??[]).map(doc=>JSON.stringify([doc.topicId,doc.scope]))).size,scenario.drafts.length);
  const doctor=await run(['doctor'],3);
  assert.equal(doctor.projectRules,'ready');
  assert.deepEqual(doctor.checks,[]);
  const ci=join(root,'.gitlab-ci.yml'),jobs=join(root,'.rigup','gitlab-ci.yml');
  const ciAsset=manifest.assets.find(asset=>asset.logicalId==='gitlab:include');
  assert.equal(projectInput(await readFile(ci,'utf8'),ciAsset?[ciAsset.ownership]:[]),originalCi);
  if(originalEntry){
   const managed=manifest.assets.filter(asset=>asset.target==='AGENTS.md').map(asset=>asset.ownership);
   assert.equal(projectInput(await readFile(entry,'utf8'),managed),originalEntry);
  }
  if(authorityPath)assert.equal(await readFile(authorityPath,'utf8'),originalAuthority);
  const doc=manifest.seededProjectDocuments?.[0];
  let globalJobs:string|undefined;
  if(doc){
   const file=join(root,doc.target);
   const body='Apply the confirmed order response convention.\n';
   await writeFile(file,(await readFile(file,'utf8')).replace('status: draft','status: confirmed')+body);
   const saved=await readFile(file,'utf8');
   if(scenario.name==='mixed-repo'){
    const complete=(await readFile(jobs,'utf8'))+'# Customer job comment\n';
    globalJobs=complete;
    assert.equal(doc.scope,'services/new');
    assert.match(doc.target,/^docs\/rigup\/conventions\//);
    await writeFile(jobs,complete);
    await writeFile(current,JSON.stringify({...profile,scope:['services/new']}));
    const scoped=await run(['update','--review'],3);
    assert.deepEqual(scoped.harness.checks.filter((item:any)=>item.command.args[1]==='build').map((item:any)=>item.command.cwd),['services/new']);
    assert.ok(scoped.warnings.some((warning:string)=>warning.includes('complete root review')));
    await writeFile(file,saved+'Customer edit after review.\n');
    const stale=await run(['update','--apply',scoped.previewId,'--sessions-ended'],1);
    assert.match(stale.error,/source input changed/);
    await writeFile(file,saved);
    const scopedReview=await run(['update','--review'],3);
    await install(scopedReview);
    assert.equal(await readFile(jobs,'utf8'),complete);
    assert.equal(projectInput(await readFile(ci,'utf8'),[ciAsset!.ownership]),originalCi);
    const commands=yaml(complete)['rigup:checks'].script.slice(1);
    assert.deepEqual(commands,scenario.checks.map(cwd=>"(cd '"+cwd+"' && 'npm' 'run' 'build')"));
    await writeFile(current,JSON.stringify({...profile,scope:['.']}));
   }
   const updated=await run(['update','--review'],3);
   await install(updated);
   if(globalJobs){
    assert.equal(await readFile(jobs,'utf8'),globalJobs);
    assert.equal(projectInput(await readFile(ci,'utf8'),[ciAsset!.ownership]),originalCi);
   }
   assert.equal(await readFile(file,'utf8'),saved);
   assert.match(await readFile(entry,'utf8'),/rigup:harness:start[\s\S]*api-errors--/);
  }
  const before=await readFile(join(root,'.rigup','manifest.json'),'utf8');
  const repeated=await run(['update','--review'],0);
  assert.equal(repeated.installStatus,'up-to-date');
  assert.equal(await readFile(join(root,'.rigup','manifest.json'),'utf8'),before);
 }));
});

test('unified harness leaves an empty repository at a minimal pending foundation',()=>fixture(async(root,cache,state)=>{
 let output='';
 const run=(args:string[])=>runCli([...args,'--json'],{cwd:root,isTTY:false,write:text=>output+=text,services:{cacheRoot:cache,stateRoot:state}});
 assert.equal(await run(['init','--agents','codex','--sdd','none','--defer-research','--review']),3,output);
 const review=JSON.parse(output);
 assert.equal(review.projectRules,'pending');
 assert.deepEqual(review.harness.guidance,[]);
 assert.deepEqual(review.projectDocuments??[],[]);
 output='';
 assert.equal(await run(['update','--apply',review.previewId,'--sessions-ended']),0,output);
 assert.equal(JSON.parse(output).projectRules,'pending');
}));

for(const partial of [false,true])test('unified harness reuses legacy authority and accepts independent new-module inference'+(partial?' with a remaining gap':''),()=>fixture(async(root,cache,state)=>{
 const {cp}=await import('node:fs/promises');
 const {validateResearch}=await import('../src/analyzer/backend.js');
 const {loadManifest}=await import('../src/installer/baseline.js');
 await cp(new URL('./fixtures/unified-harness/mixed-repo/',import.meta.url),root,{recursive:true});
 const scope='services/new';
 if(partial)await writeFile(join(root,scope,'partial.md'),'Errors use Problem Details. Retry semantics still need agreement.\n');
 await writeFile(join(root,scope,'src','request.js'),'exports.invalidRequest = () => problem(422, "request");\n');
 await writeFile(join(root,scope,'src','order.js'),'exports.invalidOrder = () => problem(422, "order");\n');
 const backend:import('../src/analyzer/backend.js').AnalysisBackend={run:async(request,reader)=>{
  let data:Record<string,unknown>={observations:[],unknowns:[]};
  if(request.expectedOutput==='content'){
   const job=(request.input as {job:{ruleSources:{id:string;scope:string[]}[]}}).job;
   assert.deepEqual(job.ruleSources.map(rule=>rule.scope),[[scope]]);
   data.rulebook={title:'Project development rules',existing:'Existing rules',inferred:'Code conventions',when:'When to apply',verify:'Verification',exceptions:'Exceptions',
    rules:job.ruleSources.map(rule=>({sourceId:rule.id,trigger:'When rejecting invalid requests',instruction:'Return HTTP 422 through the shared problem helper.',
     verification:'Check invalid request responses for status 422.',exceptions:[]}))};
  }else if(request.expectedOutput==='acceptance')Object.assign(data,{accepted:true,reason:'Verified two independent handlers and the affected scope.'});
  else{
   const ref=async(path:string,line=1)=>(await reader.read(path,line,line)).evidence;
   data={...data,ruleTopics:[{id:'api-errors',title:'API error contract'}],guidance:[{
    topicId:'api-errors',topic:'API error contract',scope:['services/legacy'],sourceRef:await ref('services/legacy/docs/api-errors.md',3),
    coverageStatus:'reusable',consumers:['agent-entry'],gaps:[],
   },...(partial?[{topicId:'api-errors',topic:'API error contract',scope:[scope],sourceRef:await ref(scope+'/partial.md'),
     coverageStatus:'partial',consumers:['agent-entry'],gaps:['Decide status codes','Decide retry semantics']}]:[])],observations:[{
    topicId:'api-errors',topic:'API error contract',scope:[scope],classification:'convention',statement:'Use the shared problem helper and status 422 for invalid requests.',
    supportingEvidence:[await ref('services/legacy/src/service.js'),...await Promise.all(['request.js','order.js'].map(file=>ref(scope+'/src/'+file)))],counterEvidence:[],
    coverage:{independentSupports:2,counterexampleSearched:true,counterexampleQueries:['problem(400']},guidanceDisposition:'follow-existing',
    ...(partial?{gap:'Decide status codes'}:{}),
   }],...(request.expectedOutput==='plan'?{artifacts:[],dispositions:[]}:{})};
  }
  await validateResearch(data,reader);
  return {status:'complete',value:{data,model:'fixture',unknowns:[],usage:{calls:1,tokens:1}}};
 }};
 let output='';
 const run=(args:string[])=>runCli([...args,'--json'],{cwd:root,isTTY:false,write:text=>output+=text,services:{cacheRoot:cache,stateRoot:state,backend}});
 assert.equal(await run(['init','--profile','profile.yaml','--backend','host','--sdd','none','--review']),3,output);
 const review=JSON.parse(output);
 assert.equal(review.executable,true);
 assert.deepEqual(review.projectDocuments.map((doc:any)=>doc.target.match(/\/([^/]+)--/)[1]),partial?['api-errors','ui-states']:['ui-states']);
 if(partial)assert.deepEqual(review.harness.guidance.find((binding:any)=>binding.coverageStatus==='partial').gaps,['Decide retry semantics']);
 else assert.ok(review.harness.guidance.find((binding:any)=>binding.scope.includes(scope)&&binding.coverageStatus==='reusable').sourceRef.path.startsWith(scope+'/'));
 output='';
 assert.equal(await run(['update','--apply',review.previewId,'--sessions-ended']),0,output);
 const manifest=(await loadManifest(root))!;
 assert.deepEqual(manifest.seededProjectDocuments?.map(doc=>doc.scope),partial?[scope,'web']:['web']);
 if(partial){
  const pending=await readFile(join(root,manifest.seededProjectDocuments![0].target),'utf8');
  assert.match(pending,/Decide retry semantics/);
  assert.doesNotMatch(pending,/Decide status codes/);
 }
 assert.match(await readFile(join(root,'docs/rigup/development-rules/api-errors.md'),'utf8'),/Return HTTP 422 through the shared problem helper/);
 assert.match(await readFile(join(root,'docs/rigup/development-rules.md'),'utf8'),/services\/legacy\/docs\/api-errors\.md/);
 output='';
 assert.equal(await run(['update','--review']),0,output);
 assert.equal(JSON.parse(output).installStatus,'up-to-date');
}));

test('harness upgrade reads the portable v035 installed fixture offline',()=>fixture(async root=>{
 const {cp}=await import('node:fs/promises');
 const {loadManifest,trustedBaseline}=await import('../src/installer/baseline.js');
 await cp(new URL('./fixtures/unified-harness/v035-install/',import.meta.url),root,{recursive:true});
 const installed=(await loadManifest(root))!;
 assert.equal(installed.schemaVersion,1);
 assert.equal(installed.projectRules,'ready');
 assert.equal(installed.options?.sdd,'openspec');
 assert.deepEqual(installed.options?.quality?.gitlab?.checks,[{cwd:'.',script:'build'}]);
 assert.deepEqual(installed.versions,{prompt:'11',template:'7',document:'1',read:'6'});
 assert.equal(installed.seededProjectDocuments,undefined);
 for(const asset of installed.assets)assert.ok(await trustedBaseline(root,asset),asset.logicalId);
 assert.match(await readFile(join(root,'AGENTS.md'),'utf8'),/Keep the team guide intact/);
 assert.match(await readFile(join(root,'.gitlab-ci.yml'),'utf8'),/customer-build:[\s\S]*\.rigup\/gitlab-ci\.yml/);
}));
