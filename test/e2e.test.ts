import {test} from 'node:test';import assert from 'node:assert/strict';
import {project} from './helpers.js';import {mkdir,writeFile,readFile,readdir} from 'node:fs/promises';
import {runCli} from '../src/cli.js';
async function fixture(fn:(root:string,cache:string,state:string)=>Promise<void>){await project(async root=>project(async cache=>project(async state=>fn(root,cache,state))));}
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
 const requestPath=cache+'/host/custom.request.json';let out='';const io={cwd:root,isTTY:false,write:(s:string)=>out+=s,services:{cacheRoot:cache,stateRoot:state}};
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
 const events:string[]=[];const answers=['2','1','3','2','fixture-model','temporary-secret','1'];let secret=false;const native=['superpowers:brainstorming','superpowers:writing-plans','superpowers:executing-plans','superpowers:verification-before-completion'];for(const name of native){const dir=root+'/.agents/skills/'+name;await mkdir(dir,{recursive:true});await writeFile(dir+'/SKILL.md','---\nname: '+name+'\ndescription: fixture\n---\nNative gates\n');}
 let output='';const code=await runCli(['init'],{cwd:root,isTTY:true,write:s=>output+=s,read:async hidden=>{events.push('prompt');secret||=!!hidden;return answers.shift()??null;},services:{cacheRoot:cache,stateRoot:state,backend:{run:async r=>{events.push('backend');return {status:'complete',value:{data:{observations:[],unknowns:[],artifacts:[],dispositions:[]},model:'fixture-model',unknowns:[],usage:{calls:1,tokens:1}}};}}}});assert.equal(code,0);assert.equal(secret,true);assert.doesNotMatch(output,/temporary-secret/);const first=events.indexOf('backend');assert.ok(first>0);assert.ok(!events.slice(first).includes('prompt'));
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
test('failed_native_research_retains_spent_budget_before_retry',()=>fixture(async(root,cache,state)=>{
 const {ResearchFailure}=await import('../src/analyzer/backend.js');await writeFile(root+'/source.txt','source');await mkdir(root+'/.rigup');await writeFile(root+'/.rigup/config.yaml',JSON.stringify({agents:['codex'],sdd:'openspec',backend:'native',researchBudget:{maxCalls:2,maxTokens:100}}));
 let requests=0;const backend={run:async(r:any)=>{if(r.spent?.calls>=2)throw new ResearchFailure('restored research budget exhausted');requests++;throw new ResearchFailure('provider returned invalid research JSON',undefined,{calls:2,tokens:20});}};
 for(let i=0;i<2;i++)assert.equal(await runCli(['init'],{cwd:root,isTTY:false,write:()=>{},services:{cacheRoot:cache,stateRoot:state,backend}}),1);
 assert.equal(requests,1);
}));
test('deselected_capability_requires_explicit_retirement_before_old_wiring_can_remain_active',()=>fixture(async(root,cache,state)=>{
 await mkdir(root+'/.rigup');const config=root+'/.rigup/config.yaml';await writeFile(config,JSON.stringify({agents:['codex'],backend:'host',mcp:[{id:'knowledge',agents:['codex'],url:'https://example.org/mcp'}]}));let output='';const io={cwd:root,isTTY:false,write:(s:string)=>output+=s,services:{cacheRoot:cache,stateRoot:state}};
 assert.equal(await runCli(['init','--json'],io),0);const first=JSON.parse(await readFile(root+'/.rigup/manifest.json','utf8'));assert.ok(first.assets.length);await writeFile(config,JSON.stringify({agents:['codex'],backend:'host'}));output='';
 assert.equal(await runCli(['update','--json'],io),3);const report=JSON.parse(output);assert.ok(report.pending.every((p:any)=>/Retirement is outside/.test(p.reason)));assert.match(await readFile(root+'/.codex/config.toml','utf8'),/knowledge/);
 output='';assert.equal(await runCli(['update','--retire',first.assets.map((a:any)=>a.logicalId).join(','),'--json'],io),0);assert.doesNotMatch(await readFile(root+'/.codex/config.toml','utf8'),/knowledge/);assert.deepEqual(JSON.parse(await readFile(root+'/.rigup/manifest.json','utf8')).assets,[]);
}));
test('model_cli_overrides_update_individual_fields_without_discarding_existing_key_reference',()=>fixture(async(root,cache,state)=>{
 await mkdir(root+'/.rigup');await writeFile(root+'/.rigup/config.yaml',JSON.stringify({agents:['codex'],sdd:'openspec',backend:'native',model:{provider:'anthropic',model:'existing-model',apiKeyEnv:'EXISTING_KEY'}}));
 for(const [args,model,ref]of [[['--api-key-env','NEW_KEY'],'existing-model','NEW_KEY'],[['--model','new-model'],'new-model','EXISTING_KEY']]as const){const requests:any[]=[];const code=await runCli(['init','--dry-run',...args],{cwd:root,isTTY:false,write:()=>{},services:{cacheRoot:cache,stateRoot:state,backend:{run:async r=>{requests.push(r);return{status:'complete',value:{data:{observations:[],unknowns:[],artifacts:[],dispositions:[]},model:'fixture',unknowns:[],usage:{calls:1,tokens:1}}};}}}});assert.equal(code,3);assert.equal(requests[0].options.model.model,model);assert.equal(requests[0].options.model.apiKeyEnv,ref);}
}));
