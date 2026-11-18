import {test} from 'node:test';
import assert from 'node:assert/strict';
import {onboard,promptNativeCredentials} from '../src/onboarding.js';
import {project} from './helpers.js';
import {prepareIntegrations} from '../src/integrations/registry.js';
import {scanRepository} from '../src/analyzer/repository.js';

test('back skips the agent selection supplied as an argument',async()=>{
 const answers=['b','4','3'];
 const result=await onboard({agents:['codex'],backend:'codex'},{write:()=>{},read:async()=>answers.shift()??null},{configure:false,provided:{agents:true}});
 assert.ok(result);assert.deepEqual(result.agents,['codex']);assert.equal(result.sdd,undefined);assert.equal(answers.length,0);
});

test('a new agent keeps the existing model and rebinds explicitly selected tools',async()=>{
 const answers=['1'];
 const result=await onboard({agents:['codex'],backend:'native',sdd:'openspec',model:{provider:'anthropic',model:'fixture-model',apiKeyEnv:'RIGUP_FIXTURE_KEY'},tools:[{id:'codegraph',install:true,initialize:true,agents:['codex']}]},{write:()=>{},read:async()=>answers.shift()??null},{configure:true,provided:{sdd:true,tools:true}});
 assert.ok(result);assert.deepEqual(result.agents,['claude']);assert.equal(result.sdd,'openspec');assert.equal(result.model?.model,'fixture-model');assert.deepEqual(result.tools?.[0].agents,['claude']);assert.equal(answers.length,0);
});

test('returning to agents keeps the explicit tool choice and removes stale MCP bindings',async()=>{
 const answers=['','b','1','4'];
 const result=await onboard({agents:['codex'],backend:'host',tools:[{id:'codegraph',install:true,initialize:true,agents:['codex']}],mcp:[{id:'example',agents:['codex'],url:'https://example.test/'}]},{write:()=>{},read:async()=>answers.shift()??null},{configure:false,provided:{tools:true}});
 assert.ok(result);assert.deepEqual(result.agents,['claude']);assert.deepEqual(result.tools?.[0].agents,['claude']);assert.deepEqual(result.mcp,[]);assert.equal(answers.length,0);
});
test('the automatic MCP target follows the final guided host selection',()=>project(async root=>{
 const selected=await onboard({agents:['codex'],backend:'host',mcp:[
  {id:'implicit',url:'https://mcp.example.test/'},
  {id:'explicit',agents:['opencode','codex'],url:'https://mcp.example.test/'},
 ]},{write:()=>{},read:async()=>null},{
  configure:true,provided:{sdd:true,tools:true},ask:async()=>['claude','opencode'],
 });
 assert.ok(selected);
 assert.deepEqual(selected.mcp?.[1]?.agents,['opencode']);
 assert.equal(selected.mcp?.[0]?.agents,undefined);
 const {assets}=await prepareIntegrations(await scanRepository(root,selected),selected);
 assert.deepEqual(assets.filter(asset=>asset.source.kind==='customer-mcp').map(asset=>[asset.target,asset.source.ref]),[
  ['.mcp.json','implicit'],['opencode.jsonc','implicit'],['opencode.jsonc','explicit'],
 ]);
}));

test('clearing tools keeps an explicit empty selection for configuration',async()=>{
 const result=await onboard({agents:['codex'],backend:'host',tools:[{id:'openwiki',install:false,agents:['codex']}]},{write:()=>{},read:async()=> '3'},{configure:true,provided:{agents:true,sdd:true}});
 assert.deepEqual(result?.tools,[]);
});

test('setup uses the configured language without prompting for it',async()=>{
 const initial={agents:['codex' as const],backend:'codex' as const,sdd:'openspec' as const,documentLanguage:'ja'};
 const result=await onboard(initial,{write:()=>{},read:async()=>assert.fail('unexpected input')},{configure:false,provided:{agents:true,sdd:true,tools:true}});
 assert.equal(result?.documentLanguage,'ja');
});

test('the legacy credential prompt treats escape as cancellation',async()=>{
 const options={agents:['codex' as const],backend:'native' as const,sdd:'openspec' as const};
 const result=await promptNativeCredentials(options,{write:()=>{},read:async()=> '\x1b'},undefined,{});
 assert.equal(result,null);
});
