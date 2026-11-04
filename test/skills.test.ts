import {test} from 'node:test';import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
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
  const text=await readFile(new URL('../templates/skills/'+name+'/SKILL.md',import.meta.url),'utf8');assert.doesNotMatch(text,/\brigup\b/);assert.match(text,/human.*gate|human approval/);assert.match(text,/budget/);assert.match(text,/scope/);assert.match(text,/handoff|hand.*over/);
 }
});
