import {test} from 'node:test';import assert from 'node:assert/strict';
import {project} from './helpers.js';import {mkdir,writeFile,readFile,symlink} from 'node:fs/promises';
import {preview} from '../src/installer/preview.js';import {ownedContent,replaceOwned,targetPath} from '../src/installer/ownership.js';
import {doctor} from '../src/installer/doctor.js';
import type {SetupPlan,ManagedAsset} from '../src/types.js';import {digest} from '../src/analyzer/evidence.js';
function plan(root:string,target='owned.md',content='next'):SetupPlan{return {root,fingerprint:'source',options:{agents:[],backend:'host'},assets:[{logicalId:'a',target,content,ownership:{kind:'file'},source:{kind:'test',ref:'test'}}],dispositions:[],operations:[],warnings:[],requirements:[],versions:{}};}
async function fixture(fn:(root:string,cache:string)=>Promise<void>){await project(async root=>project(async cache=>fn(root,cache)));}
async function manifest(root:string,asset:Partial<ManagedAsset>={},base='base'){
 await mkdir(root+'/.rigup/baseline/old',{recursive:true});await writeFile(root+'/.rigup/baseline/old/a',base);
 const a={logicalId:'a',target:'owned.md',ownership:{kind:'file'},digest:digest(base),baseline:'.rigup/baseline/old/a',...asset};await writeFile(root+'/.rigup/manifest.json',JSON.stringify({schemaVersion:1,installId:'old',assets:[a]}));return a;
}
test('preview_is_read_only_and_existing_unowned_target_conflicts',()=>fixture(async(root,cache)=>{
 await writeFile(root+'/owned.md','user');const p=await preview(plan(root),[],{cacheRoot:cache});assert.equal(p.executable,false);assert.equal(p.items[0].action,'conflict');assert.equal(await readFile(root+'/owned.md','utf8'),'user');
}));
test('jsonc_comments_and_unknown_fields_survive',()=>{
 const text='{\n // Keep this comment\n "secret":"CUSTOMER_SECRET", "mcp":{"old":{"x":1}}\n}';const o={kind:'json-key' as const,path:['mcp','new']};const next=replaceOwned(text,o,'{"command":"tool"}')!;assert.match(next,/Keep this comment/);assert.match(next,/CUSTOMER_SECRET/);assert.match(next,/"old"/);assert.equal(JSON.parse(ownedContent(next,o)!).command,'tool');
});
test('toml_unowned_tables_survive',()=>{
 const text='secret = "CUSTOMER_SECRET"\n\n[mcp_servers.old]\ncommand = "old"\n';const o={kind:'toml-table' as const,path:['mcp_servers','new']};const result=replaceOwned(text,o,'[mcp_servers.new]\ncommand = "new"\n')!;assert.ok(result.startsWith(text));assert.match(result,/command = "new"/);
});
test('nested MCP layout is not a local change and does not block a generated update',()=>fixture(async(root,cache)=>{
 const target='.mcp.json',ownership={kind:'json-key' as const,path:['mcpServers','tool']};
 const base='{\n  "command": "node",\n  "args": ["old.mjs"]\n}';
 const local='{\n  // Retain this unowned comment\n  "mcpServers": {\n    "tool": {\n      "args": ["old.mjs"],\n      "command": "node",\n    },\n    "other": {"command": "other-tool"}\n  }\n}\n';
 await manifest(root,{target,ownership},base);
 await writeFile(root+'/'+target,local);
 const diagnostic=async()=>(await doctor(root)).diagnostics.find(d=>d.id==='a')?.state;
 assert.equal(await diagnostic(),'configured');
 const candidate=plan(root,target,base);
 candidate.assets[0].ownership=ownership;
 candidate.dispositions=[{logicalId:'a',action:'update',reason:'refresh binding'}];
 const noop=await preview(candidate,[],{cacheRoot:cache});
 assert.equal(noop.items[0].action,'noop');
 assert.equal((await loadPreview(noop.previewId,cache)).files[0].next,local);

 candidate.assets[0].content=base.replace('old.mjs','new.mjs');
 const updated=await preview(candidate,[],{cacheRoot:cache});
 assert.equal(updated.executable,true);
 assert.equal(updated.items[0].action,'update');
 const next=(await loadPreview(updated.previewId,cache)).files[0].next!;
 assert.match(next,/Retain this unowned comment/);
 assert.match(next,/"other-tool"/);
 assert.equal(JSON.parse(ownedContent(next,ownership)!).args[0],'new.mjs');

 await writeFile(root+'/'+target,local.replace('old.mjs','local.mjs'));
 assert.equal(await diagnostic(),'pending');
 assert.equal((await preview(candidate,[],{cacheRoot:cache})).items[0].action,'conflict');
}));
test('structured comparison keeps independent edits mergeable as text',()=>fixture(async(root,cache)=>{
 const target='.mcp.json',ownership={kind:'json-key' as const,path:['mcpServers','tool']};
 const base='{\n  "command": "node",\n  "args": ["old.mjs"],\n\n  "env": {"MODE": "old"}\n}';
 const local=base.replace('"MODE": "old"','"MODE": "local"');
 await manifest(root,{target,ownership},base);
 await writeFile(root+'/'+target,'{"mcpServers":{"tool":'+local+'}}');
 const candidate=plan(root,target,base.replace('old.mjs','new.mjs'));
 candidate.assets[0].ownership=ownership;
 candidate.dispositions=[{logicalId:'a',action:'update',reason:'refresh binding'}];
 const updated=await preview(candidate,[],{cacheRoot:cache});
 assert.equal(updated.items[0].action,'update');
 assert.equal(updated.executable,false);
 assert.match(updated.blockers.join('\n'),/differs from accepted configuration/);
 const next=(await loadPreview(updated.previewId,cache)).files[0].next!;
 assert.deepEqual(JSON.parse(ownedContent(next,ownership)!),{command:'node',args:['new.mjs'],env:{MODE:'local'}});
}));
test('a TOML table with the same values and different layout is a no-op',()=>fixture(async(root,cache)=>{
 const target='config.toml',ownership={kind:'toml-table' as const,path:['mcp_servers','tool']};
 const base='[mcp_servers.tool]\ncommand = "node"\nargs = ["serve"]\n';
 const local='[mcp_servers.tool]\nargs=["serve"] # launch argument\ncommand="node"\n';
 await manifest(root,{target,ownership},base);
 await writeFile(root+'/'+target,local);
 const candidate=plan(root,target,base);
 candidate.assets[0].ownership=ownership;
 candidate.dispositions=[{logicalId:'a',action:'update',reason:'refresh binding'}];
 const result=await preview(candidate,[],{cacheRoot:cache});
 assert.equal(result.items[0].action,'noop');
 assert.equal((await loadPreview(result.previewId,cache)).files[0].next,local);
}));
test('a duplicate JSONC property cannot select a managed binding',()=>{
 const ownership={kind:'json-key' as const,path:['mcpServers','tool']};
 for(const text of ['{"mcpServers":{"tool":{},"tool":{}}}','{"mcpServers":{"tool":{"command":"a","command":"b"}}}']){
  assert.throws(()=>ownedContent(text,ownership),/duplicate/i);
 }
});
test('malformed_markers_need_manual_patch',()=>assert.throws(()=>ownedContent('before\n<!-- rigup:start -->\nbroken',{kind:'block',start:'<!-- rigup:start -->',end:'<!-- rigup:end -->'}),/marker/));
test('baseline_never_copies_unowned_secrets_and_public_preview_does_not_leak',()=>fixture(async(root,cache)=>{
 const p=plan(root,'config.json','{"command":"tool"}');p.assets[0].ownership={kind:'json-key',path:['mcp','tool']};await writeFile(root+'/config.json','{"secret":"CUSTOMER_SECRET"}');const r=await preview(p,[],{cacheRoot:cache});assert.equal(r.executable,true);assert.doesNotMatch(JSON.stringify(r),/CUSTOMER_SECRET/);
}));
test('old_inventory_omission_and_untrusted_retained_baseline_block',()=>fixture(async(root,cache)=>{
 await manifest(root);await assert.rejects(()=>preview(plan(root),[],{cacheRoot:cache}),/disposition/);const p=plan(root);p.assets=[];p.dispositions=[{logicalId:'a',action:'retain',reason:'keep'}];await writeFile(root+'/.rigup/baseline/old/a','tampered');const r=await preview(p,[],{cacheRoot:cache});assert.equal(r.executable,false);
}));
test('resolution_binds_exact_full_target_digest_and_selector',()=>fixture(async(root,cache)=>{
 await writeFile(root+'/owned.md','user');await assert.rejects(()=>preview(plan(root),[{target:'owned.md',selector:{kind:'file'},observedDigest:digest('stale'),action:'adopt'}],{cacheRoot:cache}),/changed|digest/);
 const r=await preview(plan(root),[{target:'owned.md',selector:{kind:'file'},observedDigest:digest('user'),action:'replace'}],{cacheRoot:cache});assert.equal(r.executable,true);
}));
test('kept_local_content_cannot_break_required_bindings',()=>fixture(async(root,cache)=>{
 const base='[guide](guide.md)\n';await manifest(root,{},base);await writeFile(root+'/owned.md','[guide](missing.md)\n');await writeFile(root+'/guide.md','guide');const p=plan(root,'owned.md',base);p.dispositions=[{logicalId:'a',action:'update',reason:'refresh'}];const r=await preview(p,[],{cacheRoot:cache});assert.equal(r.executable,false);assert.ok(r.blockers.some((s:string)=>/link|navigation/.test(s)));
}));
test('protected preview treats escaped rule text as prose',()=>fixture(async(root,cache)=>{
 const result=await preview(plan(root,'owned.md','Use the literal \\[A-Z\\](42) in the filter.'),[],{cacheRoot:cache});
 assert.equal(result.executable,true);
 const missing=await preview(plan(root,'owned.md','Escaped slash \\\\[missing](missing.md)'),[],{cacheRoot:cache});
 assert.equal(missing.executable,false);
}));
test('preview_denies_symlinked_target',()=>fixture(async(root,cache)=>{
 await symlink(cache,root+'/linked',process.platform==='win32'?'junction':'dir');await assert.rejects(()=>preview(plan(root,'linked/file.md'),[],{cacheRoot:cache}),/symlink/);
}));
test('Windows rejects drive-relative components, NTFS streams and DOS device aliases',{skip:process.platform!=='win32'},()=>project(async root=>{
 for(const target of ['docs/D:outside.md','docs/file.md:stream','docs/NUL.md','docs/COM¹.md','docs/alias./file.md','docs/alias /file.md']){
  await assert.rejects(()=>targetPath(root,target),/target escapes root/,target);
 }
}));
test('Windows previews reject case aliases for installer metadata and planned files',{skip:process.platform!=='win32'},()=>fixture(async(root,cache)=>{
 await assert.rejects(()=>preview(plan(root,'.RIGUP/Manifest.JSON'),[],{cacheRoot:cache}),/metadata target reserved/);
 const p=plan(root,'docs/Readme.md');
 p.assets.push({...p.assets[0],logicalId:'b',target:'docs/README.md'});
 await assert.rejects(()=>preview(p,[],{cacheRoot:cache}),/target aliases/);
}));
import {loadPreview} from '../src/installer/preview.js';
test('retained_candidate_cannot_silently_replace_old_baseline',()=>fixture(async(root,cache)=>{
 await manifest(root);await writeFile(root+'/owned.md','base');const p=plan(root);p.dispositions=[{logicalId:'a',action:'retain',reason:'keep'}];await assert.rejects(()=>preview(p,[],{cacheRoot:cache}),/retain|baseline/);
}));
test('unrelated_local_edits_remain_preserved_and_baseline_contains_only_N',()=>fixture(async(root,cache)=>{
 const o={kind:'block' as const,start:'<!-- rigup:start -->',end:'<!-- rigup:end -->'};const base=o.start+'\nold\n'+o.end+'\n',next=o.start+'\nnew\n'+o.end+'\n';await manifest(root,{ownership:o},base);await writeFile(root+'/owned.md','User CUSTOMER_SECRET\n'+base+'Unrelated note\n');const p=plan(root,'owned.md',next);p.assets[0].ownership=o;p.dispositions=[{logicalId:'a',action:'update',reason:'refresh'}];const r=await preview(p,[],{cacheRoot:cache});assert.equal(r.executable,true);const data=await loadPreview(r.previewId,cache);assert.match(data.files[0].next!,/CUSTOMER_SECRET/);assert.equal(data.baselines[0].content,next);assert.doesNotMatch(JSON.stringify(data.baselines),/CUSTOMER_SECRET/);assert.doesNotMatch(JSON.stringify(r),/CUSTOMER_SECRET/);
}));
test('nonoverlapping_merge_still_checks_reference_targets',()=>fixture(async(root,cache)=>{
 const base='title\n\nbody\n\n[guide](guide.md)\n';await manifest(root,{},base);await writeFile(root+'/owned.md','local title\n\nbody\n\n[guide](missing.md)\n');const p=plan(root,'owned.md','title\n\nnew body\n\n[guide](guide.md)\n');p.dispositions=[{logicalId:'a',action:'update',reason:'refresh'}];const r=await preview(p,[],{cacheRoot:cache});assert.equal(r.executable,false);assert.ok(r.blockers.some(b=>/navigation/.test(b)));
}));
test('candidate_overlap_and_fabricated_external_recipe_are_blocked',()=>fixture(async(root,cache)=>{
 const p=plan(root);p.operations=[{id:'evil',integrationId:'openwiki',kind:'install',parameters:{executable:'sh',args:['-c','touch owned.md'],cwd:root,envRefs:[]},prerequisiteIds:[],declaredWrites:['.'],version:'0.7.3',timeoutMs:100,protection:{kind:'new-empty-scope',target:'.'},query:{kind:'npm-package',name:'openwiki',version:'0.7.3',packageJson:'package.json',packageLock:'package-lock.json'}}];const r=await preview(p,[],{cacheRoot:cache});assert.equal(r.executable,false);assert.ok(r.blockers.some(b=>/recipe|protection/.test(b)));
}));
test('retirement_only_removes_unmodified_owned_selector',()=>fixture(async(root,cache)=>{
 const o={kind:'json-key' as const,path:['mcp','managed']};const base='{"command":"tool"}';await manifest(root,{target:'config.json',ownership:o},base);await writeFile(root+'/config.json','{"secret":"CUSTOMER_SECRET","mcp":{"managed":'+base+',"other":{"command":"other"}}}');const p=plan(root);p.assets=[];p.dispositions=[{logicalId:'a',action:'retire',reason:'explicitly unselected'}];const r=await preview(p,[],{cacheRoot:cache});assert.equal(r.executable,true);const d=await loadPreview(r.previewId,cache);assert.equal(d.assets.length,0);assert.match(d.files[0].next!,/CUSTOMER_SECRET/);assert.match(d.files[0].next!,/other/);assert.doesNotMatch(d.files[0].next!,/managed/);
}));
test('local_deletion_of_fixed_consumer_binding_blocks_even_when_N_equals_B',()=>fixture(async(root,cache)=>{
 const base='# Entry\n\n[guide](guide.md)\n';await manifest(root,{},base);await writeFile(root+'/owned.md','# Entry\n\nA local note\n');await writeFile(root+'/guide.md','guide');const p=plan(root,'owned.md',base);p.assets[0].source.kind='fixed-template';p.dispositions=[{logicalId:'a',action:'update',reason:'refresh'}];const r=await preview(p,[],{cacheRoot:cache});assert.equal(r.items[0].action,'keep');assert.equal(r.executable,false);assert.ok(r.blockers.some(b=>/binding removed/.test(b)));assert.equal(await readFile(root+'/owned.md','utf8'),'# Entry\n\nA local note\n');
}));
test('generated_candidates_cannot_target_installer_metadata',()=>fixture(async(root,cache)=>{
 await assert.rejects(()=>preview(plan(root,'.rigup/manifest.json'),[],{cacheRoot:cache}),/metadata|reserved/);
}));
test('explicit_identity_replacement_uses_old_B_and_preserves_local_changes',()=>fixture(async(root,cache)=>{
 await manifest(root,{},'line1\nline2\nline3\nline4\n');await writeFile(root+'/owned.md','local\nline2\nline3\nline4\n');const p=plan(root,'owned.md','line1\nline2\nline3\nnext\n');p.assets[0].logicalId='replacement';p.dispositions=[{logicalId:'a',action:'retire',reason:'explicit identity replacement'}];const r=await preview(p,[],{cacheRoot:cache});assert.equal(r.executable,true);const data=await loadPreview(r.previewId,cache);assert.deepEqual(data.assets.map(a=>a.logicalId),['replacement']);assert.equal(data.files[0].next,'local\nline2\nline3\nnext\n');
}));
import {generate} from '../src/generator/generate.js';import {scanRepository} from '../src/analyzer/repository.js';import {apply} from '../src/installer/apply.js';import {loadManifest} from '../src/installer/baseline.js';
test('kept_local_gitlab_include_cannot_remove_required_ci_binding',()=>fixture(async(root,cache)=>project(async state=>{
 await writeFile(root+'/package.json',JSON.stringify({scripts:{test:'node -e "process.exit(0)"'}}));const options={agents:['codex' as const],backend:'host' as const,quality:{gitlab:{checks:['test' as const]}}};const backend={run:async()=>{throw Error('no model');}};
 let generated=await generate(await scanRepository(root,options),options,backend,[],{cacheRoot:cache});if(generated.status!=='complete')throw Error('pending');await apply((await preview(generated.value,[],{cacheRoot:cache})).previewId,{cacheRoot:cache,stateRoot:state});const original=await readFile(root+'/.gitlab-ci.yml','utf8');await writeFile(root+'/.gitlab-ci.yml',original.replace('.rigup/gitlab-ci.yml','customer.yml'));await writeFile(root+'/customer.yml','customer: {script: echo customer}\n');
 generated=await generate(await scanRepository(root,options),options,backend,(await loadManifest(root))!.assets,{cacheRoot:cache});if(generated.status!=='complete')throw Error('pending');const p=await preview(generated.value,[],{cacheRoot:cache});assert.equal(p.executable,false);assert.ok(p.blockers.some(b=>/CI|include|binding/.test(b)));
})));

test('harness preserves global CI during scoped updates',()=>fixture(async(root,cache)=>project(async state=>{
 const {generateFoundation,prepareGeneration}=await import('../src/generator/generate.js');
 const {loadManifest,trustedBaseline}=await import('../src/installer/baseline.js');
 const {mkdir}=await import('node:fs/promises');
 const {parse}=await import('yaml');
 const ci='.gitlab-ci.yml',jobs='.rigup/gitlab-ci.yml';
 const original='customer:\n  script: echo customer\n';
 await writeFile(root+'/'+ci,original);
 for(const cwd of ['api','web']){
  await mkdir(root+'/'+cwd);
  await writeFile(root+'/'+cwd+'/package.json','{"scripts":{"build":"node build.js"}}');
 }
 const settings={agents:[],backend:'host' as const,quality:{gitlab:{checks:[{cwd:'api',script:'build'},{cwd:'web',script:'build'}]}}};
 const backend={run:async()=>{throw Error('no model');}};
 async function review(options:typeof settings & {scope?:string[]},foundation=false){
  const profile=await scanRepository(root,options);
  const old=(await loadManifest(root))?.assets??[];
  const plan=foundation
   ?await generateFoundation(profile,options,await prepareGeneration(profile,options),old)
   :await generate(profile,options,backend,old,{cacheRoot:cache}).then(result=>{
     if(result.status!=='complete')throw Error('pending');
     return result.value;
    });
  return preview(plan,[],{cacheRoot:cache});
 }
 const commands=async()=>parse(await readFile(root+'/'+jobs,'utf8'))['rigup:checks'].script.slice(1);
 const install=async(options:typeof settings & {scope?:string[]},foundation=false)=>{
  const result=await review(options,foundation);
  assert.deepEqual(result.blockers,[]);
  return apply(result.previewId,{cacheRoot:cache,stateRoot:state});
 };
 const initial=await install(settings);
 assert.deepEqual(initial.checks,[]);
 assert.deepEqual(initial.harness?.checks.map(check=>check.command.cwd),['api','web']);
 assert.deepEqual(await commands(),["(cd 'api' && 'npm' 'run' 'build')","(cd 'web' && 'npm' 'run' 'build')"]);
 const initialManifest=(await loadManifest(root))!;
 const jobAsset=initialManifest.assets.find(asset=>asset.target===jobs)!;
 const base=await trustedBaseline(root,jobAsset);
 const ciBytes=await readFile(root+'/'+ci,'utf8')+'# customer local edit\n';
 await writeFile(root+'/'+ci,ciBytes);
 const edited=(await readFile(root+'/'+jobs,'utf8'))+'# customer job comment\n';
 await writeFile(root+'/'+jobs,edited);
 const scoped={...settings,scope:['api']};
 for(const foundation of [false,true,true]){
  const applied=await install(scoped,foundation);
  assert.ok(applied.warnings.some(note=>/root review/.test(note)));
  assert.deepEqual(applied.written,[]);
  assert.equal(await readFile(root+'/'+ci,'utf8'),ciBytes);
  assert.equal(await readFile(root+'/'+jobs,'utf8'),edited);
  assert.equal(await trustedBaseline(root,(await loadManifest(root))!.assets.find(asset=>asset.target===jobs)!),base);
 }
 const reviewed={...settings,quality:{gitlab:{checks:[{cwd:'api',script:'build'}]}}};
 await install(reviewed);
 assert.deepEqual(await commands(),["(cd 'api' && 'npm' 'run' 'build')"]);
 assert.equal(await readFile(root+'/'+ci,'utf8'),ciBytes);
 assert.match(await readFile(root+'/'+jobs,'utf8'),/# customer job comment/);
 assert.deepEqual((await install(reviewed)).written,[]);
})));

test('harness preserves explicit GitLab selection',()=>fixture(async(root,cache)=>project(async state=>{
 const backend={run:async()=>{throw Error('no model');}};
 const original='customer:\n  script: npm run build\n';
 await writeFile(root+'/.gitlab-ci.yml',original);
 await writeFile(root+'/package.json','{"scripts":{"build":"node build.js"}}');
 for(const selected of [false,true]){
  const settings={agents:[],backend:'host' as const,...(selected?{quality:{gitlab:{checks:['build' as const]}}}:{})};
  const result=await generate(await scanRepository(root,settings),settings,backend,[],{cacheRoot:cache});
  if(result.status!=='complete')throw Error('pending');
  const review=await preview(result.value,[],{cacheRoot:cache});
  assert.equal(review.executable,true);
  assert.equal(review.harness?.ci[0]?.coverageStatus,'reusable');
  const installed=await apply(review.previewId,{cacheRoot:cache,stateRoot:state});
  assert.deepEqual(installed.checks,[]);
  const actual=await readFile(root+'/.gitlab-ci.yml','utf8');
  if(selected){
   assert.ok(actual.startsWith(original));
   assert.ok(actual.includes('.rigup/gitlab-ci.yml'));
  }else assert.equal(actual,original);
 }
})));

test('harness gaps are informational while scanned missing checks still block',()=>fixture(async(root,cache)=>{
 await writeFile(root+'/package.json','{"scripts":{"build":"node build.js"}}');
 const settings={agents:[],backend:'host' as const,projectRules:true};
 const guidance={topic:'Errors',topicId:'api-errors',scope:['.'],coverageStatus:'missing',consumers:['prepare'],gaps:['Decide the error envelope']};
 const backend={run:async()=>({status:'complete' as const,value:{data:{observations:[],guidance:[guidance],artifacts:[],dispositions:[]},model:'fixture',unknowns:[],usage:{calls:1,tokens:1}}})};
 const generated=await generate(await scanRepository(root,settings),settings,backend,[],{cacheRoot:cache});
 if(generated.status!=='complete')throw Error('pending');
 const review=await preview(generated.value,[],{cacheRoot:cache});
 assert.equal(review.executable,true);
 assert.deepEqual(review.blockers,[]);
 assert.deepEqual(review.harness?.guidance[0]?.gaps,guidance.gaps);

 const scoped={...settings,scope:['package.json'],quality:{gitlab:{checks:[{cwd:'.',script:'lint'}]}}};
 const blocked=await generate(await scanRepository(root,scoped),scoped,backend,[],{cacheRoot:cache});
 if(blocked.status!=='complete')throw Error('pending');
 assert.match((await preview(blocked.value,[],{cacheRoot:cache})).blockers.join('\n'),/npm run lint: Select an existing project command/);
}));

test('harness still blocks missing npm kinds when only GitLab is ignored',()=>fixture(async(root,cache)=>{
 await writeFile(root+'/package.json','{"scripts":{"build":"node build.js"}}');
 await writeFile(root+'/.rigupignore','/.gitlab-ci.yml\n');
 const settings={agents:[],backend:'host' as const,quality:{gitlab:{checks:['lint' as const]}}};
 const result=await generate(await scanRepository(root,settings),settings,{run:async()=>{throw Error('no model');}},[],{cacheRoot:cache});
 if(result.status!=='complete')throw Error('pending');
 const review=await preview(result.value,[],{cacheRoot:cache});
 assert.equal(review.executable,false);
 assert.match(review.blockers.join('\n'),/lint: Select an existing project command/);
}));
