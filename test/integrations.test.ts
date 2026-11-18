import {test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {project} from './helpers.js';
import {scanRepository} from '../src/analyzer/repository.js';
import {fixedNpmView,prepareToolFixture,writeNativeToolFixture} from './native-tool-fixture.js';
import {npmCommand} from '../src/npm-command.mjs';
import {renderCustomerTemplate} from '../src/integrations/custom-templates.js';
test('customer_template_renders_declared_scalars_and_keeps_consumer',()=>project(async root=>{
 await writeFile(join(root,'review.tmpl'),'Review {{projectName}} with {{count}} reviewers.');
 const asset=await renderCustomerTemplate(root,{source:'review.tmpl',target:'docs/rigup/customer-review.md',values:{projectName:'Payments',count:2}},['docs/rigup'],'deliver-review');
 assert.equal(asset.content,'Review Payments with 2 reviewers.');assert.equal(asset.consumer,'deliver-review');assert.ok(asset.source.digest);
}));
test('templates preserve external syntax and unknown placeholders while protecting fixed flows',()=>project(async root=>{
 await writeFile(join(root,'review.tmpl'),'{{projectName}} {{count}} {{run.exec}} ${{ secrets.X }}');
 const rendered=await renderCustomerTemplate(root,{source:'review.tmpl',target:'docs/rigup/review.md',values:{count:3}},['docs/rigup'],'review');
 assert.equal(rendered.content,'{{projectName}} 3 {{run.exec}} ${{ secrets.X }}');
 await assert.rejects(renderCustomerTemplate(root,{source:'review.tmpl',target:'../escape.md',values:{projectName:'x'}},['docs/rigup'],'review'),/target/);
 await assert.rejects(renderCustomerTemplate(root,{source:'review.tmpl',target:'.agents/skills/change-deliver/SKILL.md',values:{projectName:'x'}},['.agents/skills'],'review'),/target|flow/);
}));
import {prepareIntegrations,requireRecipeEvidence,selectUpdateVersion,type Recipe} from '../src/integrations/registry.js';
const unverified:Recipe={integrationId:'fixture',kind:'tool',version:'1.0.0',sources:[],evidenceStatus:{source:false,contract:false,live:false}};
test('unverified_recipe_cannot_execute_and_version_change_requires_evidence',()=>{
 assert.throws(()=>requireRecipeEvidence(unverified),/evidence|unverified/);
 const recipe={...unverified,sources:[{url:'https://example.test/source',revision:'commit',verifiedAt:'2026-11-03'}],evidenceStatus:{source:true,contract:false,live:false}};
 assert.throws(()=>requireRecipeEvidence(recipe,'2.0.0'),/version|evidence/);
});
test('ordinary_update_keeps_locked_version',()=>{
 assert.equal(selectUpdateVersion(unverified,'0.9.0'),'0.9.0');
});
test('project Git ignores check results created after preparation',()=>project(async root=>{
 execFileSync('git',['init','-q',root]);
 const options={agents:['codex' as const],backend:'host' as const,mcp:[{id:'docs',agents:['codex' as const],url:'https://example.test/mcp'}]};
 const prepared=await prepareIntegrations(await scanRepository(root,options),options);
 const ignore=prepared.assets.find(asset=>asset.target==='.rigup/.gitignore');
 assert.ok(ignore);
 const result='.rigup/check-results/local.json';
 await mkdir(join(root,'.rigup','check-results'),{recursive:true});
 await writeFile(join(root,ignore.target),ignore.content);
 await writeFile(join(root,result),'{}');
 assert.equal(execFileSync('git',['-C',root,'check-ignore',result],{encoding:'utf8'}).trim(),result);
}));
import {collectCustomSkill} from '../src/integrations/custom-skills.js';
test('custom_skill_copies_resources_without_execution',()=>project(async root=>{
 const {access}=await import('node:fs/promises');
 await mkdir(join(root,'customer/scripts'),{recursive:true});
 await writeFile(join(root,'customer/SKILL.md'),'---\nname: customer-review\ndescription: Review customer concerns\n---\nRead scripts/check.sh when asked.');
 await writeFile(join(root,'customer/scripts/check.sh'),'touch must-not-exist');
 const assets=await collectCustomSkill(join(root,'customer'),'.agents/skills');
 assert.ok(assets.some(asset=>asset.target === '.agents/skills/customer-review/SKILL.md'));
 assert.equal(assets.find(asset=>asset.target.endsWith('scripts/check.sh')).content,'touch must-not-exist');
 await assert.rejects(access(join(root,'must-not-exist')));
}));
test('custom skills accept an explicitly linked directory and reject private key bytes',()=>project(async root=>project(async source=>{
 const {symlink}=await import('node:fs/promises');
 await writeFile(join(source,'SKILL.md'),'---\nname: linked-skill\ndescription: Use linked instructions.\n---\n');
 const linked=join(root,'linked-skill');
 await symlink(source,linked,process.platform==='win32'?'junction':'dir');
 await writeFile(join(source,'sample.txt'),'Normal resource');
 const assets=await collectCustomSkill(linked,'.agents/skills');
 assert.equal(assets.find(asset=>asset.target.endsWith('sample.txt'))?.content,'Normal resource');
 await writeFile(join(source,'sample.txt'),'-----BEGIN PRIVATE KEY-----\nfixture bytes\n-----END PRIVATE KEY-----\n');
 await assert.rejects(collectCustomSkill(linked,'.agents/skills'),/private key material/);
})));
import {prepareCustomerMcp} from '../src/integrations/tools/customer-mcp.js';
test('Codex MCP configuration starts the project command directly',()=>project(async root=>{
 const {parse}=await import('smol-toml');
 const prepared=await prepareCustomerMcp(root,{id:'direct',agents:['codex'],command:{executable:'node',args:['server.mjs'],cwd:'.',envRefs:['TEAM_TOKEN']}});
 assert.equal(prepared.assets.length,1);
 const entry=(parse(prepared.assets[0].content) as any).mcp_servers.direct;
 assert.deepEqual({...entry},{command:'node',args:['server.mjs'],cwd:root,env_vars:['TEAM_TOKEN']});
}));
test('customer_mcp_maps_four_hosts_without_starting_server',()=>project(async root=>{
 const prepared=await prepareCustomerMcp(root,{id:'customer-knowledge',agents:['claude','codex','opencode','omp'],command:{executable:'node',args:['server.mjs'],cwd:'.',envRefs:['TEAM_TOKEN']}});
 assert.equal(prepared.operations.length,0);
 assert.deepEqual(prepared.assets.filter((a:any)=>a.logicalId.startsWith('mcp:')).map((a:any)=>a.target).sort(),['.codex/config.toml','.mcp.json','.omp/mcp.json','opencode.jsonc']);
 const claude=prepared.assets.find((a:any)=>a.target === '.mcp.json');const entry=JSON.parse(claude.content);assert.equal(entry.command,'node');assert.equal(entry.env.TEAM_TOKEN,'${TEAM_TOKEN}');
 assert.ok(prepared.assets.every(a=>a.logicalId.startsWith('mcp:')));
}));
test('native_mcp_config_uses_the_declared_module_cwd',()=>project(async root=>{
 const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');const {readFile}=await import('node:fs/promises');
 const {parse}=await import('smol-toml');
 await mkdir(join(root,'packages/a'),{recursive:true});
 await writeFile(join(root,'packages/a/server.mjs'),"import {writeFileSync} from 'node:fs';writeFileSync('observed.txt',process.cwd());");
 const prepared=await prepareCustomerMcp(root,{id:'fixture',agents:['codex'],command:{executable:process.execPath,args:['server.mjs'],cwd:'packages/a',envRefs:[]}});
 const entry=(parse(prepared.assets[0].content) as any).mcp_servers.fixture;
 await promisify(execFile)(entry.command,entry.args,{cwd:entry.cwd});
 assert.equal(await readFile(join(root,'packages/a/observed.txt'),'utf8'),join(root,'packages/a'));
}));
test('mcp_rejects_embedded_credentials_and_path_escape',()=>project(async root=>{
 await assert.rejects(prepareCustomerMcp(root,{id:'secret',agents:['claude'],url:'https://user:password@example.test/mcp'}),/credentials/);
 await assert.rejects(prepareCustomerMcp(root,{id:'escape',agents:['codex'],command:{executable:'node',args:['x'],cwd:'../outside',envRefs:[]}}),/cwd/);
}));
import {parseUpstreamLock,loadUpstreamLock} from '../src/integrations/registry.js';
test('upstream_lock_has_versioned_sources_and_separate_evidence_levels',async()=>{
 const recipes=await loadUpstreamLock();
 assert.deepEqual(recipes.filter(r=>r.kind === 'agent').map(r=>r.integrationId).sort(),['claude','codex','omp','opencode']);
 for(const recipe of recipes){requireRecipeEvidence(recipe);assert.equal(recipe.evidenceStatus.live,false);}
 assert.throws(()=>parseUpstreamLock({schemaVersion:1,integrations:[{...unverified,version:'latest'}]}),/version|evidence/);
});
import {bindSdd,resolveSkillSource} from '../src/integrations/registry.js';
test('missing_native_entry_fails_binding_for_each_sdd',()=>{
 for(const id of ['superpowers','openspec','spec-kit']) assert.throws(()=>bindSdd(id,'codex',[]),/missing native/);
 const binding=bindSdd('openspec','codex',['openspec-propose','openspec-apply-change','openspec-archive-change']);
 assert.equal(binding.id,'openspec');if(binding.status === 'source-bound') assert.equal(binding.prepare[0],'openspec-propose');else assert.fail('binding pending');
});
test('skill_source_conflicts_require_choice_and_satisfied_source_is_reused',()=>{
 const plugin={name:'review',origin:'plugin' as const,identity:'plugin:review',satisfies:true,digest:'a'};
 assert.equal(resolveSkillSource('review',[plugin]).identity,'plugin:review');
 const local={...plugin,origin:'local' as const,identity:'local:review',digest:'b'};
 assert.throws(()=>resolveSkillSource('review',[plugin,local]),/conflict/);
 assert.equal(resolveSkillSource('review',[plugin,local],'plugin:review').identity,'plugin:review');
 assert.throws(()=>resolveSkillSource('review',[{...plugin,origin:'unknown'}]),/unknown|verify/);
});
test('prepare_plans_protected_tool_initialization_and_rejects_unknown_adapter',()=>project(async root=>{
 const profile=await scanRepository(root,{agents:[],backend:'host'});
 const options={agents:['codex' as const],backend:'host' as const,tools:[{id:'codegraph' as const,install:true,initialize:true,agents:['codex' as const]}]};
 assert.deepEqual((await prepareIntegrations(profile,options)).operations,[],'asset assembly does not prepare npm operations');
 const prepared=await prepareToolFixture(profile,options);
 assert.equal(prepared.operations.filter(op=>op.kind === 'initialize').length,1);assert.equal(prepared.requirements.length,0);
 await assert.rejects(prepareIntegrations(profile,{agents:[],backend:'host',tools:[{id:'model-generated-adapter' as any,install:true,initialize:true,agents:[]}]}),/unsupported|unknown/);
}));
test('multi_agent_openwiki_uses_separate_host_arguments_without_collision',()=>project(async root=>{
 const profile=await scanRepository(root,{agents:[],backend:'host'});
 const prepared=await prepareIntegrations(profile,{agents:['claude','codex'],backend:'host',tools:[{id:'openwiki',install:false,initialize:false,agents:['claude','codex']}]});
 assert.equal(prepared.assets.filter(a=>a.target==='.rigup/tool-mcp.mjs').length,1);
 const {parse}=await import('smol-toml');
 const claude=prepared.assets.find(a=>a.target==='.mcp.json')!;
 const codex=prepared.assets.find(a=>a.target==='.codex/config.toml')!;
 assert.deepEqual(JSON.parse(claude.content).args.slice(-5),['openwiki','path','mcp','--host','claude']);
 assert.deepEqual((parse(codex.content) as any).mcp_servers.openwiki.args.slice(-5),['openwiki','path','mcp','--host','codex']);
}));
test('software_install_requires_new_empty_owned_scope',()=>project(async root=>{
 const profile=await scanRepository(root,{agents:[],backend:'host'});
 const options={agents:['codex' as const],backend:'host' as const,tools:[{id:'codegraph' as const,install:true,initialize:false,agents:['codex' as const]}]};
 let calls=0;const view:typeof fixedNpmView=(...args)=>{calls++;return fixedNpmView(...args);};
 const fresh=await prepareToolFixture(profile,options,view);
 assert.equal(fresh.operations.length,1);assert.equal(fresh.operations[0].kind,'install');
 assert.ok(fresh.operations[0].parameters.args.includes('--ignore-scripts'));
 await mkdir(join(root,'.rigup/tools/codegraph'),{recursive:true});await writeFile(join(root,'.rigup/tools/codegraph/user.txt'),'preserve');
 const blocked=await prepareToolFixture(profile,options,view);assert.equal(blocked.operations.length,0);assert.match(blocked.warnings.join(' '),/existing|nonempty|non-empty/);
 const duplicate=await prepareToolFixture(profile,{...options,tools:[...options.tools,...options.tools]},view);
 assert.match(duplicate.requirements[0].reason,/Duplicate operation/);
 assert.equal(calls,1);
}));
test('selected_project_install_is_the_executable_used_by_mcp after relocation',()=>project(async workspace=>{
 const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');const {readFile,rename}=await import('node:fs/promises');
 const exec=promisify(execFile);
 const {parse}=await import('smol-toml');
 const root=join(workspace,'project with spaces');await mkdir(root);
 const profile=await scanRepository(root,{agents:[],backend:'host'});
 const prepared=await prepareToolFixture(profile,{agents:['codex'],backend:'host',tools:[{id:'codegraph',install:true,initialize:false,agents:['codex']}]});
 const mcp=prepared.assets.find(asset=>asset.target==='.codex/config.toml')!;
 const launcher=prepared.assets.find(asset=>asset.target==='.rigup/tool-mcp.mjs')!;
 const entry=(parse(mcp.content) as any).mcp_servers.codegraph;
 const local=join(workspace,'package with spaces');await mkdir(local);
 await writeFile(join(local,'package.json'),JSON.stringify({name:'@colbymchenry/codegraph',version:'1.6.2',bin:{codegraph:'npm-shim.js'}}));
 await writeFile(join(local,'npm-shim.js'),'#!/usr/bin/env node\nrequire("node:fs").writeFileSync("used-project-tool",JSON.stringify({args:process.argv.slice(2),addedEnvironment:Object.keys(process.env).filter(key=>!globalThis.initialEnvKeys.has(key))}));\n');
 const op=prepared.operations[0];
 const npm=npmCommand([...op.parameters.args.slice(0,-1),local,'--offline','--install-links']);
 await exec(npm.executable,npm.args,{cwd:root});
 assert.equal(entry.command,'node');
 assert.equal(entry.cwd,'.');
 assert.deepEqual(entry.args.slice(2),['--','.codex/config.toml','.rigup/tool-mcp.mjs','codegraph','project','serve','--mcp']);
 await mkdir(join(root,'.codex'));await writeFile(join(root,mcp.target),mcp.content);await writeFile(join(root,launcher.target),launcher.content);
 await mkdir(join(root,'nested'));
 const moved=join(workspace,'迁移 project');await rename(root,moved);
 const preload=join(workspace,'windows-branch.cjs');
 await writeFile(preload,"Object.defineProperty(process,'platform',{value:'win32'});globalThis.initialEnvKeys=new Set(Object.keys(process.env));\n");
 const env={...process.env,NODE_OPTIONS:'--require '+JSON.stringify(preload)};
 await exec(entry.command,entry.args,{cwd:join(moved,'nested',entry.cwd),timeout:10000,env});
 assert.deepEqual(JSON.parse(await readFile(join(moved,'used-project-tool'),'utf8')),{
  args:['serve','--mcp'],addedEnvironment:[]
 });
}));
test('npm_software_recipe_installs_local_fixture_offline_without_lifecycle',()=>project(async root=>{
 const {prepareSoftwareInstall}=await import('./native-tool-fixture.js');const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');const {readFile,access}=await import('node:fs/promises');
 const op=await prepareSoftwareInstall(root,'openwiki','0.7.3');if('pending' in op) throw new Error(op.pending);
 const local=join(root,'local-fixture');await mkdir(local);
 await writeFile(join(local,'package.json'),JSON.stringify({name:'rigup-local-fixture',version:'1.0.0',scripts:{install:'node lifecycle.cjs'}}));
 await writeFile(join(local,'lifecycle.cjs'),'require("node:fs").writeFileSync("lifecycle-ran","yes");');
 const npm=npmCommand([...op.parameters.args.slice(0,-1),local,'--offline','--install-links']);
 await promisify(execFile)(npm.executable,npm.args,{cwd:root,env:Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^npm_/i.test(key)))});
 const installed=join(root,'.rigup/tools/openwiki/node_modules/rigup-local-fixture');
 assert.equal(JSON.parse(await readFile(join(installed,'package.json'),'utf8')).version,'1.0.0');
 await assert.rejects(access(join(installed,'lifecycle-ran')));
}));
test('software_install_canonicalizes_project_alias_before_npm',()=>project(async root=>{
 const {symlink}=await import('node:fs/promises');const {prepareSoftwareInstall}=await import('./native-tool-fixture.js');
 await symlink(root,join(root,'alias'),process.platform==='win32'?'junction':'dir');
 const op=await prepareSoftwareInstall(join(root,'alias'),'openwiki','0.7.3');if('pending' in op) throw new Error(op.pending);
 assert.equal(op.parameters.args[op.parameters.args.indexOf('--prefix')+1],join(root,'.rigup/tools/openwiki'));
}));
test('unchanged_receipted_software_is_reused_without_reinstall',()=>project(async root=>{
 const {prepareSoftwareInstall}=await import('./native-tool-fixture.js');const {createHash}=await import('node:crypto');
 const {readVerifiedToolInstall}=await import('../src/integrations/tools/installed-state.js');
 const {prefix}=await writeNativeToolFixture(root,'openwiki','0.7.3');
 const sri=(content:string)=>'sha512-'+createHash('sha512').update(content).digest('base64');
 const integrity=sri('fixture'),different=sri('different');
 const lock=JSON.stringify({lockfileVersion:3,packages:{'':{dependencies:{openwiki:'0.7.3'}},'node_modules/openwiki':{version:'0.7.3',integrity}}});await writeFile(join(prefix,'package-lock.json'),lock);
 const oldReceipt=(text:string)=>({version:'0.7.3',packageLockDigest:createHash('sha256').update(text).digest('hex')});
 const receipt=oldReceipt(lock);
 const without=await prepareSoftwareInstall(root,'openwiki','0.7.3',integrity);assert.ok('pending' in without);
 const reused=await prepareSoftwareInstall(root,'openwiki','0.7.3',integrity,receipt);assert.equal('reused' in reused && reused.reused,true);
 const identity={version:'0.7.3',packageIntegrity:integrity};
 assert.deepEqual(await readVerifiedToolInstall(root,'openwiki',receipt),identity);
 assert.deepEqual(await readVerifiedToolInstall(root,'openwiki',{...receipt,packageIntegrity:integrity+'?fixture'}),identity);
 for(const packageIntegrity of [different,'','sha512-invalid'])assert.equal(await readVerifiedToolInstall(root,'openwiki',{...receipt,packageIntegrity}),undefined);
 await writeFile(join(prefix,'package-lock.json'),lock+' ');
 const changed=await prepareSoftwareInstall(root,'openwiki','0.7.3',integrity,receipt);assert.ok('pending' in changed);
 const invalid=lock.replace(integrity,'sha512-invalid');await writeFile(join(prefix,'package-lock.json'),invalid);
 assert.equal(await readVerifiedToolInstall(root,'openwiki',oldReceipt(invalid)),undefined);
 assert.equal(await readVerifiedToolInstall(root,'openwiki',{...oldReceipt(invalid),packageIntegrity:'sha512-invalid'}),undefined);
}));
test('external_install_overlap_is_reported_as_manual_not_executable',()=>project(async root=>{
 await writeFile(join(root,'guide.tmpl'),'Customer review guide');
 const profile=await scanRepository(root,{agents:[],backend:'host'});
 let calls=0;
 const prepared=await prepareToolFixture(profile,{agents:['codex'],backend:'host',tools:[{id:'codegraph',install:true,initialize:false,agents:['codex']}],projectConventions:{documentRoutes:{context:'.rigup/tools/codegraph'}},templates:[{source:'guide.tmpl',target:'.rigup/tools/codegraph/customer.md'}]},(...args)=>{calls++;return fixedNpmView(...args);});
 assert.equal(prepared.operations.length,0);assert.match(prepared.requirements.map(r=>r.reason).join(' '),/overlap/);
 assert.equal(calls,0);
}));
test('four_host_mcp_fragments_parse_in_their_declared_formats',()=>project(async root=>{
 const {parse}=await import('smol-toml');
 const prepared=await prepareCustomerMcp(root,{id:'customer',agents:['claude','codex','opencode','omp'],command:{executable:'node',args:['server.mjs'],cwd:'.',envRefs:['TEAM_TOKEN']}});
 for(const asset of prepared.assets.filter(a=>a.logicalId.startsWith('mcp:'))) {
  if(asset.ownership.kind === 'toml-table') {const data=parse(asset.content) as any;assert.deepEqual(data.mcp_servers.customer.env_vars,['TEAM_TOKEN']);}
  else {const data=JSON.parse(asset.content);assert.equal(data.type,asset.target === 'opencode.jsonc' ? 'local' : 'stdio');}
 }
}));
test('mcp_environment_references_use_native_host_expansion_or_require_setup',()=>project(async root=>{
 const command={executable:process.execPath,args:['server.mjs','${RIGUP_TEST_TOKEN}'],cwd:'.',envRefs:['RIGUP_TEST_TOKEN']};
 const prepared=await prepareCustomerMcp(root,{id:'environment-fixture',agents:['claude','codex'],command});
 assert.equal(prepared.assets.length,1);
 assert.deepEqual(JSON.parse(prepared.assets[0].content).args,command.args);
 assert.deepEqual(JSON.parse(prepared.assets[0].content).env,{RIGUP_TEST_TOKEN:'${RIGUP_TEST_TOKEN}'});
 assert.equal(prepared.requirements[0].integrationId,'mcp:codex:environment-fixture');
 assert.match(prepared.requirements[0].reason,/reads environment variables directly/);
 await assert.rejects(prepareCustomerMcp(root,{id:'environment-fixture',agents:['claude'],command:{...command,envRefs:[]}}),/declare each environment reference/);
}));

const nativeMatrix={
 superpowers:{claude:['superpowers:brainstorming','superpowers:writing-plans','superpowers:executing-plans','superpowers:verification-before-completion'],codex:['brainstorming','writing-plans','executing-plans','verification-before-completion'],opencode:['brainstorming','writing-plans','executing-plans','verification-before-completion'],omp:['brainstorming','writing-plans','executing-plans','verification-before-completion']},
 openspec:{claude:['openspec-propose','openspec-apply-change','openspec-archive-change'],codex:['openspec-propose','openspec-apply-change','openspec-archive-change'],opencode:['openspec-propose','openspec-apply-change','openspec-archive-change'],omp:['openspec-propose','openspec-apply-change','openspec-archive-change']},
 'spec-kit':{claude:['speckit-constitution','speckit-specify','speckit-plan','speckit-tasks','speckit-implement','speckit-converge'],codex:['speckit-constitution','speckit-specify','speckit-plan','speckit-tasks','speckit-implement','speckit-converge'],opencode:['speckit.constitution','speckit.specify','speckit.plan','speckit.tasks','speckit.implement','speckit.converge'],omp:['speckit.constitution','speckit.specify','speckit.plan','speckit.tasks','speckit.implement','speckit.converge']},
} as const;
for(const [sdd,hosts] of Object.entries(nativeMatrix))for(const [agent,entries] of Object.entries(hosts)){
 test(`${agent} × ${sdd} binds all native stages and renders three host references`,()=>project(async root=>{
  const {renderFixed}=await import('../src/generator/render.js');
  const {setNativeEntries}=await import('./helpers.js');
  const options={agents:[agent as import('../src/types.js').Agent],backend:'host' as const,sdd:sdd as import('../src/types.js').SetupOptions['sdd']};
  const profile=await scanRepository(root,{agents:[],backend:'host'});
  setNativeEntries(profile,{[agent]:[...entries]});
  const binding=bindSdd(sdd,agent,[...entries]);
  assert.equal(binding.status,'source-bound');
  assert.deepEqual([...binding.prepare,...binding.deliver],entries);
  const prepared=await prepareIntegrations(profile,options);
  assert.deepEqual(prepared.requirements,[]);
  const assets=await renderFixed(profile,options,prepared,[],[]);
  const refs=assets.filter(asset=>/change-(prepare|ready|deliver)\/references\/project.md$/.test(asset.target));
  assert.equal(refs.length,3);
  for(const reference of refs)for(const entry of entries)assert.ok(reference.content.includes(entry),`${reference.target}: ${entry}`);
 }));
 test(`${agent} × ${sdd} reports missing native entry for an empty installation`,()=>{
  assert.throws(()=>bindSdd(sdd,agent,[]),/missing native entry:/);
 });
}
test('multi-host binding requirements identify the failing host and a repair action',()=>project(async root=>{
 const {setNativeEntries}=await import('./helpers.js');
 const options={agents:['claude','omp'] as const,backend:'host' as const,sdd:'superpowers' as const};
 const profile=await scanRepository(root,{agents:[],backend:'host'});
 setNativeEntries(profile,{claude:[...nativeMatrix.superpowers.claude]});
 const prepared=await prepareIntegrations(profile,{...options,agents:[...options.agents]});
 assert.equal(prepared.bindings.length,1);
 assert.equal(prepared.requirements.length,1);
 assert.equal(prepared.requirements[0].kind,'sdd-binding');
 assert.equal(prepared.requirements[0].agent,'omp');
 assert.match(prepared.requirements[0].reason,/omp.*missing native entry:/);
 assert.ok(prepared.requirements[0].nextCommand);
}));

test('Spec Kit repair distinguishes first initialization, host addition and broken native project files',()=>project(async root=>{
 const options={agents:['omp' as const],backend:'host' as const,sdd:'spec-kit' as const};
 let prepared=await prepareIntegrations(await scanRepository(root,options),options);
 assert.match(prepared.requirements[0].nextCommand!,/specify init --here --integration omp/);
 assert.match(prepared.requirements[0].reason,/uvx|uv tool install/);
 await mkdir(join(root,'.specify/memory'),{recursive:true});await writeFile(join(root,'.specify/memory/constitution.md'),'User governance');
 prepared=await prepareIntegrations(await scanRepository(root,options),options);
 assert.match(prepared.requirements[0].nextCommand!,/specify integration install omp/);
 for(const name of ['constitution','specify','plan','tasks','implement','converge']){await mkdir(join(root,'.omp/commands'),{recursive:true});await writeFile(join(root,'.omp/commands','speckit.'+name+'.md'),'Read .specify/scripts/bash/setup-plan.sh');}
 prepared=await prepareIntegrations(await scanRepository(root,options),options);
 assert.match(prepared.requirements[0].reason,/restore|repair/i);assert.match(prepared.requirements[0].reason,/setup-plan.sh/);
}));

test('registered damaged Spec Kit uses native upgrade and OpenSpec source conflict never suggests specify',()=>project(async root=>{
 await mkdir(join(root,'.specify'),{recursive:true});await writeFile(join(root,'.specify/integration.json'),JSON.stringify({version:'1.3.2',integration_state_schema:1,installed_integrations:['omp'],integration:'omp',default_integration:'omp'}));
 const options={agents:['omp' as const],backend:'host' as const,sdd:'spec-kit' as const};
 const repair=await prepareIntegrations(await scanRepository(root,options),options);assert.match(repair.requirements[0].nextCommand!,/specify integration upgrade omp/);
 const osOptions={...options,sdd:'openspec' as const};const profile=await scanRepository(root,{agents:[],backend:'host'});
 const {setNativeEntries}=await import('./helpers.js');setNativeEntries(profile,{omp:['openspec-propose','openspec-apply-change','openspec-archive-change']});profile.skillSources!.omp!.push({...profile.skillSources!.omp![0],identity:'different',digest:'different'});
 const conflict=await prepareIntegrations(profile,osOptions);assert.match(conflict.requirements[0].reason,/conflict/);assert.doesNotMatch(JSON.stringify(conflict.requirements),/specify/);
}));
