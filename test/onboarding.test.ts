import {test} from 'node:test';
import assert from 'node:assert/strict';
import {onboard} from '../src/onboarding.js';

test('back_can_reopen_a_choice_initially_supplied_as_an_argument',async()=>{
 const answers=['b','1','4','3'];
 const result=await onboard({agents:['codex'],backend:'codex'},{write:()=>{},read:async()=>answers.shift()??null},{configure:false,knownBackend:false,provided:{agents:true}});
 assert.ok(result);assert.deepEqual(result.options.agents,['claude']);assert.equal(result.options.sdd,undefined);assert.equal(answers.length,0);
});

test('model_prompt_back_can_change_an_explicit_native_backend',async()=>{
 const answers=['b','3'];const previous=process.env.ANTHROPIC_MODEL;delete process.env.ANTHROPIC_MODEL;
 try {const result=await onboard({agents:['codex'],backend:'native',sdd:'openspec'},{write:()=>{},read:async()=>answers.shift()??null},{configure:false,knownBackend:true});
 assert.ok(result);assert.equal(result.options.backend,'host');assert.equal(answers.length,0);
 }finally{if(previous===undefined)delete process.env.ANTHROPIC_MODEL;else process.env.ANTHROPIC_MODEL=previous;}
});

test('selecting_an_agent_keeps_explicit_research_model_and_rebinds_explicit_tools',async()=>{
 const answers=['1'];
 const result=await onboard({agents:['codex'],backend:'native',sdd:'openspec',model:{provider:'anthropic',model:'fixture-model',apiKeyEnv:'RIGUP_FIXTURE_KEY'},tools:[{id:'codegraph',install:true,initialize:true,agents:['codex']}]},{write:()=>{},read:async()=>answers.shift()??null},{configure:false,knownBackend:true,credentials:{apiKey:'fixture-only-value'},provided:{sdd:true,tools:true,model:true}});
 assert.ok(result);assert.deepEqual(result.options.agents,['claude']);assert.equal(result.options.sdd,'openspec');assert.equal(result.options.model?.model,'fixture-model');assert.deepEqual(result.options.tools?.[0].agents,['claude']);assert.equal(answers.length,0);
});


test('returning_to_agents_keeps_explicit_tool_registration_on_the_new_agent',async()=>{
 const answers=['','b','1','4',''];
 const result=await onboard({agents:['codex'],backend:'host',tools:[{id:'codegraph',install:true,initialize:true,agents:['codex']}]},{write:()=>{},read:async()=>answers.shift()??null},{configure:false,knownBackend:true,provided:{tools:true}});
 assert.ok(result);assert.deepEqual(result.options.agents,['claude']);assert.deepEqual(result.options.tools?.[0].agents,['claude']);assert.equal(answers.length,0);
});
