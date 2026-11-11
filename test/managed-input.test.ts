import {test} from 'node:test';
import assert from 'node:assert/strict';
import {projectInput,remoteInput} from '../src/managed-input.js';
test('managed_outputs_excluded_but_unmanaged_config_remains',()=>{
 const a='user guidance\n<!-- rigup:start -->\nold generated\n<!-- rigup:end -->\ntail';
 const b=a.replace('old generated','new generated');
 const ownership={kind:'block' as const,start:'<!-- rigup:start -->',end:'<!-- rigup:end -->'};
 assert.equal(projectInput(a,[ownership]),projectInput(b,[ownership]));
 assert.notEqual(projectInput(a,[ownership]),projectInput(a.replace('user guidance','changed'),[ownership]));
 assert.equal(projectInput('generated',[{kind:'file'}]),null);
 assert.throws(()=>projectInput('no matching markers',[ownership]),/ownership/);
});
test('remote_unknown_version_requires_reread_and_unavailable_invalidates',async()=>{
 let reads=0;
 assert.equal(await remoteInput(undefined,async()=>{reads++;return 'fresh';}),'fresh');assert.equal(reads,1);
 await assert.rejects(remoteInput(undefined,async()=>{throw new Error('unavailable');}),/unavailable/);
});
test('json_key_projection_retains_unmanaged_keys_and_comments',()=>{
 const a='{\n // user comment\n "mcpServers":{"rigup":{"url":"old"},"customer":{"url":"keep"}}\n}';
 const selectors=[{kind:'json-key' as const,path:['mcpServers','rigup']}];
 assert.equal(projectInput(a,selectors),projectInput(a.replace('"old"','"new"'),selectors));
 assert.notEqual(projectInput(a,selectors),projectInput(a.replace('keep','changed'),selectors));
 assert.match(projectInput(a,selectors)!,/user comment/);
});
test('toml_table_projection_retains_other_tables',()=>{
 const a='# user\n[tool.rigup]\nvalue = "old"\n[tool.customer]\nvalue = "keep"\n';
 const selectors=[{kind:'toml-table' as const,path:['tool','rigup']}];
 assert.equal(projectInput(a,selectors),projectInput(a.replace('old','new'),selectors));
 assert.notEqual(projectInput(a,selectors),projectInput(a.replace('keep','changed'),selectors));
});
test('tool_output_projection_keeps_user_inputs_in_same_directory',()=>{
 assert.equal(projectInput('index content',[{kind:'file'}]),null);
 assert.equal(projectInput('user authored rules',[]),'user authored rules');
});
test('remote_content_and_version_changes_are_observed_without_stale_cache',async()=>{
 assert.equal(await remoteInput('v1',async()=> 'one'),'one');
 assert.equal(await remoteInput('v2',async()=> 'two'),'two');
});

test('harness scoped navigation preserves neighbors and merges customer changes from trusted baselines',async()=>{
 const {project,harnessPlan}=await import('./helpers.js');
 const {mkdir,readFile,writeFile}=await import('node:fs/promises');
 const {scanRepository}=await import('../src/analyzer/repository.js');
 const {generateFoundation,prepareGeneration}=await import('../src/generator/generate.js');
 const {loadManifest,trustedBaseline}=await import('../src/installer/baseline.js');
 const {preview}=await import('../src/installer/preview.js');
 const {apply}=await import('../src/installer/apply.js');
 await project(root=>project(cache=>project(async state=>{
  for(const scope of ['api','web']){
   await mkdir(root+'/'+scope);
   await writeFile(root+'/'+scope+'/main.ts','export const ready = true;\n');
  }
  const options={agents:['codex' as const],backend:'host' as const,projectRules:true,projectConventions:{topics:[
   {id:'api-errors',title:'API contract',scope:['api']},{id:'ui-states',title:'UI states',scope:['web']},{id:'common',title:'Common rules',scope:['.']},
  ]}};
  const dependencies={cacheRoot:cache,stateRoot:state};
  const first=await preview(await harnessPlan(root,cache,options),[],dependencies);
  await apply(first.previewId,dependencies);
  const receipts=(await loadManifest(root))!.seededProjectDocuments!;
  for(const doc of receipts){
   const file=root+'/'+doc.target;
   await writeFile(file,(await readFile(file,'utf8')).replace('status: draft','status: confirmed')+'Apply this confirmed '+doc.topicId+' convention.\n');
  }
  const complete=await preview(await harnessPlan(root,cache,options),[],dependencies);
  assert.equal(complete.executable,true);
  await apply(complete.previewId,dependencies);
  const entry=root+'/AGENTS.md';
  const original=await readFile(entry,'utf8');
  for(const doc of receipts)assert.match(original,new RegExp(doc.topicId+'--'));
  await writeFile(entry,original.replace('## Project guidance','## Project guidance\n\nCustomer note in the owned region.')+'\nCustomer text outside the managed entry.\n');
  const api=receipts.find(receipt=>receipt.scope==='api')!;
  const apiPath=root+'/'+api.target;
  await writeFile(apiPath,(await readFile(apiPath,'utf8')).replace('status: confirmed','status: draft'));
  const prepare=async(scope:string[],skipUnchanged=false)=>{
   const selected={...options,scope};
   const profile=await scanRepository(root,selected);
   const previous=(await loadManifest(root))!;
   const plan=await generateFoundation(profile,selected,await prepareGeneration(profile,selected),previous.assets,true);
   return preview(plan,[],{...dependencies,reviewEntryBlocks:true,skipUnchanged});
  };
  for(const scope of [['api'],['web'],['.']]){
   const review=await prepare(scope);
   assert.equal(review.projectRules,'ready');
   assert.deepEqual(review.blockers,[]);
   await apply(review.previewId,dependencies);
   const current=await readFile(entry,'utf8');
   assert.doesNotMatch(current,/api-errors--/);
   assert.match(current,/ui-states--/);
   assert.match(current,/common--/);
   assert.match(current,/Customer note in the owned region/);
   assert.match(current,/Customer text outside the managed entry/);
   const asset=(await loadManifest(root))!.assets.find(asset=>asset.target==='AGENTS.md')!;
   assert.doesNotMatch((await trustedBaseline(root,asset))!,/Customer note in the owned region/);
  }
  assert.equal((await prepare(['.'],true)).noChanges,true);
 })));
});

for(const ambiguous of [false,true]){
 test('harness handles legacy convention references from their trusted baseline: '+(ambiguous?'ambiguous prose':'generated row'),async()=>{
  const {project,harnessPlan}=await import('./helpers.js');
  const {readFile,writeFile}=await import('node:fs/promises');
  const {digest}=await import('../src/analyzer/evidence.js');
  const {renderConventionSeed}=await import('../src/project-conventions.js');
  const {scanRepository}=await import('../src/analyzer/repository.js');
  const {generateFoundation,prepareGeneration}=await import('../src/generator/generate.js');
  const {loadManifest}=await import('../src/installer/baseline.js');
  const {preview}=await import('../src/installer/preview.js');
  const {apply}=await import('../src/installer/apply.js');
  await project(root=>project(cache=>project(async state=>{
   const options={agents:['codex' as const],backend:'host' as const,projectRules:true,projectConventions:{topics:[{id:'api-errors',title:'API errors',scope:['.'],source:'policy.md'}]}};
   await writeFile(root+'/policy.md','Use 400 for errors.\n');
   const initial=await harnessPlan(root,cache,options);
   const target='docs/rigup/development-rules.md';
   const content=ambiguous?'Use [the policy](../../policy.md) when comparing error shapes.\n':'- **API errors**\n  - [policy.md](../../policy.md) · .\n';
   initial.assets.push({logicalId:'project-development-rules',target,content,ownership:{kind:'file'},source:{kind:'semantic',ref:'legacy',digest:digest(content)}});
   const dependencies={cacheRoot:cache,stateRoot:state};
   await apply((await preview(initial,[],dependencies)).previewId,dependencies);
   const seed=renderConventionSeed({topicId:'api-errors',title:'API errors',scope:'.',questions:['Confirm the API contract']}).content;
   const edited=seed+'Unconfirmed customer content.\n';
   await writeFile(root+'/policy.md',edited);
   const profile=await scanRepository(root,options);
   const old=(await loadManifest(root))!;
   const next=await generateFoundation(profile,options,await prepareGeneration(profile,options),old.assets,true);
   const review=await preview(next,[],dependencies);
   assert.equal(review.projectRules,ambiguous?'pending':'ready');
   assert.equal(review.executable,true);
   await apply(review.previewId,dependencies);
   assert.equal(await readFile(root+'/policy.md','utf8'),edited);
   assert.equal(await readFile(root+'/'+target,'utf8'),ambiguous?content:'- **API errors**\n');
  })));
 });
}

test('harness preserves local navigation when the prior trusted baseline is unavailable',async()=>{
 const {project,harnessPlan,confirmedHarnessSource}=await import('./helpers.js');
 const {readFile,unlink}=await import('node:fs/promises');
 const {scanRepository}=await import('../src/analyzer/repository.js');
 const {generateFoundation,prepareGeneration}=await import('../src/generator/generate.js');
 const {loadManifest}=await import('../src/installer/baseline.js');
 const {preview}=await import('../src/installer/preview.js');
 const {apply}=await import('../src/installer/apply.js');
 await project(root=>project(cache=>project(async state=>{
  const settings={agents:['codex' as const],backend:'host' as const,projectRules:true};
  await confirmedHarnessSource(root,settings);
  const dependencies={cacheRoot:cache,stateRoot:state};
  await apply((await preview(await harnessPlan(root,cache,settings),[],dependencies)).previewId,dependencies);
  const manifest=(await loadManifest(root))!;
  const entry=manifest.assets.find(asset=>asset.target==='AGENTS.md')!;
  const local=await readFile(root+'/AGENTS.md','utf8');
  await unlink(root+'/'+entry.baseline);
  const profile=await scanRepository(root,settings);
  const plan=await generateFoundation(profile,settings,await prepareGeneration(profile,settings),manifest.assets,true);
  const review=await preview(plan,[],dependencies);
  assert.equal(review.executable,false);
  assert.equal(review.projectRules,'pending');
  assert.match(review.blockers.join('\n'),/trusted baseline/i);
  assert.equal(await readFile(root+'/AGENTS.md','utf8'),local);
 })));
});

test('harness keeps a prior confirmed row when a truncated scan misses its business scope',async()=>{
 const {project,harnessPlan,confirmedHarnessSource}=await import('./helpers.js');
 const {readFile}=await import('node:fs/promises');
 const {scanRepository}=await import('../src/analyzer/repository.js');
 const {generateFoundation,prepareGeneration}=await import('../src/generator/generate.js');
 const {loadManifest}=await import('../src/installer/baseline.js');
 const {preview}=await import('../src/installer/preview.js');
 const {apply}=await import('../src/installer/apply.js');
 await project(root=>project(cache=>project(async state=>{
  const settings={agents:['codex' as const],backend:'host' as const,projectRules:true,
   projectConventions:{topics:[{id:'api-errors',title:'API errors',scope:['api'],source:'knowledge/api-errors.md'}]}};
  await confirmedHarnessSource(root,settings);
  const dependencies={cacheRoot:cache,stateRoot:state};
  await apply((await preview(await harnessPlan(root,cache,settings),[],dependencies)).previewId,dependencies);
  const original=await readFile(root+'/AGENTS.md','utf8');
  const limited={...settings,readBudget:{maxFiles:1,maxBytes:100_000}};
  const profile=await scanRepository(root,limited);
  assert.equal(profile.truncated,true);
  const old=(await loadManifest(root))!;
  const update=await generateFoundation(profile,limited,await prepareGeneration(profile,limited),old.assets,true);
  const review=await preview(update,[],dependencies);
  assert.deepEqual(review.blockers,[]);
  await apply(review.previewId,dependencies);
  assert.equal(await readFile(root+'/AGENTS.md','utf8'),original);
 })));
});

test('harness scoped navigation cannot newly publish a broader conflicting policy',async()=>{
 const {project,harnessPlan}=await import('./helpers.js');
 const {mkdir,readFile,writeFile}=await import('node:fs/promises');
 const {renderConventionSeed}=await import('../src/project-conventions.js');
 const {scanRepository}=await import('../src/analyzer/repository.js');
 const {generateFoundation,prepareGeneration}=await import('../src/generator/generate.js');
 const {loadManifest}=await import('../src/installer/baseline.js');
 const {preview}=await import('../src/installer/preview.js');
 const {apply}=await import('../src/installer/apply.js');
 await project(root=>project(cache=>project(async state=>{
  const settings={agents:['codex' as const],backend:'host' as const,projectRules:true,
   projectConventions:{topics:[{id:'api-errors',title:'API errors',scope:['.'],source:'knowledge/shared.md'}]}};
  await Promise.all(['api','web','knowledge'].map(path=>mkdir(root+'/'+path)));
  await writeFile(root+'/web/page.ts','export const page = true;\n');
  const header=(scope:string)=>renderConventionSeed({topicId:'api-errors',title:'API errors',scope,questions:['Decide']}).content.replace('status: draft','status: confirmed');
  await writeFile(root+'/knowledge/shared.md',header('.')+'Use HTTP 400.\n');
  await writeFile(root+'/api/override.md',header('api')+'Use HTTP 422.\n');
  const dependencies={cacheRoot:cache,stateRoot:state};
  const initial=await preview(await harnessPlan(root,cache,settings),[],dependencies);
  assert.deepEqual(initial.harness?.guidance.map(binding=>binding.coverageStatus),['conflicting','conflicting']);
  await apply(initial.previewId,dependencies);
  const selected={...settings,scope:['web']};
  const profile=await scanRepository(root,selected);
  const old=(await loadManifest(root))!;
  const next=await generateFoundation(profile,selected,await prepareGeneration(profile,selected),old.assets,true);
  await apply((await preview(next,[],dependencies)).previewId,dependencies);
  assert.doesNotMatch(await readFile(root+'/AGENTS.md','utf8'),/knowledge\/shared\.md/);
 })));
});

test('harness preserves a removed local block and reports that its approved links are missing',async()=>{
 const {project,harnessPlan,confirmedHarnessSource}=await import('./helpers.js');
 const {readFile,writeFile}=await import('node:fs/promises');
 const {scanRepository}=await import('../src/analyzer/repository.js');
 const {generateFoundation,prepareGeneration}=await import('../src/generator/generate.js');
 const {loadManifest}=await import('../src/installer/baseline.js');
 const {preview}=await import('../src/installer/preview.js');
 const {apply}=await import('../src/installer/apply.js');
 await project(root=>project(cache=>project(async state=>{
  const settings={agents:['codex' as const],backend:'host' as const,projectRules:true};
  const {path}=await confirmedHarnessSource(root,settings);
  await writeFile(root+'/'+path,(await readFile(root+'/'+path,'utf8')).replace('title: API errors','title: Error [API] contract'));
  const dependencies={cacheRoot:cache,stateRoot:state};
  await apply((await preview(await harnessPlan(root,cache,settings),[],dependencies)).previewId,dependencies);
  const prepare=async()=>{
   const profile=await scanRepository(root,settings);
   const old=(await loadManifest(root))!;
   return preview(await generateFoundation(profile,settings,await prepareGeneration(profile,settings),old.assets,true),[],{...dependencies,reviewEntryBlocks:true,skipUnchanged:true});
  };
  const unchanged=await prepare();
  assert.equal(unchanged.projectRules,'ready');
  assert.equal(unchanged.noChanges,true);
  const entry=root+'/AGENTS.md';
  const local=(await readFile(entry,'utf8')).replace(/<!-- rigup:harness:start -->[\s\S]*?<!-- rigup:harness:end -->\n/,'');
  await writeFile(entry,local);
  const review=await prepare();
  assert.equal(review.executable,false);
  assert.equal(review.projectRules,'pending');
  assert.match(review.blockers.join('\n'),/local convention navigation differs/);
  assert.equal(await readFile(entry,'utf8'),local);
 })));
});
