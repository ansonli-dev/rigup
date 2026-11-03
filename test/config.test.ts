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
test('read_budget_is_validated_before_scan',async()=>{
 await fixture('readBudget: {maxFiles: 10, maxBytes: 1000}\n',async root=>assert.equal((await loadOptions(root,{})).readBudget?.maxFiles,10));
 await fixture('readBudget: {maxFiles: -1, maxBytes: 1000}\n',async root=>{await assert.rejects(loadOptions(root,{}),/maxFiles/);});
});
test('model_configuration_saves_reference_instead_of_secret',async()=>{
 await fixture('model: {provider: anthropic, model: user-selected-model, apiKeyEnv: TEAM_API_KEY}\n',async root=>{
  const options=await loadOptions(root,{});assert.equal(options.model?.model,'user-selected-model');assert.equal(options.model?.apiKeyEnv,'TEAM_API_KEY');
 });
 await fixture('model: {provider: anthropic, model: selected, apiKey: literal-secret}\n',async root=>{await assert.rejects(loadOptions(root,{}),/apiKey|unknown/);});
});
test('integration_choices_preserve_install_initialize_and_conventions',async()=>{
 await fixture('agents: [codex]\nsdd: openspec\ntools: [{id: codegraph, install: false, initialize: true, agents: [codex]}]\ncustomSkills: [{source: customer/review, position: deliver}]\nprojectConventions: {tracker: {system: local, reference: docs/issues}}\n',async root=>{
  const options=await loadOptions(root,{});assert.equal(options.sdd,'openspec');assert.equal(options.tools?.[0].install,false);assert.equal(options.tools?.[0].initialize,true);assert.equal(options.projectConventions?.tracker?.system,'local');
 });
});
test('mcp_does_not_accept_literal_env_credentials_or_credential_urls',async()=>{
 await fixture('mcp: [{id: customer, agents: [claude], url: "https://user:literal@example.test/mcp"}]\n',async root=>{await assert.rejects(loadOptions(root,{}),/url|credential/);});
 await fixture('mcp: [{id: customer, agents: [claude], command: {executable: node, args: [], cwd: ".", envRefs: [], env: {TOKEN: literal}}}]\n',async root=>{await assert.rejects(loadOptions(root,{}),/command.*env|unknown/);});
});
test('mcp_credential_arguments_require_environment_references',async()=>{
 await fixture('mcp: [{id: customer, agents: [claude], command: {executable: node, args: ["--token", "literal-secret"], cwd: ".", envRefs: []}}]\n',async root=>{await assert.rejects(loadOptions(root,{}),/args|credential/);});
});
test('customer_and_mcp_header_credentials_are_environment_references_only',async()=>{
 const {validateOptions}=await import('../src/config.js');
 for(const args of [['-H','Authorization: Bearer literal-secret'],['--header=X-API-Key: literal-secret'],['--user','user:password']])assert.throws(()=>validateOptions({mcp:[{id:'customer',agents:['codex'],command:{executable:'server',args,cwd:'.',envRefs:[]}}]}),/credential|args|reference/);
 assert.doesNotThrow(()=>validateOptions({customer:{commands:{feedback:{executable:'client',args:['-H','Authorization: Bearer ${TOKEN}'],cwd:'.',envRefs:['TOKEN']}}}}));
});
