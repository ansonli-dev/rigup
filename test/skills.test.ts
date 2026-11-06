import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {renderFixed} from '../src/generator/render.js';
import {project,setNativeEntries} from './helpers.js';import {scanRepository} from '../src/analyzer/repository.js';
import {prepareIntegrations} from '../src/integrations/registry.js';
import {loadUpstreamLock} from '../src/integrations/upstream.js';
test('workflow_reuses_selected_sdd_artifacts_and_release_requires_real_adapter',()=>project(async root=>{
 const options={agents:['codex' as const],backend:'host' as const,sdd:'openspec' as const};const profile=await scanRepository(root,options);setNativeEntries(profile,{codex:['openspec-propose','openspec-apply-change','openspec-archive-change']});
 const assets=await renderFixed(profile,options,await prepareIntegrations(profile,options),[],[]);
 assert.ok(!assets.some(a=>a.target.includes('change-release')));const context=assets.find(a=>a.target.endsWith('change-deliver/references/project.md'))!.content;assert.match(context,/openspec-apply-change/);assert.match(context,/openspec\/changes/);
}));
test('installed_skills_do_not_invoke_rigup_and_preserve_native_human_gates',async()=>{
 for(const name of ['change-prepare','change-deliver']) {
  const text=await readFile(new URL('../templates/skills/'+name+'/SKILL.md',import.meta.url),'utf8');assert.doesNotMatch(text,/\brigup\b/);assert.match(text,/human.*gate|human approval/);assert.match(text,/budget/);assert.match(text,/hand ?off|hand.*over/i);assert.match(text,/scope/);
  assert.match(text,/\]\(references\/project\.md\)/);
  const reference=await readFile(new URL('../templates/skills/'+name+'/references/project.md',import.meta.url),'utf8');
  assert.match(reference,/native workflow/i);
  assert.doesNotMatch(reference,/\brigup (?:check|doctor|init|update)\b/);
 }
});
test('workflow checks reusable boundaries before planning and before editing',async()=>{
 const prepare=await readFile(new URL('../templates/skills/change-prepare/SKILL.md',import.meta.url),'utf8');
 const deliver=await readFile(new URL('../templates/skills/change-deliver/SKILL.md',import.meta.url),'utf8');
 assert.match(prepare,/search its references.*outside the requested scope/);
 assert.match(deliver,/search its references.*return the affected task for revision and approval/);
});
test('OpenSpec uses resolved project sources and exposes its optional revision entry',()=>project(async root=>{
 const options={agents:['codex' as const],backend:'host' as const,sdd:'openspec' as const};
 const files={
  '.agents/skills/local-proposal':'openspec-propose',
  '.agents/skills/local-apply':'openspec-apply-change',
  '.agents/skills/openspec-archive-change':'openspec-archive-change',
  '.agents/skills/openspec-update-change':'openspec-update-change',
  '.agents/skills/openspec-sync-specs':'openspec-sync-specs',
  '.claude/skills/openspec-apply-change':'openspec-apply-change',
 };
 for(const [path,name] of Object.entries(files)){await mkdir(root+'/'+path,{recursive:true});await writeFile(root+'/'+path+'/SKILL.md',`---\nname: ${name}\ndescription: Native fixture\n---\nPreserve approvals.\n`);}
 const profile=await scanRepository(root,options),integration=await prepareIntegrations(profile,options);
 assert.deepEqual(integration.bindings[0].projectSources,['.agents/skills/local-proposal/SKILL.md','.agents/skills/local-apply/SKILL.md','.agents/skills/openspec-archive-change/SKILL.md','.agents/skills/openspec-update-change/SKILL.md','.agents/skills/openspec-sync-specs/SKILL.md']);
 const assets=await renderFixed(profile,options,integration,[],[]);
 const preparation=assets.find(asset=>asset.target.endsWith('change-prepare/SKILL.md'))!.content;
 const reference=assets.find(asset=>asset.target.endsWith('change-prepare/references/project.md'))!.content;
 assert.match(preparation,/native inspection[\s\S]*Existing checks[\s\S]*dependency order[\s\S]*native dependency rereads/);
 assert.match(reference,/Reuse the active change's native paths and completed discovery[\s\S]*Refresh state after writes/);
 assert.match(reference,/Native revise: openspec-update-change/);
 assert.match(reference,/local-proposal\/SKILL\.md/);
 assert.doesNotMatch(reference,/\.claude\//);
}));

test('OpenSpec resolves optional revision and sync from user skills and enabled plugins',async()=>{
 for(const origin of ['user','plugin'])await project(root=>project(async home=>{
  const options={agents:['codex' as const],backend:'host' as const,sdd:'openspec' as const};
  const names=['openspec-propose','openspec-apply-change','openspec-archive-change','openspec-update-change','openspec-sync-specs'];
  let skills=home+'/.codex/skills';
  if(origin==='plugin'){
   const pin=(await loadUpstreamLock()).find(recipe=>recipe.integrationId==='openspec')!;
   const base=home+'/.codex/plugins/cache/fixture-market/openspec/'+pin.version;
   await mkdir(base+'/.claude-plugin',{recursive:true});
   await writeFile(base+'/.claude-plugin/plugin.json',JSON.stringify({name:'openspec',version:pin.version}));
   await writeFile(home+'/.codex/config.toml','[plugins."openspec@fixture-market"]\nenabled = true\n');
   skills=base+'/skills';
  }
  for(const name of names){
   const directory=skills+'/'+name;
   await mkdir(directory,{recursive:true});
   await writeFile(directory+'/SKILL.md','---\nname: '+name+'\ndescription: Native fixture\n---\nPreserve approvals.\n');
  }
  const profile=await scanRepository(root,options,{home});
  const integration=await prepareIntegrations(profile,options);
  const qualified=origin==='plugin'?'openspec:':'';
  assert.deepEqual(integration.requirements,[]);
  assert.equal(integration.bindings[0]?.revise,qualified+'openspec-update-change');
  assert.ok(profile.skillSources?.codex?.some(source=>source.name===qualified+'openspec-sync-specs'&&source.identity===skills+'/openspec-sync-specs/SKILL.md'));
  assert.deepEqual(integration.bindings[0].projectSources,[]);
 }));
});
