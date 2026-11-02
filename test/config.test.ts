import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadOptions} from '../src/config.js';

async function fixture(body:string, fn:(root:string)=>Promise<void>) {
 const root=await mkdtemp(join(tmpdir(),'rigup-'));
 try { await mkdir(join(root,'.rigup')); await writeFile(join(root,'.rigup/config.yaml'),body); await fn(root); }
 finally { await rm(root,{recursive:true,force:true}); }
}
test('explicit_options_override_project_config', async () => {
 await fixture(`agents: [claude]
backend: host
`, async root => {
   assert.deepEqual((await loadOptions(root,{agents:['codex']})).agents,['codex']);
   assert.equal((await loadOptions(root,{agents:['codex']})).backend,'host');
 });
});
test('invalid_config_has_field_error', async () => {
 await fixture(`agents: [invented]
`, async root => {
   await assert.rejects(loadOptions(root,{}), /agents/);
 });
});
test('project_config_overrides_explicitly_selected_profile', async () => {
 await fixture('agents: [claude]\n', async root => {
   await writeFile(join(root,'profile.yaml'),'agents: [omp]\nbackend: host\n');
   const options = await loadOptions(root,{profile:'profile.yaml'});
   assert.deepEqual(options.agents,['claude']);
   assert.equal(options.backend,'host');
 });
});
test('missing_selected_profile_is_an_error', async () => {
 await fixture('agents: [claude]\n', async root => {
   await assert.rejects(loadOptions(root,{profile:'missing.yaml'}), /profile/);
 });
});
test('customer_templates_and_mcp_validate_fields',async()=>{
 await fixture('templates: [{source: local}]\n',async root=>{await assert.rejects(loadOptions(root,{}),/templates.*target/);});
 await fixture('mcp: [{id: customer, agents: [claude], url: "https://example.test", envRefs: [TOKEN]}]\n',async root=>{
  assert.equal((await loadOptions(root,{})).mcp?.[0].id,'customer');
 });
});
