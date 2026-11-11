import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,rm,symlink,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {repositoryReader,scanRepository} from '../src/analyzer/repository.js';
import {digest,readEvidence} from '../src/analyzer/evidence.js';
import {validateResearch} from '../src/analyzer/backend.js';
import {project} from './helpers.js';
const options={agents:[],backend:'host'} as const;
test('empty_and_non_git_are_valid_profiles',()=>project(async root=>{
 const p=await scanRepository(root,{agents:[],backend:'host'});assert.equal(p.root,root);assert.equal(p.git.available,false);assert.deepEqual(p.files,[]);
}));
test('dirty_add_delete_changes_fingerprint',()=>project(async root=>{
 const scan=()=>scanRepository(root,{agents:[],backend:'host'});
 const a=await scan();await writeFile(join(root,'a.ts'),'first');const b=await scan();
 await writeFile(join(root,'a.ts'),'second');const c=await scan();await rm(join(root,'a.ts'));const d=await scan();
 assert.notEqual(a.fingerprint,b.fingerprint);assert.notEqual(b.fingerprint,c.fingerprint);assert.equal(a.fingerprint,d.fingerprint);
}));
test('monorepo_commands_keep_cwd_and_never_execute',()=>project(async root=>{
 await mkdir(join(root,'packages/a'),{recursive:true});
 await writeFile(join(root,'packages/a/package.json'),JSON.stringify({scripts:{test:'touch marker',build:'tsc'}}));
 const p=await scanRepository(root,{agents:[],backend:'host'});
 assert.equal(p.commands.test[0].cwd,'packages/a');assert.deepEqual(p.commands.test[0].args,['run','test']);
 await assert.rejects(access(join(root,'packages/a/marker')));
}));
test('specialized_package_checks_are_catalogued_separately_from_automatic_checks',()=>project(async root=>{
 await mkdir(join(root,'packages/api'),{recursive:true});
 await writeFile(join(root,'package.json'),JSON.stringify({scripts:{'test:e2e':'touch marker',typecheck:'tsc --noEmit','deps:validate':'node validate.js','test:dev':'vitest'}}));
 await writeFile(join(root,'packages/api/package.json'),JSON.stringify({scripts:{'test-e2e':'touch marker','check-types':'tsc --noEmit','test:e2e':null,typecheck:'   '}}));
 const profile=await scanRepository(root,{agents:[],backend:'host'});
 assert.ok(profile.specializedChecks?.length,'expected specialized scripts in the check catalog');
 assert.deepEqual(profile.specializedChecks.map(({command,source})=>[...command.args,command.cwd,source]),[
  ['run','test:e2e','.','package.json'],
  ['run','typecheck','.','package.json'],
  ['run','deps:validate','.','package.json'],
  ['run','test-e2e','packages/api','packages/api/package.json'],
  ['run','check-types','packages/api','packages/api/package.json'],
 ]);
 assert.deepEqual(Object.values(profile.commands).flat(),[]);
 await assert.rejects(access(join(root,'marker')));
 await assert.rejects(access(join(root,'packages/api/marker')));
}));
test('symlink_escape_and_secret_files_are_denied',()=>project(async root=>{
 await symlink(tmpdir(),join(root,'escape'),process.platform==='win32'?'junction':'dir');await writeFile(join(root,'.env'),'TOKEN=secret');
 await assert.rejects(readEvidence(root,'escape/anything',1,2));
 await assert.rejects(readEvidence(root,'../outside',1,1));await assert.rejects(readEvidence(root,'.env',1,1));
}));
test('budget_returns_unknowns',()=>project(async root=>{
 await writeFile(join(root,'a.ts'),'a');await writeFile(join(root,'b.ts'),'b');
 const p=await scanRepository(root,{agents:[],backend:'host',readBudget:{maxFiles:1,maxBytes:1000}});
 assert.equal(p.truncated,true);assert.ok(p.unknowns.length);
}));
test('managed_outputs_do_not_change_research_fingerprint',()=>project(async root=>{
 const {digest}=await import('../src/analyzer/evidence.js');
 await mkdir(join(root,'.rigup/baseline/install'),{recursive:true});
 await writeFile(join(root,'.rigup/baseline/install/guide'),'generated v1');
 await writeFile(join(root,'guide.md'),'generated v1');
 await writeFile(join(root,'.rigup/manifest.json'),JSON.stringify({schemaVersion:1,installId:'install',assets:[{logicalId:'guide',target:'guide.md',ownership:{kind:'file'},baseline:'.rigup/baseline/install/guide',digest:digest('generated v1')}]}));
 const a=await scanRepository(root,{agents:[],backend:'host'});
 await writeFile(join(root,'guide.md'),'user modified generated');
 const b=await scanRepository(root,{agents:[],backend:'host'});
 assert.equal(a.fingerprint,b.fingerprint);assert.equal(a.files.includes('guide.md'),false);
}));
test('search_snippets_use_same_policy',()=>project(async root=>{
 const {repositoryReader}=await import('../src/analyzer/repository.js');
 await writeFile(join(root,'config.yaml'),'token: hidden-value\nname: visible\n');
 const reader=await repositoryReader(root,{agents:[],backend:'host'});
 assert.deepEqual(await reader.search('hidden-value'),[]);
 assert.equal((await reader.search('visible'))[0].evidence.startLine,2);
}));
test('worktree_root_is_not_common_git_dir',()=>project(async root=>{
 const {execFileSync}=await import('node:child_process');
 const {realpath}=await import('node:fs/promises');
 const repo=join(root,'repo'),work=join(root,'work');await mkdir(repo);
 execFileSync('git',['init',repo]);execFileSync('git',['-C',repo,'-c','user.name=Test','-c','user.email=test@example.test','commit','--allow-empty','-m','initial']);
 execFileSync('git',['-C',repo,'worktree','add','--detach',work]);
 const p=await scanRepository(work,{agents:[],backend:'host'});
 assert.equal(p.root,await realpath(work));assert.equal(p.git.available,true);
}));
test('reader_and_search_share_cumulative_budget_and_scope',()=>project(async root=>{
 const {repositoryReader}=await import('../src/analyzer/repository.js');
 await mkdir(join(root,'selected'));await writeFile(join(root,'selected/a.ts'),'four');await writeFile(join(root,'outside.ts'),'x');
 const reader=await repositoryReader(root,{agents:[],backend:'host',scope:['selected'],readBudget:{maxFiles:10,maxBytes:5}});
 assert.deepEqual(await reader.list(),['selected/a.ts']);
 assert.equal((await reader.read('selected/a.ts',1,1)).content,'four');
 await assert.rejects(reader.search('four'),/budget/);
 await assert.rejects(reader.read('outside.ts',1,1),/inventory/);
}));
test('verification reads a source once per pass and rereads it at the next checkpoint',()=>project(async root=>{
 const path='source.ts';
 await writeFile(join(root,path),'first\nsecond');
 const budget={calls:0,bytes:0};
 const reader=await repositoryReader(root,{agents:[],backend:'host',readBudget:{maxFiles:2,maxBytes:24}},{budget});
 const research={observations:[],citations:[
  {path,startLine:1,endLine:1,digest:digest('first')},
  {path,startLine:2,endLine:2,digest:digest('second')}
 ]};
 await validateResearch(research,reader);
 assert.deepEqual(budget,{calls:1,bytes:12});
 await writeFile(join(root,path),'first\nedited');
 await assert.rejects(validateResearch(research,reader),/digest mismatch/);
 assert.deepEqual(budget,{calls:2,bytes:24});
}));
test('different counterexample queries share one budgeted corpus scan',()=>project(async root=>{
 const {repositoryReader}=await import('../src/analyzer/repository.js');
 await writeFile(join(root,'a.ts'),'first\nsecond');
 const budget={calls:0,bytes:0};
 const reader=await repositoryReader(root,{agents:[],backend:'host',readBudget:{maxFiles:1,maxBytes:12}},{budget});
 const [first,second]=await Promise.all([reader.search('first'),reader.search('second')]);
 assert.equal(first[0].evidence.startLine,1);assert.equal(second[0].evidence.startLine,2);
 assert.deepEqual(budget,{calls:1,bytes:12});
 await assert.rejects(reader.read('a.ts',1),/budget/);
}));
test('scoped literal search stops at its match limit',()=>project(async root=>{
 const {repositoryReader}=await import('../src/analyzer/repository.js');
 await writeFile(join(root,'outside.ts'),'match outside\n');
 await writeFile(join(root,'selected.ts'),'match one\nmatch two\nmatch three\n');
 await writeFile(join(root,'z-later.ts'),'match later\n');
 const budget={calls:0,bytes:0};
 const reader=await repositoryReader(root,{agents:[],backend:'host'},{budget});
 const selection={paths:new Set(['selected.ts','z-later.ts']),limit:2};
 const matches=await reader.search('match',selection);
 assert.deepEqual(matches.map(match=>[match.evidence.path,match.evidence.startLine]),[['selected.ts',1],['selected.ts',2]]);
 assert.deepEqual(budget,{calls:1,bytes:32});
 assert.equal((await reader.search('match')).length,5);
 assert.equal(budget.calls,3);
}));
test('missing_baseline_disables_cache_and_is_not_silent',()=>project(async root=>{
 await mkdir(join(root,'.rigup'));
 await writeFile(join(root,'.rigup/manifest.json'),JSON.stringify({schemaVersion:1,assets:[{target:'guide.md',baseline:'.rigup/baseline/missing',ownership:{kind:'file'},digest:'unknown'}]}));
 const profile=await scanRepository(root,{agents:[],backend:'host'});
 assert.equal(profile.truncated,true);assert.match(profile.unknowns.join(' '),/ownership/);
}));
test('generated_blocks_are_not_normative_reader_evidence',()=>project(async root=>{
 const {digest}=await import('../src/analyzer/evidence.js');const {repositoryReader}=await import('../src/analyzer/repository.js');
 await mkdir(join(root,'.rigup/baseline/i'),{recursive:true});
 const generated='<!-- start -->\ngenerated rule\n<!-- end -->';
 await writeFile(join(root,'.rigup/baseline/i/block'),generated);
 await writeFile(join(root,'AGENTS.md'),'user rule\n'+generated+'\nmore user');
 await writeFile(join(root,'.rigup/manifest.json'),JSON.stringify({schemaVersion:1,assets:[{target:'AGENTS.md',baseline:'.rigup/baseline/i/block',digest:digest(generated),ownership:{kind:'block',start:'<!-- start -->',end:'<!-- end -->'}}]}));
 const reader=await repositoryReader(root,{agents:[],backend:'host'});
 assert.deepEqual(await reader.search('generated rule'),[]);
 assert.match((await reader.read('AGENTS.md',1,5)).content,/user rule/);
 assert.doesNotMatch((await reader.read('AGENTS.md',1,5)).content,/generated rule/);
}));
test('unborn_git_repository_is_reported_as_git',()=>project(async root=>{
 const {execFileSync}=await import('node:child_process');execFileSync('git',['init',root]);
 const profile=await scanRepository(root,{agents:[],backend:'host'});
 assert.equal(profile.git.available,true);assert.equal(profile.git.head,undefined);
}));
test('project_native_entries_are_discovered_without_loading_skill_code',()=>project(async root=>{
 await mkdir(join(root,'.agents/skills/openspec-propose'),{recursive:true});
 await writeFile(join(root,'.agents/skills/openspec-propose/SKILL.md'),'---\nname: openspec-propose\ndescription: Propose changes\n---\nRead existing project guidance.\n');
 const p=await scanRepository(root,{agents:['codex'],backend:'host'});
 assert.ok(p.nativeEntries?.codex?.includes('openspec-propose'));
 assert.equal(p.skillSources?.codex?.[0].origin,'local');
}));
test('research_fingerprint_uses_filtered_values_and_coverage_unknowns',()=>project(async root=>{
 await writeFile(root+'/config.json',JSON.stringify({token:'first-secret',port:3000}));const a=await scanRepository(root,{agents:[],backend:'host'});await writeFile(root+'/config.json',JSON.stringify({token:'second-secret',port:3000}));const b=await scanRepository(root,{agents:[],backend:'host'});assert.equal(a.fingerprint,b.fingerprint);
 await writeFile(root+'/sensitive.unknown','password=literal');const c=await scanRepository(root,{agents:[],backend:'host'});assert.notEqual(b.fingerprint,c.fingerprint);
}));
test('managed_sensitive_words_do_not_add_research_unknowns_or_change_fingerprint',()=>project(async root=>{
 await writeFile(root+'/source.js','export const value=1;');const options={agents:[],backend:'host' as const};const first=await scanRepository(root,options);const {mkdir}=await import('node:fs/promises');const {digest}=await import('../src/analyzer/evidence.js');await mkdir(root+'/.rigup/baseline/id',{recursive:true});const whole='Authorization: preserve all approval boundaries.\n';const block='<!-- rigup:start -->\nAuthorization: preserve human gates.\n<!-- rigup:end -->\n';await writeFile(root+'/generated.md',whole);await writeFile(root+'/AGENTS.md',block);await writeFile(root+'/.rigup/baseline/id/whole',whole);await writeFile(root+'/.rigup/baseline/id/block',block);await writeFile(root+'/.rigup/manifest.json',JSON.stringify({schemaVersion:1,installId:'id',assets:[{target:'generated.md',ownership:{kind:'file'},digest:digest(whole),baseline:'.rigup/baseline/id/whole'},{target:'AGENTS.md',ownership:{kind:'block',start:'<!-- rigup:start -->',end:'<!-- rigup:end -->'},digest:digest(block),baseline:'.rigup/baseline/id/block'}]}));const next=await scanRepository(root,options);assert.deepEqual(next.unknowns,first.unknowns);assert.equal(next.fingerprint,first.fingerprint);
}));

test('harness quarantines draft and malformed pages through every reader entry',()=>project(async root=>{
 const {renderConventionSeed}=await import('../src/project-conventions.js');
 const settings={agents:[],backend:'host' as const};
 const {content}=renderConventionSeed({topicId:'api-errors',title:'API errors',scope:'.',questions:['Question']});
 for(const [path,raw] of [
  ['draft.md',content+'Private unconfirmed draft body\n'],
  ['duplicate.md',content.replace('status: draft','status: draft\nstatus: confirmed')+'Private unconfirmed draft body\n'],
  ['broken.md',content.slice(0,-4)+'Private unconfirmed draft body\n'],
  ['flow.md','---\n{rigup: team-convention, version: 1, topicId: api-errors, title: API, scope: ., status: draft}\n---\nPrivate unconfirmed draft body\n'],
  ['flow-duplicate.md','---\n{rigup: other, rigup: team-convention, status: draft}\n---\nPrivate unconfirmed draft body\n'],
  ['alias.md',content.replace('rigup: team-convention','marker: &team team-convention\nrigup: *team')+'Private unconfirmed draft body\n'],
  ['leading-blank.md','\n\n'+content+'Private unconfirmed draft body\n'],
 ]){
  await writeFile(root+'/'+path,raw);
 }
 const reader=await repositoryReader(root,settings);
 assert.deepEqual(await reader.search('Private unconfirmed draft body'),[]);
 for(const path of ['draft.md','duplicate.md','broken.md','flow.md','flow-duplicate.md','alias.md','leading-blank.md']){
  assert.equal((await reader.read(path,1)).content.trim(),'');
  assert.equal((await reader.evidencePass()(path,1)).content.trim(),'');
 }
 const profile=await scanRepository(root,settings);
 assert.deepEqual(profile.conventions?.map(page=>page.status),['draft','draft','draft','draft']);
 assert.ok(profile.unknowns.some(note=>note.startsWith('duplicate.md:')));
 assert.ok(profile.unknowns.some(note=>note.startsWith('broken.md:')));
}));

test('harness confirmation rejects pure checklist, numbered and punctuation placeholders',async()=>{
 const {readConventionDocument,renderConventionSeed}=await import('../src/project-conventions.js');
 const {content}=renderConventionSeed({topicId:'api-errors',title:'API errors',scope:'.',questions:['Decide']});
 for(const status of ['confirmed','not-applicable'])for(const body of ['- [ ] TODO\n','1. TBD\n','...\n','```md\nTODO\n```\n']){
  const result=readConventionDocument('policy.md',content.replace('status: draft','status: '+status)+body);
  assert.equal(result.page,undefined);
  assert.equal(result.researchText.trim(),'');
  assert.ok(result.warnings.length);
 }
});
