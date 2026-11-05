import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {renderFixed} from '../src/generator/render.js';
import {project,setNativeEntries} from './helpers.js';import {scanRepository} from '../src/analyzer/repository.js';
import {prepareIntegrations} from '../src/integrations/registry.js';
test('workflow_reuses_selected_sdd_artifacts_and_release_requires_real_adapter',()=>project(async root=>{
 const options={agents:['codex' as const],backend:'host' as const,sdd:'openspec' as const};const profile=await scanRepository(root,options);setNativeEntries(profile,{codex:['openspec-propose','openspec-apply-change','openspec-archive-change']});
 const assets=await renderFixed(profile,options,await prepareIntegrations(profile,options),[],[]);
 assert.ok(!assets.some(a=>a.target.includes('change-release')));const context=assets.find(a=>a.target.endsWith('change-deliver/references/project.md'))!.content;assert.match(context,/openspec-apply-change/);assert.match(context,/openspec\/changes/);
}));
test('installed_skills_do_not_invoke_rigup_and_preserve_native_human_gates',async()=>{
 for(const name of ['change-prepare','change-deliver']) {
  const text=await readFile(new URL('../templates/skills/'+name+'/SKILL.md',import.meta.url),'utf8');assert.doesNotMatch(text,/\brigup\b/);assert.match(text,/human.*gate|human approval/);assert.match(text,/budget/);assert.match(text,/hand ?off|hand.*over/i);assert.match(text,/scope/);
  assert.match(text,/\]\(references\/project\.md\)/);
  assert.match(await readFile(new URL('../templates/skills/'+name+'/references/project.md',import.meta.url),'utf8'),/native workflow/i);
 }
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
 const reference=assets.find(asset=>asset.target.endsWith('change-prepare/references/project.md'))!.content;
 assert.match(reference,/Native revise: openspec-update-change/);
 assert.match(reference,/local-proposal\/SKILL\.md/);
 assert.doesNotMatch(reference,/\.claude\//);
}));
