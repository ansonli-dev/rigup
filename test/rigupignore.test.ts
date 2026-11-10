import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,symlink,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {project} from './helpers.js';
import {hostBackend} from '../src/analyzer/host.js';
import {repositoryReader,scanRepository} from '../src/analyzer/repository.js';
import {prepareIntegrations} from '../src/integrations/registry.js';
import type {SetupOptions} from '../src/types.js';

async function put(root:string,path:string,text:string){
 const file=join(root,path);
 await mkdir(dirname(file),{recursive:true});
 await writeFile(file,text);
}

test('research ignore applies gitignore rules before exposing or hashing evidence',()=>project(async root=>{
 const options:SetupOptions={agents:['claude'],backend:'host',projectRules:true};
 await put(root,'.rigupignore','/docs/generated/*.md\n!/docs/generated/keep.md\n!/.env\n');
 await put(root,'docs/generated/drop.md','private context\n');
 await put(root,'docs/generated/keep.md','relevant context\n');
 await put(root,'.env','PRIVATE=never-read');
 const profile=await scanRepository(root,options);
 const reader=await repositoryReader(root,options);
 assert.deepEqual(await reader.list(),['docs/generated/keep.md']);
 await assert.rejects(()=>reader.read('docs/generated/drop.md',1,1),/outside reader inventory/);
 assert.deepEqual(await reader.search('private context'),[]);
 await put(root,'docs/generated/drop.md','replaced private context\n');
 assert.equal((await scanRepository(root,options)).fingerprint,profile.fingerprint);
 await put(root,'.rigupignore','/docs/generated/*.md\n');
 assert.notEqual((await scanRepository(root,options)).fingerprint,profile.fingerprint);
}));

test('workflow entrypoints stay bindable without becoming project rule evidence',()=>project(async root=>{
 const options:SetupOptions={agents:['claude'],backend:'host',projectRules:true,sdd:'openspec'};
 const entry='.claude/skills/openspec-propose/SKILL.md';
 for(const name of ['openspec-propose','openspec-apply-change','openspec-archive-change']){
  await put(root,'.claude/skills/'+name+'/SKILL.md','---\nname: '+name+'\ndescription: test fixture\n---\nNative workflow only\n');
 }
 await put(root,'.claude/skills/openspec-propose/reference.md','Workflow template only\n');
 await put(root,'.specify/templates/plan.md','Generated plan template\n');
 await put(root,'.specify/memory/constitution.md','Local governance\n');
 await put(root,'openspec/specs/orders/spec.md','Current product specification\n');
 await put(root,'openspec/changes/working/tasks.md','Unapproved work\n');
 const profile=await scanRepository(root,options);
 const reader=await repositoryReader(root,options);
 assert.deepEqual((await reader.list()).sort(),['.specify/memory/constitution.md','openspec/specs/orders/spec.md']);
 assert.ok((await prepareIntegrations(profile,options)).bindings[0]?.projectSources?.includes(entry));
 await assert.rejects(()=>reader.read(entry,1,1),/outside reader inventory/);
}));

for(const [mode,projectRules] of [['explicit project rules',true],['legacy host research',undefined],['project rules disabled',false]] as const){
 test('Spec Kit host request stays below 20 KB with '+mode,()=>project(async root=>project(async cache=>{
  const options:SetupOptions={agents:['claude'],backend:'host',sdd:'spec-kit',projectRules};
  const generatedFiles=[
   '.specify/scripts/bash/common.sh',
   '.specify/templates/tasks-template.md',
   '.specify/extensions/extension/README.md',
   '.specify/presets/preset/README.md',
   '.specify/workflows/speckit/workflow.yml',
   '.specify/workflows/workflow-registry.json',
   '.specify/integrations/claude.manifest.json',
   '.specify/integrations/speckit.manifest.json',
   '.specify/integrations/packages.json',
   '.specify/integrations/packages/adapter/package.json',
   '.specify/.gitignore',
   '.specify/feature.json',
   '.specify/init-options.json',
   '.specify/integration.json',
   '.specify/bundle-records.json',
   '.specify/memory/.constitution-template.json',
   '.claude/skills/speckit-plan/references/plan.md',
  ];
  for(const path of generatedFiles)await put(root,path,'Upstream scaffold.\n'.repeat(1600));
  const skill='.claude/skills/speckit-plan/SKILL.md';
  await put(root,skill,'---\nname: speckit-plan\ndescription: Native planner\n---\n'+'Native instructions.\n'.repeat(1600));
  const constitution='.specify/memory/constitution.md';
  const spec='specs/001-orders/spec.md';
  const plan='specs/001-orders/plan.md';
  const openSpecPlan='openspec/changes/orders/tasks.md';
  await put(root,constitution,'Only reviewed migrations may be run.\n');
  await put(root,spec,'An order can be canceled before shipment.\n');
  await put(root,plan,'Check shipment state before canceling.\n');
  await put(root,openSpecPlan,'Review OpenSpec change separately.\n');
  const profile=await scanRepository(root,options);
  const reader=await repositoryReader(root,options);
  const result=await hostBackend({cacheRoot:cache}).run({
   kind:'analyze',runId:'spec-kit-size',root,fingerprint:profile.fingerprint,options,
   versions:{prompt:'4',read:'4'},budget:{maxCalls:12,maxTokens:1_200_000},
   previousInventoryDigest:'none',templateSourcesDigest:'none',
  },reader);
  assert.equal(result.status,'pending-host');
  const bytes=await readFile(result.requestPath);
  assert.ok(bytes.length<20_000,`Spec Kit host request was ${bytes.length} bytes`);
  const request=JSON.parse(bytes.toString('utf8'));
  const expectedPaths=[constitution,plan,spec,...(projectRules?[]:[openSpecPlan])].sort();
  assert.deepEqual(request.paths.sort(),expectedPaths);
  assert.deepEqual(request.evidence.map((item:{evidence:{path:string}})=>item.evidence.path).sort(),expectedPaths);
  assert.ok(profile.skillSources?.claude?.some(source=>source.identity===skill));
 })));
}

test('an entry-only legacy Spec Kit project invalidates earlier full-evidence fingerprints',()=>project(async root=>{
 const options:SetupOptions={agents:['claude'],backend:'host'};
 const skill='.claude/skills/speckit-plan/SKILL.md';
 await put(root,skill,'---\nname: speckit-plan\ndescription: Native planner\n---\n');
 await put(root,'.specify/memory/team-notes.md','Keep local review notes available.\n');
 const full=await scanRepository(root,options);
 const filtered=await scanRepository(root,{...options,sdd:'spec-kit'});
 assert.deepEqual(filtered.files,full.files);
 assert.deepEqual(filtered.researchFiles,['.specify/memory/team-notes.md']);
 assert.notEqual(filtered.fingerprint,full.fingerprint);
}));

test('a symlinked research ignore file is rejected',()=>project(async root=>{
 await put(root,'local-ignore','*.md');
 if(process.platform==='win32')return; // Windows symlink creation may require Developer Mode.
 await symlink('local-ignore',join(root,'.rigupignore'));
 await assert.rejects(()=>repositoryReader(root,{agents:['claude'],backend:'host'}),/symlink denied/);
}));
