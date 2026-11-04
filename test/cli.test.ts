import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runCli} from '../src/cli.js';

test('help_lists_lifecycle_commands', async () => {
  let output = '';
  const code = await runCli(['--help'], {cwd:tmpdir(), isTTY:false, write:(s:string)=>output+=s});
  assert.equal(code, 0);
  for (const cmd of ['init','update','doctor']) assert.match(output, new RegExp(cmd));
});
test('unknown_option_does_not_touch_project', async () => {
  const root = await mkdtemp(join(tmpdir(),'rigup-'));
  try {
    assert.equal(await runCli(['init','--unknown'], {cwd:root,isTTY:false,write:()=>{}}),2);
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root,{recursive:true,force:true}); }
});
test('bare_non_tty_exits_2_without_writes', async () => {
  const root = await mkdtemp(join(tmpdir(),'rigup-'));
  try {
    assert.equal(await runCli([], {cwd:root,isTTY:false,write:()=>{}}),2);
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('bare_tty_routes_by_project_state',()=>project(async root=>{
 let output='';const answers=['1','1','4','3','1'];
 const code=await runCli([],{cwd:root,isTTY:true,write:s=>output+=s,read:async()=>answers.shift()??null});
 assert.equal(code,0);assert.match(output,/init:/);
}));
test('eof_never_confirms', async () => {
 let output='';
 assert.equal(await runCli([], {cwd:tmpdir(),isTTY:true,write:(s:string)=>output+=s,read:async()=>null}),130);
 assert.doesNotMatch(output,/init: 尚未实现/);
});
test('damaged_manifest_is_not_fresh_project', async () => {
 const {mkdir,writeFile,readFile}=await import('node:fs/promises');
 const root=await mkdtemp(join(tmpdir(),'rigup-'));
 try {
  await mkdir(join(root,'.rigup')); await writeFile(join(root,'.rigup/manifest.json'),'{broken');
  let output='';
  assert.equal(await runCli(['init'],{cwd:root,isTTY:false,write:(s:string)=>output+=s}),1);
  assert.match(output,/manifest/); assert.doesNotMatch(output,/init: 尚未实现/);
  assert.equal(await readFile(join(root,'.rigup/manifest.json'),'utf8'),'{broken');
 } finally {await rm(root,{recursive:true,force:true});}
});
test('init_existing_manifest_uses_update_rules_and_doctor_is_read_only', async () => {
 const {mkdir,writeFile,readFile}=await import('node:fs/promises');
 const root=await mkdtemp(join(tmpdir(),'rigup-'));
 const original='{"schemaVersion":1,"installId":"fixture","assets":[]}';
 try {
  await mkdir(join(root,'.rigup'));await writeFile(join(root,'.rigup/manifest.json'),original);
  for(const [args,expected] of [[['init'],'update'],[['doctor'],'doctor']] as const){
   let out='';assert.equal(await runCli([...args],{cwd:root,isTTY:false,write:(s:string)=>out+=s}),3);
   assert.match(out,new RegExp(expected+':'));
   assert.equal(await readFile(join(root,'.rigup/manifest.json'),'utf8'),original);
  }
 } finally {await rm(root,{recursive:true,force:true});}
});
import {project} from './helpers.js';
test('explicit_dry_run_and_preflight_missing_inputs_never_call_backend_or_write_project',()=>project(async root=>project(async cache=>project(async state=>{
 let calls=0;const io={cwd:root,isTTY:false,write:()=>{},services:{cacheRoot:cache,stateRoot:state,backend:{run:async()=>{calls++;throw Error('unexpected research');}}}};
 assert.equal(await runCli(['init','--agents','codex','--dry-run'],io),0);assert.equal(calls,0);assert.deepEqual(await readdir(root),[]);
 assert.equal(await runCli(['init'],io),3);assert.equal(calls,0);
}))));
test('continuous_run_never_prompts_after_start',()=>project(async root=>project(async cache=>project(async state=>{
 let reads=0;const code=await runCli(['init','--agents','codex'],{cwd:root,isTTY:false,write:()=>{},read:async()=>{reads++;throw Error('stdin removed');},services:{cacheRoot:cache,stateRoot:state}});assert.equal(code,0);assert.equal(reads,0);
}))));
test('host_pending_returns_3_and_preserves_project_bytes',()=>project(async root=>project(async cache=>project(async state=>{
 const before=await readdir(root);let output='';const code=await runCli(['init','--agents','codex','--sdd','openspec','--backend','host','--dry-run'],{cwd:root,isTTY:false,write:s=>output+=s,services:{cacheRoot:cache,stateRoot:state}});assert.equal(code,3);assert.match(output,/Pending host research/);assert.deepEqual(await readdir(root),before);
}))));
test('review_mode_waits_only_when_selected',()=>project(async root=>project(async cache=>project(async state=>{
 let out='';assert.equal(await runCli(['init','--agents','codex','--review'],{cwd:root,isTTY:false,write:s=>out+=s,services:{cacheRoot:cache,stateRoot:state}}),3);assert.match(out,/--apply/);assert.deepEqual(await readdir(root),[]);
}))));
test('continuation_rejects_changed_inputs_without_project_writes',()=>project(async root=>project(async cache=>project(async state=>{
 const {writeFile}=await import('node:fs/promises');let out='';const io={cwd:root,isTTY:false,write:(s:string)=>out+=s,services:{cacheRoot:cache,stateRoot:state}};assert.equal(await runCli(['init','--agents','codex','--sdd','openspec','--backend','host','--dry-run'],io),3);const id=out.match(/--continue ([a-f0-9]{64})/)![1];await writeFile(root+'/new.ts','changed');out='';assert.equal(await runCli(['update','--continue',id],io),1);assert.match(out,/changed/);assert.deepEqual(await readdir(root),['new.ts']);
}))));
test('apply_id_cannot_redirect_cli_to_a_different_project_root',()=>project(async root=>project(async other=>project(async cache=>project(async state=>{
 const {preview}=await import('../src/installer/preview.js');const {scanRepository}=await import('../src/analyzer/repository.js');const options={agents:[],backend:'host' as const};const p=await preview({root:other,fingerprint:(await scanRepository(other,options)).fingerprint,options,assets:[{logicalId:'a',target:'other.md',content:'must not write',ownership:{kind:'file'},source:{kind:'test',ref:'test'}}],operations:[],dispositions:[],warnings:[],requirements:[],versions:{}},[],{cacheRoot:cache+'/previews'});let out='';assert.equal(await runCli(['update','--apply',p.previewId,'--sessions-ended'],{cwd:root,isTTY:false,write:s=>out+=s,services:{cacheRoot:cache,stateRoot:state}}),1);assert.match(out,/root|project/);assert.deepEqual(await readdir(other),[]);
})))));
