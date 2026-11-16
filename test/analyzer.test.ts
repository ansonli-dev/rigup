import {test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {project} from './helpers.js';
import {readEvidence} from '../src/analyzer/evidence.js';
test('embedded_credentials_are_filtered_and_line_mapping_kept',()=>project(async root=>{
 await writeFile(join(root,'config.json'),'{\n "token": "secret-fixture",\n "url": "https://alice:secret-pass@example.test/api"\n}\n');
 const result=await readEvidence(root,'config.json',1,4);
 assert.doesNotMatch(result.content,/secret-fixture|secret-pass|alice/);
 assert.equal(result.evidence.startLine,1);assert.equal(result.evidence.endLine,4);
 assert.equal(result.evidence.digest,createHash('sha256').update(result.content).digest('hex'));
 assert.equal(result.content.split('\n').length,4);
}));
test('unknown_sensitive_format_is_denied',()=>project(async root=>{
 await writeFile(join(root,'auth.custom'),'token = secret-value');
 await assert.rejects(readEvidence(root,'auth.custom',1,1),/sensitive|unsupported/);
}));
test('jsonc_credentials_are_filtered',()=>project(async root=>{
 await writeFile(join(root,'config.jsonc'),'{// comment\n "env": {"TOKEN":"inline-secret"}, "name":"tool"\n}');
 const result=await readEvidence(root,'config.jsonc',1,3);
 assert.doesNotMatch(result.content,/inline-secret/);assert.match(result.content,/tool/);
}));
test('toml_sensitive_env_and_multiline_values_are_filtered',()=>project(async root=>{
 await writeFile(join(root,'config.toml'),'name = "tool"\n[env]\nTOKEN = "inline-secret"\nPASSWORD = """multi\nline-secret"""\n');
 const result=await readEvidence(root,'config.toml',1,5);
 assert.doesNotMatch(result.content,/inline-secret|line-secret|multi/);assert.match(result.content,/tool/);
 assert.equal(result.content.split('\n').length,5);
}));
test('numeric_credentials_and_yaml_aliases_cannot_bypass_filter',()=>project(async root=>{
 await writeFile(join(root,'config.json'),' {"password":123456789} ');
 assert.doesNotMatch((await readEvidence(root,'config.json',1,1)).content,/123456789/);
 await writeFile(join(root,'config.yaml'),'shared: &value hidden-secret\ntoken: *value\n');
 await assert.rejects(readEvidence(root,'config.yaml',1,2),/alias|unsupported/);
}));
test('ordinary_guidance_about_credentials_remains_readable',()=>project(async root=>{
 await writeFile(join(root,'TEAM.md'),'Keep API tokens in environment variables. Never log passwords.\n');
 assert.match((await readEvidence(root,'TEAM.md',1,1)).content,/environment variables/);
}));

import {mkdir,symlink,rm} from 'node:fs/promises';
import {dirname} from 'node:path';
import {scanRepository} from '../src/analyzer/repository.js';
import {prepareIntegrations} from '../src/integrations/registry.js';
const officialOpenCodePlugin=await readFile(new URL('./fixtures/native/superpowers-opencode-v7.0.2.js',import.meta.url),'utf8');
const powers=['brainstorming','writing-plans','executing-plans','verification-before-completion'];
async function nativePut(path:string,text:string){await mkdir(dirname(path),{recursive:true});await writeFile(path,text);}
async function nativeSkills(path:string,body='Preserve native gates.'){
 for(const name of powers)await nativePut(join(path,name,'SKILL.md'),`---\nname: ${name}\ndescription: Native workflow\n---\n${body}\n`);
}
const nativeOptions=(agent:import('../src/types.js').Agent)=>({agents:[agent],backend:'host' as const,sdd:'superpowers' as const});
test('Claude local scope uses canonical project and freezes selected manifest identity',()=>project(root=>project(async home=>{
 const base=join(home,'.claude/plugins/cache/official/superpowers/7.0.2');
 await nativeSkills(join(base,'skills'));await nativePut(join(base,'.claude-plugin/plugin.json'),'{"name":"superpowers","version":"7.0.2"}');
 await nativePut(join(home,'.claude/settings.json'),'{"enabledPlugins":{"superpowers@official":true}}');
 await symlink(root,join(home,'project-alias'),'dir');
 await nativePut(join(home,'.claude/plugins/installed_plugins.json'),JSON.stringify({plugins:{'superpowers@official':[{scope:'local',projectPath:join(home,'project-alias'),installPath:base}]}}));
 const before=await scanRepository(root,nativeOptions('claude'),{home});
 assert.equal((await prepareIntegrations(before,nativeOptions('claude'))).bindings.length,1);
 await nativePut(join(base,'.claude-plugin/plugin.json'),'{"name":"superpowers","version":"7.0.3"}');
 assert.notEqual((await scanRepository(root,nativeOptions('claude'),{home})).fingerprint,before.fingerprint);
 await rm(join(base,'skills/brainstorming'),{recursive:true});
 await symlink(join(home,'external'),join(base,'skills/brainstorming'),'dir');
 await nativeSkills(join(home,'external'));
 assert.ok(!(await scanRepository(root,nativeOptions('claude'),{home})).nativeEntries?.claude?.includes('superpowers:brainstorming'));
})));
test('Codex chooses local before versions and never falls back from its invalid active directory',()=>project(root=>project(async home=>{
 const cache=join(home,'.codex/plugins/cache/official/superpowers');
 for(const version of ['7.0.2','7.0.10']){await nativeSkills(join(cache,version,'skills'),version);await nativePut(join(cache,version,'.claude-plugin/plugin.json'),'{"name":"superpowers"}');}
 await nativePut(join(home,'.codex/config.toml'),'[plugins."superpowers@official"]\nenabled=true\n');
 let profile=await scanRepository(root,nativeOptions('codex'),{home});
 assert.equal(profile.skillSources?.codex?.length,4);
 assert.ok(profile.skillSources?.codex?.every(source=>source.identity.includes('/7.0.10/')));
 await mkdir(join(cache,'local'),{recursive:true});
 profile=await scanRepository(root,nativeOptions('codex'),{home});
 assert.ok(!profile.nativeEntries?.codex?.length);
})));
for(const mode of ['npm','link'] as const)test(`OMP enabled ${mode} package is source-bound and freezes its manifest`,()=>project(root=>project(async home=>{
 const plugins=join(home,'.omp/plugins'),name='@loneexile/omp-superpowers';
 const base=mode==='link'?join(home,'linked-superpowers'):join(plugins,'node_modules',name);
 await nativeSkills(join(base,'skills'));await nativePut(join(base,'package.json'),JSON.stringify({name,version:'1.0.0',omp:{skills:['skills']}}));
 await nativePut(join(plugins,'package.json'),JSON.stringify({dependencies:mode==='npm'?{[name]:'1.0.0'}:{}}));
 await nativePut(join(plugins,'omp-plugins.lock.json'),JSON.stringify({plugins:{[name]:{enabled:true}}}));
 if(mode==='link'){await mkdir(dirname(join(plugins,'node_modules',name)),{recursive:true});await symlink(base,join(plugins,'node_modules',name),'dir');}
 const before=await scanRepository(root,nativeOptions('omp'),{home});
 const prepared=await prepareIntegrations(before,nativeOptions('omp'));assert.equal(prepared.bindings.length,1);
 assert.deepEqual(prepared.bindings[0].artifacts,['docs/specs','docs/plans']);
 assert.ok(before.skillSources?.omp?.every(source=>source.packageName===name));
 await nativePut(join(base,'package.json'),JSON.stringify({name,version:'1.0.1',omp:{skills:['skills']}}));
 assert.notEqual((await scanRepository(root,nativeOptions('omp'),{home})).fingerprint,before.fingerprint);
 await nativePut(join(root,'.omp/plugin-overrides.json'),JSON.stringify({disabled:[name]}));
 assert.ok(!(await scanRepository(root,nativeOptions('omp'),{home})).nativeEntries?.omp?.length);
})));
test('OMP project npm package shadows user package and stale undeclared cache is ignored',()=>project(root=>project(async home=>{
 for(const [base,body] of [[join(home,'.omp/plugins'),'user'],[join(root,'.omp/plugins'),'project']]){
  await nativePut(join(base,'package.json'),'{"dependencies":{"omp-superpowers":"1.0.0"}}');
  await nativePut(join(base,'node_modules/omp-superpowers/package.json'),'{"name":"omp-superpowers","omp":{"skills":["skills"]}}');await nativeSkills(join(base,'node_modules/omp-superpowers/skills'),body);
 }
 let profile=await scanRepository(root,nativeOptions('omp'),{home});assert.equal(profile.skillSources?.omp?.length,4);
 assert.ok(profile.skillSources?.omp?.every(source=>source.identity.startsWith(join(root,'.omp/plugins'))));
 await nativePut(join(root,'.omp/plugins/package.json'),'{"dependencies":{}}');
 profile=await scanRepository(root,nativeOptions('omp'),{home});assert.ok(profile.skillSources?.omp?.every(source=>source.identity.startsWith(home)));
})));
test('OMP Marketplace override, provider opt-in and project-disabled fallback match host scopes',()=>project(root=>project(async home=>{
 const claude=join(home,'.claude'),omp=join(home,'.omp/plugins'),base=join(claude,'plugins/cache/official/superpowers/7');
 await nativeSkills(join(base,'skills'));await nativePut(join(base,'.claude-plugin/plugin.json'),'{"name":"superpowers"}');
 const record={scope:'user',installPath:base};
 await nativePut(join(claude,'plugins/installed_plugins.json'),JSON.stringify({plugins:{'superpowers@official':[record]}}));
 await nativePut(join(home,'.omp/agent/settings.json'),'{"enabledProviders":["claude-plugins"]}');
 assert.equal((await scanRepository(root,nativeOptions('omp'),{home})).skillSources?.omp?.length,4);
 await nativePut(join(omp,'installed_plugins.json'),JSON.stringify({plugins:{'superpowers@official':[{...record,enabled:false}]}}));
 assert.ok(!(await scanRepository(root,nativeOptions('omp'),{home})).nativeEntries?.omp?.length);
 await nativePut(join(omp,'installed_plugins.json'),JSON.stringify({plugins:{'superpowers@official':[record]}}));
 await nativePut(join(home,'.omp/agent/settings.json'),'{"skills":{"enableClaudeUser":false}}');
 await nativePut(join(root,'.omp/plugins/installed_plugins.json'),JSON.stringify({plugins:{'superpowers@official':[{...record,enabled:false}]}}));
 assert.equal((await scanRepository(root,nativeOptions('omp'),{home})).skillSources?.omp?.length,4);
 await nativePut(join(home,'.omp/agent/settings.json'),'{"skills":{"enabled":false}}');
 const disabled=await prepareIntegrations(await scanRepository(root,nativeOptions('omp'),{home}),nativeOptions('omp'));
 assert.match(disabled.requirements[0].reason,/skills.enabled/);
})));

for(const version of [1,2])test(`OpenCode V${version} only binds enabled current official plugin and freezes its entry`,()=>project(root=>project(async home=>{
 const spec='git+https://github.com/obra/superpowers.git#v7.0.2';
 const cache=join(home,'.cache/opencode');
 const packageRoot=version===1?join(cache,'packages',spec,'node_modules/superpowers'):join(cache,'npm','git-superpowers-'+createHash('sha256').update(spec).digest('hex').slice(0,12),'20/node_modules/superpowers');
 await nativeSkills(join(packageRoot,'skills'));
 await nativePut(join(packageRoot,'package.json'),JSON.stringify({name:'superpowers',version:'7.0.2',main:'.opencode/plugins/superpowers.js'}));
 await nativePut(join(packageRoot,'.opencode/plugins/superpowers.js'),officialOpenCodePlugin);
 const config=join(home,'.config/opencode/opencode.json');
 await nativePut(config,JSON.stringify(version===1?{plugin:[spec]}:{plugins:[spec]}));
 const options=nativeOptions('opencode');
 const first=await scanRepository(root,options,{home});assert.equal((await prepareIntegrations(first,options)).bindings.length,1);
 assert.deepEqual(first.nativeEntries?.opencode?.sort(),[...powers].sort());
 await nativePut(join(packageRoot,'.opencode/plugins/superpowers.js'),'// changed loader\n'+(officialOpenCodePlugin));
 assert.notEqual((await scanRepository(root,options,{home})).fingerprint,first.fingerprint);
 if(version===2){
  await nativePut(join(root,'opencode.jsonc'),'{"plugins":["-superpowers"]}');
  assert.ok(!(await scanRepository(root,options,{home})).nativeEntries?.opencode?.length);
  await nativePut(join(root,'opencode.jsonc'),'{"plugins":[]}');
  await mkdir(join(dirname(dirname(packageRoot)),'21'),{recursive:true});
  // A new incomplete generation wins over the older complete installation.
  await mkdir(join(cache,'npm','git-superpowers-'+createHash('sha256').update(spec).digest('hex').slice(0,12),'21'),{recursive:true});
 }else await nativePut(config,'{"plugin":[]}');
 assert.ok(!(await scanRepository(root,options,{home})).nativeEntries?.opencode?.length);
})));
test('OpenCode V2 skill IDs use paths, flat files and effective permissions',()=>project(root=>project(async home=>{
 await nativePut(join(home,'.config/opencode/opencode.json'),'{"plugins":[]}');
 await nativePut(join(home,'.agents/skills/brainstorming/SKILL.md'),'---\nname: Old display\ndescription: Shared\n---\nold');
 await nativePut(join(root,'.opencode/skills/brainstorming.md'),'---\nname: Display only\ndescription: Project\n---\nselected');
 await nativeSkills(join(root,'.opencode/skills'));
 await rm(join(root,'.opencode/skills/brainstorming'),{recursive:true});
 let profile=await scanRepository(root,nativeOptions('opencode'),{home});
 assert.equal(profile.skillSources?.opencode?.filter(source=>source.name==='brainstorming').length,1);
 assert.equal(profile.skillSources?.opencode?.find(source=>source.name==='brainstorming')?.identity,'.opencode/skills/brainstorming.md');
 await nativePut(join(root,'opencode.jsonc'),'{"permission":{"skill":{"brainstorming":"deny"}}}');
 profile=await scanRepository(root,nativeOptions('opencode'),{home});
 assert.equal((await prepareIntegrations(profile,nativeOptions('opencode'))).bindings.length,0);
})));
for(const version of [1,2])test(`OpenCode V${version} custom config directory follows append versus replacement precedence`,()=>project(root=>project(async home=>{
 const defaultDir=join(home,'.config/opencode'),custom=join(home,'custom');
 await nativeSkills(join(defaultDir,'skills'));await nativePut(join(defaultDir,'opencode.json'),JSON.stringify(version===1?{plugin:[]}:{plugins:[]}));
 await nativePut(join(custom,'opencode.json'),JSON.stringify(version===1?{plugin:[]}:{plugins:[]}));
 const profile=await scanRepository(root,nativeOptions('opencode'),{home,env:{OPENCODE_CONFIG_DIR:custom}});
 assert.equal(profile.skillSources?.opencode?.length??0,version===1?4:0);
})));
test('OpenCode native singular commands are discovered and JSONC command override is selected',()=>project(root=>project(async home=>{
 const options={agents:['opencode' as const],backend:'host' as const,sdd:'spec-kit' as const};
 for(const name of ['constitution','specify','plan','tasks','implement','converge'])await nativePut(join(root,'.opencode/command',`speckit.${name}.md`),'Native command');
 const first=await scanRepository(root,options,{home});assert.equal(first.nativeEntries?.opencode?.length,6);
 await nativePut(join(root,'opencode.jsonc'),'{"command":{"speckit.plan":{"template":"Project override"}}}');
 const overridden=await scanRepository(root,options,{home});
 const source=overridden.skillSources?.opencode?.find(source=>source.name==='speckit.plan');
 assert.ok(source?.identity.includes('opencode.jsonc'));assert.notEqual(source?.digest,first.skillSources?.opencode?.find(source=>source.name==='speckit.plan')?.digest);
})));

test('OMP YAML settings disable native calls even while Spec Kit file commands remain visible',()=>project(root=>project(async home=>{
 for(const name of ['constitution','specify','plan','tasks','implement','converge'])await nativePut(join(root,'.omp/commands',`speckit.${name}.md`),'Native command');
 await nativePut(join(home,'.omp/agent/config.yml'),'skills:\n  enabled: false\nenableSkillCommands: false\n');
 const options={agents:['omp' as const],backend:'host' as const,sdd:'spec-kit' as const};
 const prepared=await prepareIntegrations(await scanRepository(root,options,{home}),options);
 assert.equal(prepared.bindings.length,0);assert.match(prepared.requirements[0].reason,/skills.enabled/);
})));
test('OMP npm plugin conventional skills load without skills manifest and entry replacement invalidates',()=>project(root=>project(async home=>{
 const plugins=join(home,'.omp/plugins'),base=join(plugins,'node_modules/omp-superpowers');
 await nativePut(join(plugins,'package.json'),'{"dependencies":{"omp-superpowers":"0.1.0"}}');
 await nativePut(join(base,'package.json'),'{"name":"omp-superpowers","omp":{"extensions":["./extensions/superpowers.ts"]}}');
 await nativePut(join(base,'extensions/superpowers.ts'),'export default function() {}');await nativeSkills(join(base,'skills'));
 const before=await scanRepository(root,nativeOptions('omp'),{home});assert.equal(before.skillSources?.omp?.length,4);
 await nativePut(join(base,'extensions/superpowers.ts'),'export default function() { return 1; }');
 assert.notEqual((await scanRepository(root,nativeOptions('omp'),{home})).fingerprint,before.fingerprint);
 await rm(join(base,'extensions/superpowers.ts'));assert.ok(!(await scanRepository(root,nativeOptions('omp'),{home})).nativeEntries?.omp?.length);
})));
for(const script of ['bash/setup-plan.sh','powershell/setup-plan.ps1','python/setup-plan.py'])test(`Spec Kit validates ${script} and templates read-only and freezes dependency bytes`,()=>project(root=>project(async home=>{
 const options={agents:['codex' as const],backend:'host' as const,sdd:'spec-kit' as const};
 for(const name of ['constitution','specify','plan','tasks','implement','converge'])await nativePut(join(home,'.agents/skills','speckit-'+name,'SKILL.md'),`---\nname: speckit-${name}\ndescription: Native workflow\n---\nRead .specify/scripts/${script} and .specify/templates/plan-template.md.\n`);
 let prepared=await prepareIntegrations(await scanRepository(root,options,{home}),options);
 assert.equal(prepared.bindings.length,0);assert.match(prepared.requirements[0].reason,/constitution/);
 await nativePut(join(root,'.specify/memory/constitution.md'),'Keep approved governance.');
 await nativePut(join(root,'.specify/scripts',script),'touch must-not-exist');
 prepared=await prepareIntegrations(await scanRepository(root,options,{home}),options);assert.equal(prepared.bindings.length,0);assert.match(prepared.requirements[0].reason,/plan-template/);
 await nativePut(join(root,'.specify/templates/plan-template.md'),'Native plan template');
 const before=await scanRepository(root,options,{home});assert.equal((await prepareIntegrations(before,options)).bindings.length,1);
 await nativePut(join(root,'.specify/scripts',script),'touch still-must-not-exist');
 assert.notEqual((await scanRepository(root,options,{home})).fingerprint,before.fingerprint);
 await assert.rejects(import('node:fs/promises').then(fs=>fs.access(join(root,'must-not-exist'))));
 await nativePut(join(root,'.specify/extensions.yml'),'hooks:\n  before_plan:\n    - extension: checks\n      command: speckit.checks.verify\n      optional: false\n');
 prepared=await prepareIntegrations(await scanRepository(root,options,{home}),options);assert.equal(prepared.bindings.length,0);assert.match(prepared.requirements[0].reason,/speckit.checks.verify/);
 await nativePut(join(root,'.specify/extensions.yml'),'hooks:\n  before_plan:\n    - extension: checks\n      command: speckit.checks.verify\n      condition: dynamic_native_condition\n      optional: false\n');
 assert.equal((await prepareIntegrations(await scanRepository(root,options,{home}),options)).bindings.length,1);
})));

test('Spec Kit current template resolver permits absent override and hashes only selected template layers',()=>project(root=>project(async home=>{
 const options={agents:['omp' as const],backend:'host' as const,sdd:'spec-kit' as const};
 for(const name of ['constitution','specify','plan','tasks','implement','converge'])await nativePut(join(root,'.omp/commands',`speckit.${name}.md`),'Run .specify/scripts/bash/setup-tasks.sh');
 await nativePut(join(root,'.specify/memory/constitution.md'),'Governance');
 await nativePut(join(root,'.specify/scripts/bash/setup-tasks.sh'),'source "$SCRIPT_DIR/common.sh"\nTASKS_TEMPLATE=$(resolve_template "tasks-template" "$REPO_ROOT")\necho "Add .specify/templates/overrides/tasks-template.md or restore .specify/templates/tasks-template.md"');
 await nativePut(join(root,'.specify/scripts/bash/common.sh'),'# common functions');
 await nativePut(join(root,'.specify/templates/tasks-template.md'),'Core tasks template');
 const first=await scanRepository(root,options,{home});assert.equal((await prepareIntegrations(first,options)).bindings.length,1);
 await nativePut(join(root,'.specify/templates/overrides/tasks-template.md'),'Project override');
 const changed=await scanRepository(root,options,{home});assert.notEqual(changed.fingerprint,first.fingerprint);assert.equal((await prepareIntegrations(changed,options)).bindings.length,1);
 await rm(join(root,'.specify/templates/tasks-template.md'));
 assert.equal((await prepareIntegrations(await scanRepository(root,options,{home}),options)).bindings.length,1);
})));
test('Claude personal skills shadow project bare names without conflicting with distinct plugin namespace',()=>project(root=>project(async home=>{
 await nativeSkills(join(root,'.claude/skills'),'project');await nativeSkills(join(home,'.claude/skills'),'personal');
 const profile=await scanRepository(root,nativeOptions('claude'),{home});
 assert.equal(profile.skillSources?.claude?.length,4);assert.ok(profile.skillSources?.claude?.every(source=>source.identity.startsWith(home)));
 const {resolveSddBinding}=await import('../src/integrations/sdd/binding.js');
 const plugin=profile.skillSources!.claude!.map(source=>({...source,name:'superpowers:'+source.name,digest:'different'}));
 const all=[...profile.skillSources!.claude!,...plugin];
 assert.equal(resolveSddBinding('superpowers','claude',all.map(source=>source.name),all,[]).binding.status,'source-bound');
})));

test('OpenCode V2 removes the registered plugin ID rather than an incidental skill ID',()=>project(root=>project(async home=>{
 const base=join(home,'superpowers');await nativeSkills(join(base,'skills'));
 await nativePut(join(base,'package.json'),'{"name":"superpowers","main":".opencode/plugins/superpowers.js"}');
 await nativePut(join(base,'.opencode/plugins/superpowers.js'),'// example id: "brainstorming"\n'+officialOpenCodePlugin.replace("id: 'superpowers'","id: 'registered-superpowers'"));
 await nativePut(join(home,'.config/opencode/opencode.json'),JSON.stringify({plugins:[{package:base}]}));
 const enabled=await scanRepository(root,nativeOptions('opencode'),{home});assert.equal(enabled.skillSources?.opencode?.length,4);
 await nativePut(join(root,'opencode.jsonc'),'{"plugins":["-registered-superpowers"]}');
 assert.ok(!(await scanRepository(root,nativeOptions('opencode'),{home})).nativeEntries?.opencode?.length);
 await nativePut(join(root,'opencode.jsonc'),JSON.stringify({policies:[{action:'integration.use',resource:'plugin:'+base,effect:'deny'}]}));
 assert.ok(!(await scanRepository(root,nativeOptions('opencode'),{home})).nativeEntries?.opencode?.length);
})));

for(const version of [1,2])test(`OpenCode V${version} does not treat a no-op plugin or nested skill as a registration`,()=>project(root=>project(async home=>{
 const base=join(home,'superpowers'),entry=join(base,'.opencode/plugins/superpowers.js');
 await nativePut(join(base,'package.json'),'{"name":"superpowers","main":".opencode/plugins/superpowers.js"}');await nativeSkills(join(base,'skills'));
 await nativePut(entry,'export const SuperpowersPlugin=async()=>({}); export default {id:"superpowers",setup(){}};');
 await nativePut(join(home,'.config/opencode/opencode.json'),JSON.stringify(version===1?{plugin:[entry]}:{plugins:[base]}));
 assert.ok(!(await scanRepository(root,nativeOptions('opencode'),{home})).nativeEntries?.opencode?.length);
 await nativePut(entry,officialOpenCodePlugin);
 assert.equal((await scanRepository(root,nativeOptions('opencode'),{home})).nativeEntries?.opencode?.length,4);
 if(version===2){await nativePut(join(base,'package.json'),'{"name":"superpowers","main":"noop.js"}');await nativePut(join(base,'noop.js'),'export default {id:"superpowers",setup(){}}');assert.ok(!(await scanRepository(root,nativeOptions('opencode'),{home})).nativeEntries?.opencode?.length);await nativePut(join(base,'package.json'),'{"name":"superpowers","main":".opencode/plugins/superpowers.js"}');}
 await mkdir(join(base,'skills/nested'));await import('node:fs/promises').then(fs=>fs.rename(join(base,'skills/brainstorming'),join(base,'skills/nested/brainstorming')));
 assert.ok(!(await scanRepository(root,nativeOptions('opencode'),{home})).nativeEntries?.opencode?.includes('brainstorming'));
})));
test('OpenCode official linked local plugin is discovered from its autoload directory',()=>project(root=>project(async home=>{
 const base=join(home,'.config/opencode/superpowers'),entry=join(base,'.opencode/plugins/superpowers.js');
 await nativePut(join(base,'package.json'),'{"name":"superpowers","main":".opencode/plugins/superpowers.js"}');await nativePut(entry,officialOpenCodePlugin);await nativeSkills(join(base,'skills'));
 await mkdir(join(home,'.config/opencode/plugins'));await symlink(entry,join(home,'.config/opencode/plugins/superpowers.js'));
 assert.equal((await scanRepository(root,nativeOptions('opencode'),{home})).nativeEntries?.opencode?.length,4);
})));
for(const filter of [{enablePiProject:false},{ignoredSkills:['change-*']},{includeSkills:['brain*','writing-*','executing-*','verification-*']}])test(`OMP wrapper availability honors ${JSON.stringify(filter)}`,()=>project(root=>project(async home=>{
 await nativeSkills(join(root,'.omp/skills'));
 await nativePut(join(root,'.omp/config.yml'),'skills: '+JSON.stringify(filter));
 const prepared=await prepareIntegrations(await scanRepository(root,nativeOptions('omp'),{home}),nativeOptions('omp'));
 assert.equal(prepared.bindings.length,0);assert.match(prepared.requirements[0].reason,/OMP.*(?:project|skill|change-)/);
})));
test('OMP native user toggle and glob filters apply before enabled project source precedence',()=>project(root=>project(async home=>{
 await nativeSkills(join(home,'.omp/agent/skills'),'user');await nativeSkills(join(root,'.omp/skills'),'project');
 await nativePut(join(home,'.omp/agent/config.yml'),'skills:\n  enablePiUser: false\n  ignoredSkills: ["brain*"]\n');
 let profile=await scanRepository(root,nativeOptions('omp'),{home});
 assert.ok(!profile.skillSources?.omp?.some(source=>source.identity.startsWith(home)||source.name==='brainstorming'));
 await nativePut(join(root,'.omp/config.yml'),'skills:\n  ignoredSkills: []\n');
 profile=await scanRepository(root,nativeOptions('omp'),{home});assert.equal(profile.skillSources?.omp?.length,4);assert.ok(profile.skillSources?.omp?.every(source=>!source.identity.startsWith(home)));
})));
test('OpenCode inline Spec Kit command dependencies supersede the safe markdown decoy',()=>project(root=>project(async home=>{
 const options={agents:['opencode' as const],backend:'host' as const,sdd:'spec-kit' as const};
 for(const name of ['constitution','specify','plan','tasks','implement','converge'])await nativePut(join(root,'.opencode/commands',`speckit.${name}.md`),'Safe decoy');
 await nativePut(join(root,'.specify/memory/constitution.md'),'Governance');
 await nativePut(join(root,'opencode.jsonc'),'{"command":{"speckit.plan":{"template":"Run .specify/scripts/bash/selected-plan.sh"}}}');
 const prepared=await prepareIntegrations(await scanRepository(root,options,{home}),options);
 assert.equal(prepared.bindings.length,0);assert.match(prepared.requirements[0].reason,/selected-plan.sh/);
})));
for(const input of ['null','[]','"text"'])test(`malformed manager structure ${input} cannot crash unrelated native bindings`,()=>project(root=>project(async home=>{
 await nativeSkills(join(root,'.claude/skills'));await nativeSkills(join(root,'.opencode/skills'));
 await nativePut(join(home,'.claude/settings.json'),input);
 const options={agents:['claude','opencode'] as import('../src/types.js').Agent[],backend:'host' as const,sdd:'superpowers' as const};
 const profile=await scanRepository(root,options,{home,env:{OPENCODE_CONFIG_CONTENT:input}});
 assert.equal((await prepareIntegrations(profile,options)).bindings.length,2);
})));
test('invalid OpenCode file URL cannot crash independent Claude binding',()=>project(root=>project(async home=>{
 await nativeSkills(join(root,'.claude/skills'));
 await nativePut(join(root,'opencode.json'),'{"plugin":["file://untrusted.invalid/plugin.js"]}');
 const options={agents:['claude','opencode'] as import('../src/types.js').Agent[],backend:'host' as const,sdd:'superpowers' as const};
 const prepared=await prepareIntegrations(await scanRepository(root,options,{home}),options);assert.ok(prepared.bindings.some(binding=>binding.agent==='claude'));assert.ok((prepared.requirements??[]).every(requirement=>requirement.agent!=='claude'));
})));

for(const language of ['powershell','python'])test(`Spec Kit verifies actual ${language} helper and template source shapes`,()=>project(root=>project(async home=>{
 const options={agents:['omp' as const],backend:'host' as const,sdd:'spec-kit' as const};
 const file=language==='powershell'?'setup-plan.ps1':'setup_plan.py';
 for(const name of ['constitution','specify','plan','tasks','implement','converge'])await nativePut(join(root,'.omp/commands',`speckit.${name}.md`),`Run .specify/scripts/${language}/${file}`);
 await nativePut(join(root,'.specify/memory/constitution.md'),'Governance');
 await nativePut(join(root,'.specify/scripts',language,file),language==='powershell'?`. "$PSScriptRoot/common.ps1"\n$content = Resolve-TemplateContent -TemplateName 'plan-template' -RepoRoot $REPO_ROOT`:`from common import resolve_template_content\ncontent = resolve_template_content("plan-template", repo_root)`);
 let prepared=await prepareIntegrations(await scanRepository(root,options,{home}),options);assert.equal(prepared.bindings.length,0);assert.match(prepared.requirements[0].reason,/common/);
 await nativePut(join(root,'.specify/scripts',language,language==='powershell'?'common.ps1':'common.py'),'# Native common functions');
 prepared=await prepareIntegrations(await scanRepository(root,options,{home}),options);assert.equal(prepared.bindings.length,0);assert.match(prepared.requirements[0].reason,/plan-template/);
 await nativePut(join(root,'.specify/templates/plan-template.md'),'Native plan template');assert.equal((await prepareIntegrations(await scanRepository(root,options,{home}),options)).bindings.length,1);
})));
test('Spec Kit freezes enabled preset composition and extension fallback instead of unused core',()=>project(root=>project(async home=>{
 const options={agents:['omp' as const],backend:'host' as const,sdd:'spec-kit' as const};
 for(const name of ['constitution','specify','plan','tasks','implement','converge'])await nativePut(join(root,'.omp/commands',`speckit.${name}.md`),'Run .specify/scripts/bash/resolve-template.sh plan-template --json');
 await nativePut(join(root,'.specify/memory/constitution.md'),'Governance');await nativePut(join(root,'.specify/scripts/bash/resolve-template.sh'),'# Native resolver');
 await nativePut(join(root,'.specify/presets/.registry'),JSON.stringify({presets:{disabled:{priority:1,enabled:false},team:{priority:2,enabled:true}}}));
 await nativePut(join(root,'.specify/presets/team/preset.yml'),'provides:\n  templates:\n    - type: template\n      name: plan-template\n      file: templates/plan-template.md\n      strategy: append\n');
 await nativePut(join(root,'.specify/presets/team/templates/plan-template.md'),'Team layer');
 await nativePut(join(root,'.specify/extensions/.registry'),JSON.stringify({extensions:{review:{enabled:true},disabled:{enabled:false}}}));
 await nativePut(join(root,'.specify/extensions/review/templates/plan-template.md'),'Extension base');
 const before=await scanRepository(root,options,{home});assert.equal((await prepareIntegrations(before,options)).bindings.length,1);
 await nativePut(join(root,'.specify/extensions/review/templates/plan-template.md'),'Changed base');assert.notEqual((await scanRepository(root,options,{home})).fingerprint,before.fingerprint);
 const current=await scanRepository(root,options,{home});await nativePut(join(root,'.specify/presets/disabled/templates/plan-template.md'),'Unselected');await nativePut(join(root,'.specify/templates/plan-template.md'),'Unused core');assert.equal((await scanRepository(root,options,{home})).fingerprint,current.fingerprint);
})));

for(const version of [1,2])test(`OpenCode V${version} accepts the official named git package spec`,()=>project(root=>project(async home=>{
 const spec='superpowers@git+https://github.com/obra/superpowers.git#v7.0.2',cache=join(home,'.cache/opencode');
 const base=version===1?join(cache,'packages',spec,'node_modules/superpowers'):join(cache,'npm','git-superpowers-'+createHash('sha256').update(spec).digest('hex').slice(0,12),'12/node_modules/superpowers');
 await nativeSkills(join(base,'skills'));await nativePut(join(base,'package.json'),'{"name":"superpowers","main":".opencode/plugins/superpowers.js"}');await nativePut(join(base,'.opencode/plugins/superpowers.js'),officialOpenCodePlugin);
 await nativePut(join(home,'.config/opencode/opencode.json'),JSON.stringify(version===1?{plugin:[spec]}:{plugins:[spec]}));
 assert.equal((await scanRepository(root,nativeOptions('opencode'),{home})).nativeEntries?.opencode?.length,4);
})));
test('OMP user plugin root is beside agent configuration and ignores decoy agent/plugins',()=>project(root=>project(async home=>{
 for(const [base,body] of [[join(home,'.omp/plugins'),'actual'],[join(home,'.omp/agent/plugins'),'decoy']]){
  await nativePut(join(base,'package.json'),'{"dependencies":{"omp-superpowers":"0.1.0"}}');await nativePut(join(base,'node_modules/omp-superpowers/package.json'),'{"name":"omp-superpowers","omp":{"extensions":["extensions/superpowers.ts"]}}');await nativePut(join(base,'node_modules/omp-superpowers/extensions/superpowers.ts'),'export default function() {}');await nativeSkills(join(base,'node_modules/omp-superpowers/skills'),body);
 }
 const profile=await scanRepository(root,nativeOptions('omp'),{home});assert.equal(profile.skillSources?.omp?.length,4);assert.ok(profile.skillSources?.omp?.every(source=>source.identity.startsWith(join(home,'.omp/plugins'))));
})));

test('native manager metadata shares a bounded read budget and cannot authorize after exhaustion',()=>project(root=>project(async home=>{
 const plugins=join(home,'.omp/plugins'),dependencies:Record<string,string>={};
 for(let i=0;i<25;i++){const name='fixture-'+i;dependencies[name]='1.0.0';await nativePut(join(plugins,'node_modules',name,'package.json'),JSON.stringify({name,omp:{},padding:'x'.repeat(200000)}));}
 dependencies['omp-superpowers']='0.1.0';await nativePut(join(plugins,'package.json'),JSON.stringify({dependencies}));
 await nativePut(join(plugins,'node_modules/omp-superpowers/package.json'),'{"name":"omp-superpowers","omp":{}}');await nativeSkills(join(plugins,'node_modules/omp-superpowers/skills'));
 const prepared=await prepareIntegrations(await scanRepository(root,nativeOptions('omp'),{home}),nativeOptions('omp'));assert.equal(prepared.bindings.length,0);assert.match(prepared.requirements[0].reason,/budget/);
})));

for(const version of [1,2])test(`OpenCode V${version} selects its effective plugin versus project collision`,()=>project(root=>project(async home=>{
 const spec='superpowers@git+https://github.com/obra/superpowers.git#v7.0.2';
 const base=version===1?join(home,'.cache/opencode/packages',spec,'node_modules/superpowers'):join(home,'.cache/opencode/npm','git-superpowers-'+createHash('sha256').update(spec).digest('hex').slice(0,12),'20/node_modules/superpowers');
 await nativeSkills(join(base,'skills'),'plugin');
 await nativePut(join(base,'package.json'),JSON.stringify({name:'superpowers',main:'.opencode/plugins/superpowers.js'}));
 await nativePut(join(base,'.opencode/plugins/superpowers.js'),officialOpenCodePlugin);
 await nativePut(join(home,'.config/opencode/opencode.json'),JSON.stringify(version===1?{plugin:[spec]}:{plugins:[spec]}));
 await nativeSkills(join(home,'.config/opencode/skills'),'personal');
 await nativeSkills(join(root,'.opencode/skills'),'project');
 const profile=await scanRepository(root,nativeOptions('opencode'),{home});
 assert.equal((await prepareIntegrations(profile,nativeOptions('opencode'))).bindings.length,1);
 assert.equal(profile.skillSources?.opencode?.length,4);
 assert.ok(profile.skillSources?.opencode?.every(source=>version===1?source.identity.startsWith(base):source.identity.startsWith('.opencode/skills/')));
})));
for(const settings of [{skills:{enableClaudeUser:true},discovery:{providers:{'claude-plugins':true}}},{enabledProviders:['claude-plugins'],disabledProviders:['claude-plugins'],skills:{enableClaudeUser:true}}])test('OMP foreign user Marketplace follows top-level provider switches '+JSON.stringify(settings),()=>project(root=>project(async home=>{
 const base=join(home,'.claude/plugins/cache/official/superpowers/7');
 await nativeSkills(join(base,'skills'));await nativePut(join(base,'.claude-plugin/plugin.json'),'\{"name":"superpowers"\}');
 await nativePut(join(home,'.claude/plugins/installed_plugins.json'),JSON.stringify({plugins:{'superpowers@official':[{scope:'user',installPath:base}]}}));
 await nativePut(join(home,'.omp/agent/settings.json'),JSON.stringify(settings));
 assert.equal((await prepareIntegrations(await scanRepository(root,nativeOptions('omp'),{home}),nativeOptions('omp'))).bindings.length,0);
})));

test('Claude local Marketplace selects the verified catalog source and freezes catalog bytes',()=>project(root=>project(async home=>{
 const base=join(home,'marketplace'),cached=join(home,'.claude/plugins/cache/dev/superpowers/7');
 for(const path of [base,cached]){await nativeSkills(join(path,'skills'),path);await nativePut(join(path,'.claude-plugin/plugin.json'),'{"name":"superpowers"}');}
 await nativePut(join(home,'.claude/settings.json'),'{"enabledPlugins":{"superpowers@dev":true}}');
 await nativePut(join(home,'.claude/plugins/installed_plugins.json'),JSON.stringify({plugins:{'superpowers@dev':[{scope:'user',installPath:cached}]}}));
 await nativePut(join(home,'.claude/plugins/known_marketplaces.json'),JSON.stringify({dev:{source:{source:'directory',path:base},installLocation:base}}));
 const catalog=join(base,'.claude-plugin/marketplace.json');
 await nativePut(catalog,JSON.stringify({name:'dev',plugins:[{name:'superpowers',source:'./'}]}));
 const before=await scanRepository(root,nativeOptions('claude'),{home});
 assert.equal((await prepareIntegrations(before,nativeOptions('claude'))).bindings.length,1);
 assert.ok(before.skillSources?.claude?.every(source=>source.identity.startsWith(base+'/')));
 await nativePut(catalog,JSON.stringify({name:'dev',description:'catalog changed',plugins:[{name:'superpowers',source:'./'}]}));
 assert.notEqual((await scanRepository(root,nativeOptions('claude'),{home})).fingerprint,before.fingerprint);
 await nativePut(catalog,JSON.stringify({name:'dev',plugins:[{name:'superpowers',source:'../escape'}]}));
 assert.equal((await prepareIntegrations(await scanRepository(root,nativeOptions('claude'),{home}),nativeOptions('claude'))).bindings.length,0);
})));

test('OpenCode explicit project disable blocks wrappers despite usable global plugin',()=>project(root=>project(async home=>{
 const base=join(home,'superpowers');await nativeSkills(join(base,'skills'));
 await nativePut(join(base,'package.json'),'{"name":"superpowers","main":".opencode/plugins/superpowers.js"}');
 await nativePut(join(base,'.opencode/plugins/superpowers.js'),officialOpenCodePlugin);
 await nativePut(join(home,'.config/opencode/opencode.json'),JSON.stringify({plugin:[base]}));
 const profile=await scanRepository(root,nativeOptions('opencode'),{home,env:{OPENCODE_DISABLE_PROJECT_CONFIG:'true'}});
 const prepared=await prepareIntegrations(profile,nativeOptions('opencode'));
 assert.equal(prepared.bindings.length,0);
 assert.match(prepared.requirements[0].reason,/OPENCODE_DISABLE_PROJECT_CONFIG/);
 assert.match(prepared.requirements[0].nextCommand??'',/Unset OPENCODE_DISABLE_PROJECT_CONFIG/);
})));
