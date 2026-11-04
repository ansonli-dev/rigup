import {test} from 'node:test';import assert from 'node:assert/strict';
import {project,setNativeEntries} from './helpers.js';import {mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {scanRepository} from '../src/analyzer/repository.js';import {preview} from '../src/installer/preview.js';import {apply} from '../src/installer/apply.js';import {loadManifest} from '../src/installer/baseline.js';
import type {SetupPlan} from '../src/types.js';
async function fixture(fn:(root:string,cache:string,state:string)=>Promise<void>){await project(async root=>project(async cache=>project(async state=>fn(root,cache,state))));}
async function plan(root:string,content='new'):Promise<SetupPlan>{const options={agents:[],backend:'host' as const};return {root,fingerprint:(await scanRepository(root,options)).fingerprint,options,assets:[{logicalId:'guide',target:'guide.md',content,ownership:{kind:'file'},source:{kind:'test',ref:'test'}}],operations:[],dispositions:[],warnings:[],requirements:[],versions:{}};}
test('dry_run_has_no_project_side_effect',()=>fixture(async(root,cache,state)=>{
 const before=await readdir(root);await preview(await plan(root),[],{cacheRoot:cache});assert.deepEqual(await readdir(root),before);
}));
test('apply_saves_generated_baseline_and_second_apply_is_idempotent',()=>fixture(async(root,cache,state)=>{
 const p=await preview(await plan(root),[],{cacheRoot:cache});const first=await apply(p.previewId,{cacheRoot:cache,stateRoot:state});assert.equal(first.status,'complete');assert.equal(await readFile(root+'/guide.md','utf8'),'new');const m=await loadManifest(root);assert.equal(await readFile(root+'/'+m!.assets[0].baseline,'utf8'),'new');const second=await apply(p.previewId,{cacheRoot:cache,stateRoot:state});assert.equal(second.status,'complete');assert.deepEqual(second.written,[]);
}));
test('stale_preview_is_rejected_before_any_writes',()=>fixture(async(root,cache,state)=>{
 const p=await preview(await plan(root),[],{cacheRoot:cache});await writeFile(root+'/guide.md','user new');await assert.rejects(()=>apply(p.previewId,{cacheRoot:cache,stateRoot:state}),/stale|changed/);assert.equal(await readFile(root+'/guide.md','utf8'),'user new');
}));
test('manifest_failure_keeps_old_baseline_valid_and_recovery_does_not_overwrite',()=>fixture(async(root,cache,state)=>{
 let p=await preview(await plan(root,'base'),[],{cacheRoot:cache});await apply(p.previewId,{cacheRoot:cache,stateRoot:state});const old=await loadManifest(root);const next=await plan(root,'next');next.dispositions=[{logicalId:'guide',action:'update',reason:'next'}];p=await preview(next,[],{cacheRoot:cache});await assert.rejects(()=>apply(p.previewId,{cacheRoot:cache,stateRoot:state,hook:async(point:string)=>{if(point==='before-manifest')throw Error('manifest failure');}}),/manifest failure/);assert.equal((await loadManifest(root))!.installId,old!.installId);assert.equal(await readFile(root+'/'+old!.assets[0].baseline,'utf8'),'base');
 assert.equal((await apply(p.previewId,{cacheRoot:cache,stateRoot:state})).status,'complete');assert.equal(await readFile(root+'/guide.md','utf8'),'next');
}));
test('project_check_failure_saves_successful_wiring_but_check_damage_does_not',()=>fixture(async(root,cache,state)=>{
 const p=await preview(await plan(root),[],{cacheRoot:cache});const r=await apply(p.previewId,{cacheRoot:cache,stateRoot:state,runChecks:async()=>[{status:'failed',name:'unit tests'}]});assert.equal(r.exitCode,1);assert.ok(await loadManifest(root));
}));
test('lost_cache_does_not_authorize_overwrite',()=>fixture(async(root,cache,state)=>{
 const p=await preview(await plan(root),[],{cacheRoot:cache});await rm(cache,{recursive:true,force:true});await writeFile(root+'/guide.md','user');await assert.rejects(()=>apply(p.previewId,{cacheRoot:cache,stateRoot:state}),/missing|corrupt/);assert.equal(await readFile(root+'/guide.md','utf8'),'user');
}));
import {generate} from '../src/generator/generate.js';import type {AnalysisBackend} from '../src/analyzer/backend.js';
test('unchanged_update_reuses_candidates_after_install',()=>fixture(async(root,cache,state)=>{
 const options={agents:['codex' as const],backend:'host' as const,sdd:'openspec' as const};await writeFile(root+'/source.ts','export const value=1;');let calls=0;
 const backend:AnalysisBackend={run:async r=>{calls++;return {status:'complete',value:{data:{observations:[],unknowns:[],...(r.expectedOutput==='plan'?{artifacts:[],dispositions:[]}:r.expectedOutput==='acceptance'?{accepted:true,reason:'sufficient'}:{content:'guide'})},model:'test',unknowns:[],usage:{calls:1,tokens:1}}};}};
 let profile=await scanRepository(root,options);setNativeEntries(profile,{codex:['openspec-propose','openspec-apply-change','openspec-archive-change']});const result=await generate(profile,options,backend,[],{cacheRoot:cache});if(result.status!=='complete')throw Error('pending');const first=await preview(result.value,[],{cacheRoot:cache});assert.equal(first.executable,true);await apply(first.previewId,{cacheRoot:cache,stateRoot:state});
 for(let i=0;i<2;i++){profile=await scanRepository(root,options);setNativeEntries(profile,{codex:['openspec-propose','openspec-apply-change','openspec-archive-change']});const next=await generate(profile,options,backend,(await loadManifest(root))!.assets,{cacheRoot:cache});if(next.status!=='complete')throw Error('pending');const p=await preview(next.value,[],{cacheRoot:cache});assert.equal(p.executable,true);assert.ok(p.items.every(i=>i.action==='noop'||i.action==='keep'));assert.deepEqual((await apply(p.previewId,{cacheRoot:cache,stateRoot:state})).written,[]);}
 assert.equal(calls,1);
}));
test('cached_generation_still_detects_managed_edits_and_deletes',()=>fixture(async(root,cache,state)=>{
 let p=await preview(await plan(root),[],{cacheRoot:cache});await apply(p.previewId,{cacheRoot:cache,stateRoot:state});await rm(root+'/guide.md');const next=await plan(root);next.dispositions=[{logicalId:'guide',action:'update',reason:'refresh'}];p=await preview(next,[],{cacheRoot:cache});assert.equal(p.executable,false);assert.equal(p.items[0].action,'conflict');
}));
test('selected_check_that_damages_wiring_does_not_commit_manifest',()=>fixture(async(root,cache,state)=>{
 const p=await preview(await plan(root),[],{cacheRoot:cache});await assert.rejects(()=>apply(p.previewId,{cacheRoot:cache,stateRoot:state,runChecks:async()=>{await writeFile(root+'/guide.md','damaged');return [{status:'failed',name:'mutating check'}];}}),/configuration differs/);assert.equal(await loadManifest(root),undefined);assert.equal(await readFile(root+'/guide.md','utf8'),'damaged');
}));
test('crash_after_manifest_switch_reconciles_committed_result',()=>fixture(async(root,cache,state)=>{
 const p=await preview(await plan(root),[],{cacheRoot:cache});await assert.rejects(()=>apply(p.previewId,{cacheRoot:cache,stateRoot:state,hook:async(point:string)=>{if(point==='after-manifest')throw Error('crashed after manifest');}}),/after manifest/);const installed=await loadManifest(root);assert.ok(installed);assert.equal((await apply(p.previewId,{cacheRoot:cache,stateRoot:state})).status,'complete');
}));
test('sigint_waits_for_inflight_local_write_before_unlock_and_returns_130',()=>fixture(async(root,cache,state)=>{
 const p=await preview(await plan(root),[],{cacheRoot:cache});const controller=new AbortController();let ready!:()=>void;const entered=new Promise<void>(r=>ready=r);let finish!:()=>void;const wait=new Promise<void>(r=>finish=r);
 const first=apply(p.previewId,{cacheRoot:cache,stateRoot:state,signal:controller.signal,hook:async point=>{if(point==='after-file'){controller.abort();ready();await wait;}}});await entered;
 await assert.rejects(()=>apply(p.previewId,{cacheRoot:cache,stateRoot:state}),/locked/);finish();const r=await first;assert.equal(r.exitCode,130);assert.equal(await loadManifest(root),undefined);
}));
test('deterministic_mcp_update_does_not_require_a_model_or_overwrite_unrelated_config',()=>fixture(async(root,cache,state)=>{
 const base={agents:['codex' as const],backend:'host' as const,mcp:[{id:'docs',agents:['codex' as const],url:'https://example.org/mcp'}]};let calls=0;const backend:AnalysisBackend={run:async()=>{calls++;throw Error('no model');}};
 const first=await generate(await scanRepository(root,base),base,backend,[],{cacheRoot:cache});if(first.status!=='complete')throw Error('pending');await apply((await preview(first.value,[],{cacheRoot:cache})).previewId,{cacheRoot:cache,stateRoot:state});const next={...base,mcp:[{...base.mcp[0],url:'https://example.org/new-mcp'}]};const generated=await generate(await scanRepository(root,next),next,backend,(await loadManifest(root))!.assets,{cacheRoot:cache});if(generated.status!=='complete')throw Error('pending');const p=await preview(generated.value,[],{cacheRoot:cache});assert.equal(p.executable,true);await apply(p.previewId,{cacheRoot:cache,stateRoot:state});assert.match(await readFile(root+'/.codex/config.toml','utf8'),/new-mcp/);assert.equal(calls,0);
}));
test('changed_external_template_source_rejects_old_preview',()=>fixture(async(root,cache,state)=>{
 await writeFile(cache+'/template.md','Original guidance');const options={agents:['codex' as const],backend:'host' as const,templates:[{source:cache+'/template.md',target:'docs/rigup/custom.md'}]};const backend:AnalysisBackend={run:async()=>{throw Error('no model');}};const generated=await generate(await scanRepository(root,options),options,backend,[],{cacheRoot:cache});if(generated.status!=='complete')throw Error('pending');const p=await preview(generated.value,[],{cacheRoot:cache});await writeFile(cache+'/template.md','Different guidance');await assert.rejects(()=>apply(p.previewId,{cacheRoot:cache,stateRoot:state}),/source|template/);assert.equal(await loadManifest(root),undefined);
}));
import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {pathToFileURL} from 'node:url';import {resolve} from 'node:path';
const exec=promisify(execFile);
test('sigkill_after_file_reconciles_real_files_with_explicit_stale_lock_recovery',()=>fixture(async(root,cache,state)=>{
 const p=await preview(await plan(root),[],{cacheRoot:cache});const script=`import {apply} from ${JSON.stringify(pathToFileURL(resolve('src/installer/apply.ts')).href)};await apply(${JSON.stringify(p.previewId)},{cacheRoot:${JSON.stringify(cache)},stateRoot:${JSON.stringify(state)},hook:async point=>{if(point==='after-file')process.kill(process.pid,'SIGKILL')}});`;
 await assert.rejects(()=>exec(process.execPath,['--import','tsx','--input-type=module','-e',script]),e=>(e as any).signal==='SIGKILL');assert.equal(await readFile(root+'/guide.md','utf8'),'new');assert.equal(await loadManifest(root),undefined);
 await assert.rejects(()=>apply(p.previewId,{cacheRoot:cache,stateRoot:state}),/locked/);const recovered=await apply(p.previewId,{cacheRoot:cache,stateRoot:state,recover:true});assert.equal(recovered.status,'complete');assert.deepEqual(recovered.written,[]);
}));
test('sigkill_plus_lost_cache_keeps_partial_unowned_files_protected',()=>fixture(async(root,cache,state)=>{
 const p=await preview(await plan(root),[],{cacheRoot:cache});const script=`import {apply} from ${JSON.stringify(pathToFileURL(resolve('src/installer/apply.ts')).href)};await apply(${JSON.stringify(p.previewId)},{cacheRoot:${JSON.stringify(cache)},stateRoot:${JSON.stringify(state)},hook:async point=>{if(point==='after-file')process.kill(process.pid,'SIGKILL')}});`;
 await assert.rejects(()=>exec(process.execPath,['--import','tsx','--input-type=module','-e',script]));await rm(cache,{recursive:true,force:true});await assert.rejects(()=>apply(p.previewId,{cacheRoot:cache,stateRoot:state,recover:true}),/missing|corrupt/);assert.equal(await readFile(root+'/guide.md','utf8'),'new');await mkdir(cache,{mode:0o700});const fresh=await preview(await plan(root,'different'),[],{cacheRoot:cache});assert.equal(fresh.executable,false);assert.ok((await readdir(state)).some(p=>p.endsWith('.apply.json')));
}));
import {prepareSoftwareInstall} from '../src/integrations/tools/software.js';import {loadUpstreamLock} from '../src/integrations/registry.js';
test('external_scope_changed_after_preview_stops_before_dispatch_or_text_writes',()=>fixture(async(root,cache,state)=>{
 const p=await plan(root);const recipe=(await loadUpstreamLock()).find(r=>r.integrationId==='openwiki')!;const op=await prepareSoftwareInstall(root,'openwiki',recipe.version,recipe.packageIntegrity);if('pending' in op||'reused' in op)throw Error('fixture');p.operations=[op];const view=await preview(p,[],{cacheRoot:cache});assert.equal(view.executable,true);await mkdir(root+'/.rigup/tools/openwiki',{recursive:true});await writeFile(root+'/.rigup/tools/openwiki/customer.txt','preserve');let dispatched=0;const r=await apply(view.previewId,{cacheRoot:cache,stateRoot:state,operation:{launch:async()=>{dispatched++;return {status:'done',message:'should not dispatch'};}}});assert.equal(r.exitCode,3);assert.equal(dispatched,0);assert.equal(await loadManifest(root),undefined);assert.ok(!(await readdir(root)).includes('guide.md'));
}));
