import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {renderFixed,validateNavigation} from '../src/generator/render.js';
import {collectCustomSkill} from '../src/integrations/custom-skills.js';
import {renderCustomerTemplate} from '../src/integrations/custom-templates.js';
import {validateTemplateContent} from '../src/generator/document-policy.js';
import {project,setNativeEntries} from './helpers.js';import {scanRepository} from '../src/analyzer/repository.js';
import {prepareIntegrations} from '../src/integrations/registry.js';
import {loadUpstreamLock} from '../src/integrations/upstream.js';
test('every selected host installs a navigable readiness entry and a fixed GOAL resource',()=>project(async root=>{
 const options={agents:['codex','claude','opencode','omp'] as const,backend:'host' as const,sdd:'openspec' as const};
 const selected={...options,agents:[...options.agents]};
 const profile=await scanRepository(root,selected);
 const native=['openspec-propose','openspec-apply-change','openspec-archive-change'];
 setNativeEntries(profile,{codex:native,claude:native,opencode:native,omp:native});
 const assets=await renderFixed(profile,selected,await prepareIntegrations(profile,selected),[],[]);
 for(const directory of ['.agents/skills','.claude/skills','.opencode/skills','.omp/skills']){
  for(const resource of ['change-ready/SKILL.md','change-ready/references/project.md','change-prepare/references/GOAL.md']){
   assert.ok(assets.some(asset=>asset.target===directory+'/'+resource),'missing installed resource: '+directory+'/'+resource);
  }
  // These installed instructions are the contract; this does not prove host compliance.
  for(const resource of ['change-ready/SKILL.md','change-deliver/SKILL.md','change-prepare/references/GOAL.md']){
   const content=assets.find(asset=>asset.target===directory+'/'+resource)!.content;
   assert.doesNotMatch(content,/(?:submitting|submission)[^.\n]*authorizes (?:its )?implementation/i,resource);
   assert.match(content,/already approved scope/,resource);
  }
  const ready=assets.find(asset=>asset.target===directory+'/change-ready/SKILL.md')!.content;
  assert.match(ready,/missing, pending, stale or scope-mismatched implementation approval blocks readiness/i);
  const prepare=assets.find(asset=>asset.target===directory+'/change-prepare/SKILL.md')!.content;
  const goal=assets.find(asset=>asset.target===directory+'/change-prepare/references/GOAL.md')!.content;
  assert.match(prepare,/every repository-relative file delivery will modify/i,'preparation must enumerate the delivered write set');
  assert.match(goal,/reviewed write scope[\s\S]*task.*checkbox[\s\S]*evidence/i,'the fixed GOAL must account for task and evidence writes');
  for(const name of ['change-ready','change-deliver']){
   const content=assets.find(asset=>asset.target===directory+'/'+name+'/SKILL.md')!.content;
   assert.match(content,/planned writes[\s\S]*reviewed write scope/i,name+' must reconcile delivery destinations');
   assert.match(content,/GOAL itself[\s\S]*defined record write/i,name+' must bound GOAL writes');
   assert.match(content,/older GOALs[\s\S]*format/i,name+' must accept complete legacy artifacts');
   assert.match(content,/additional authorization[\s\S]*unused/i,name+' must distinguish authorization from the reviewed scope');
   assert.match(content,/omits any part[\s\S]*blocks/i,name+' must retain the full-scope approval gate');
  }
 }
 validateNavigation(assets,profile.files);
 for(const asset of assets)validateTemplateContent(asset.content);
}));
test('customer skills cannot shadow any fixed workflow entry',()=>project(async root=>{
 for(const name of ['change-prepare','change-ready','change-deliver','change-release']){
  await writeFile(root+'/SKILL.md','---\nname: '+name+'\ndescription: Customer workflow\n---\n');
  await assert.rejects(collectCustomSkill(root,'.agents/skills'),/fixed public entry collision/,name);
 }
}));
test('customer templates cannot replace fixed readiness context or GOAL resources',()=>project(async root=>{
 await writeFile(root+'/review.md','Customer guidance\n');
 for(const resource of ['change-prepare/references/GOAL.md','change-ready/references/project.md','change-deliver/references/project.md']){
  await assert.rejects(renderCustomerTemplate(root,{source:'review.md',target:'.agents/skills/'+resource},['.agents/skills'],'review'),/fixed flow/,resource);
 }
 const extra=await renderCustomerTemplate(root,{source:'review.md',target:'.agents/skills/customer/references/review.md'},['.agents/skills'],'review');
 assert.equal(extra.content,'Customer guidance\n');
}));
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
  assert.ok(profile.skillSources?.codex?.some(source=>source.name===qualified+'openspec-sync-specs'&&source.identity===join(skills,'openspec-sync-specs','SKILL.md')));
  assert.deepEqual(integration.bindings[0].projectSources,[]);
 }));
});
