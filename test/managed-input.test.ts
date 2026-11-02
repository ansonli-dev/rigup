import {test} from 'node:test';
import assert from 'node:assert/strict';
import {projectInput,remoteInput} from '../src/managed-input.js';
test('managed_outputs_excluded_but_unmanaged_config_remains',()=>{
 const a='user guidance\n<!-- rigup:start -->\nold generated\n<!-- rigup:end -->\ntail';
 const b=a.replace('old generated','new generated');
 const ownership={kind:'block' as const,start:'<!-- rigup:start -->',end:'<!-- rigup:end -->'};
 assert.equal(projectInput(a,[ownership]),projectInput(b,[ownership]));
 assert.notEqual(projectInput(a,[ownership]),projectInput(a.replace('user guidance','changed'),[ownership]));
 assert.equal(projectInput('generated',[{kind:'file'}]),null);
 assert.throws(()=>projectInput('no matching markers',[ownership]),/ownership/);
});
test('remote_unknown_version_requires_reread_and_unavailable_invalidates',async()=>{
 let reads=0;
 assert.equal(await remoteInput(undefined,async()=>{reads++;return 'fresh';}),'fresh');assert.equal(reads,1);
 await assert.rejects(remoteInput(undefined,async()=>{throw new Error('unavailable');}),/unavailable/);
});
test('json_key_projection_retains_unmanaged_keys_and_comments',()=>{
 const a='{\n // user comment\n "mcpServers":{"rigup":{"url":"old"},"customer":{"url":"keep"}}\n}';
 const selectors=[{kind:'json-key' as const,path:['mcpServers','rigup']}];
 assert.equal(projectInput(a,selectors),projectInput(a.replace('"old"','"new"'),selectors));
 assert.notEqual(projectInput(a,selectors),projectInput(a.replace('keep','changed'),selectors));
 assert.match(projectInput(a,selectors)!,/user comment/);
});
test('toml_table_projection_retains_other_tables',()=>{
 const a='# user\n[tool.rigup]\nvalue = "old"\n[tool.customer]\nvalue = "keep"\n';
 const selectors=[{kind:'toml-table' as const,path:['tool','rigup']}];
 assert.equal(projectInput(a,selectors),projectInput(a.replace('old','new'),selectors));
 assert.notEqual(projectInput(a,selectors),projectInput(a.replace('keep','changed'),selectors));
});
test('tool_output_projection_keeps_user_inputs_in_same_directory',()=>{
 assert.equal(projectInput('index content',[{kind:'file'}]),null);
 assert.equal(projectInput('user authored rules',[]),'user authored rules');
});
test('remote_content_and_version_changes_are_observed_without_stale_cache',async()=>{
 assert.equal(await remoteInput('v1',async()=> 'one'),'one');
 assert.equal(await remoteInput('v2',async()=> 'two'),'two');
});
