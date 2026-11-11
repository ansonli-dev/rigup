import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {openspecFixturePath,project} from './helpers.js';
import {runCli} from '../src/cli.js';
import {openResearchMcp} from '../src/research/mcp-workflow.js';
import {quoteShell} from '../src/shell-command.js';

async function fixture(run:(root:string,cacheRoot:string,stateRoot:string)=>Promise<void>){
 await project(root=>project(cache=>project(state=>run(root,cache,state))));
}
function cli(root:string,cacheRoot:string,stateRoot:string,writeError?:(text:string)=>void){
 return async(args:string[],expected:number)=>{
  let output='';
  const result=await runCli([...args,'--json'],{cwd:root,isTTY:false,write:s=>output+=s,writeError,services:{cacheRoot,stateRoot}});
  assert.equal(result,expected,output);
  return JSON.parse(output);
 };
}
const empty={observations:[],unknowns:[]};

test('provider-free MCP setup, job replay and finish require independent apply',()=>fixture(async(root,cacheRoot,stateRoot)=>{
 await writeFile(join(root,'README.md'),'# Store\nRun the narrow check for your change.\n');
 const run=cli(root,cacheRoot,stateRoot);
 const foundation=await run(['init','--agents','claude','--sdd','none','--defer-research','--review'],3);
 assert.equal(foundation.projectRules,'pending');
 await run(['update','--apply',foundation.previewId,'--sessions-ended'],0);
 const config=JSON.parse(await readFile(join(root,'.mcp.json'),'utf8'));
 assert.deepEqual(config.mcpServers.rigup.args.slice(2),['--','.mcp.json','.rigup/rigup-mcp.mjs','claude']);

 const dependencies={cacheRoot,stateRoot};
 let mcp=await openResearchMcp(root,'claude',dependencies);
 const begin=await mcp.call('rigup_begin',{root,mode:'init'});
 assert.equal(begin.status,'planning');
 assert.match(begin.instructions??'',/Glob and Grep.*\.rigup\/tools\//);
 const runId=begin.runId;
 const analysis={runId,jobId:begin.job?.id,data:{...empty,guidance:[]}};
 const plan=await mcp.call('rigup_submit_plan',analysis);
 assert.equal(plan.job?.stage,'plan');
 mcp=await openResearchMcp(root,'claude',dependencies);
 assert.equal((await mcp.call('rigup_submit_plan',analysis)).job?.id,plan.job?.id);

 const artifact={logicalId:'shipping-check',target:'docs/rigup/shipping-check.md',purpose:'Guide test selection',consumer:'agent-entry',required:true,
  reason:'Keep the narrow project check discoverable',sourceRefs:[{path:'README.md',startLine:2,endLine:2}],seedPaths:['README.md'],relatedArtifacts:[],acceptance:['Name the narrow check']};
 const page=await mcp.call('rigup_submit_plan',{runId,jobId:plan.job?.id,data:{...empty,artifacts:[artifact],dispositions:[]}});
 assert.equal(page.status,'page');
 assert.equal((await mcp.call('rigup_next_page',{runId})).job?.id,page.job?.id);
 await assert.rejects(()=>mcp.call('rigup_finish',{runId}),/pending|not ready/);
 const submitted=await mcp.call('rigup_submit_page',{runId,jobId:page.job?.id,data:{...empty,content:'Run the narrow project check for the changed path.\n'}});
 assert.equal(submitted.job?.stage,'acceptance');
 assert.equal(submitted.job?.options.documentLanguage,'auto');
 const accepted=await mcp.call('rigup_submit_page',{runId,jobId:submitted.job?.id,data:{...empty,accepted:true,reason:'The candidate cites the existing narrow check and preserves scope.'}});
 assert.equal(accepted.status,'ready');
 const preview=await mcp.call('rigup_finish',{runId});
 assert.equal(preview.status,'preview');
 assert.equal((await mcp.call('rigup_finish',{runId})).previewId,preview.previewId);
 await rm(join(cacheRoot,'previews'),{recursive:true});
 const restored=await mcp.call('rigup_finish',{runId});
 assert.equal(restored.status,'preview');
 assert.equal(restored.preview?.executable,true);
 await assert.rejects(()=>readFile(join(root,artifact.target)),{code:'ENOENT'});
 await run(['update','--apply',restored.previewId,'--sessions-ended'],0);
 assert.match(await readFile(join(root,artifact.target),'utf8'),/narrow project check/);
 assert.equal((await mcp.call('rigup_begin',{root,mode:'update'})).status,'noop');
 assert.equal((await mcp.call('rigup_finish',{runId})).status,'noop');
 const unchanged=await run(['update','--review'],0);
 assert.equal(unchanged.projectRules,'ready');
 assert.equal(unchanged.installStatus,'up-to-date');
 assert.equal(unchanged.nextCommand,null);
 assert.ok(!unchanged.previewId);
}));

test('MCP rejects excluded citations, a different root, and source drift',()=>fixture(async(root,cacheRoot,stateRoot)=>{
 await writeFile(join(root,'README.md'),'current text\n');
 await writeFile(join(root,'.rigupignore'),'/secret-notes.md\n');
 await writeFile(join(root,'secret-notes.md'),'excluded text\n');
 const run=cli(root,cacheRoot,stateRoot);
 const foundation=await run(['init','--agents','claude','--sdd','none','--defer-research','--review'],3);
 await run(['update','--apply',foundation.previewId,'--sessions-ended'],0);
 const mcp=await openResearchMcp(root,'claude',{cacheRoot,stateRoot});
 await assert.rejects(()=>mcp.call('rigup_begin',{root:cacheRoot,mode:'init'}),/project root/);
 const begin=await mcp.call('rigup_begin',{root,mode:'init'});
 await assert.rejects(()=>mcp.call('rigup_submit_plan',{runId:begin.runId,jobId:begin.job?.id,data:{...empty,guidance:[{
  topic:'Hidden',coverageStatus:'reusable',scope:['.'],consumers:[],gaps:[],sourceRef:{path:'secret-notes.md',startLine:1,endLine:1}
 }]}}),/outside reader inventory/);
 await writeFile(join(root,'README.md'),'edited text\n');
 await assert.rejects(()=>mcp.call('rigup_next_page',{runId:begin.runId}),/changed/);
 await writeFile(join(root,'other.md'),'Outside the configured research scope\n');
 await writeFile(join(root,'.rigup','config.yaml'),'scope: [README.md]\ndocumentLanguage: zh-CN\n');
 const narrowed=await mcp.call('rigup_begin',{root,mode:'update'});
 assert.notEqual(narrowed.runId,begin.runId);
 assert.deepEqual(narrowed.job?.seedPaths,['README.md']);
 assert.equal(narrowed.job?.options.documentLanguage,'zh-CN');
}));

test('provider-free OpenSpec review resolves retained references after applying project rules',()=>fixture(async(root,cacheRoot,stateRoot)=>{
 const run=cli(root,cacheRoot,stateRoot);
 await writeFile(join(root,'README.md'),'# Store\nUse the narrow check for the changed path.\n');
 for(const name of ['openspec-propose','openspec-apply-change','openspec-archive-change']){
  const target=join(root,'.claude','skills',name,'SKILL.md');
  await mkdir(dirname(target),{recursive:true});
  await writeFile(target,`---\nname: ${name}\ndescription: OpenSpec fixture.\n---\n`);
 }
 const path=process.env.PATH;
 process.env.PATH=await openspecFixturePath(root,cacheRoot);
 try{
  const foundation=await run(['init','--agents','claude','--sdd','openspec','--tools','none','--defer-research','--review'],3);
  await run(['update','--apply',foundation.previewId,'--sessions-ended'],0);
  assert.equal((await run(['update','--review'],3)).projectRules,'pending');
  const mcp=await openResearchMcp(root,'claude',{cacheRoot,stateRoot});
  const begin=await mcp.call('rigup_begin',{root,mode:'init'});
  const {runId}=begin;
  const plan=await mcp.call('rigup_submit_plan',{runId,jobId:begin.job?.id,data:{...empty,guidance:[]}});
  await mcp.call('rigup_submit_plan',{runId,jobId:plan.job?.id,data:{...empty,artifacts:[],dispositions:[]}});
  const finished=await mcp.call('rigup_finish',{runId});
  const applied=await run(['update','--apply',finished.previewId!,'--sessions-ended'],0);
  assert.equal(applied.projectRules,'ready');

  const reference=join(root,'.claude','skills','change-prepare','references','project.md');
  const installed=await readFile(reference,'utf8');
  assert.doesNotMatch(installed,/Project rules are pending/);
  const unchanged=await run(['update','--review'],0);
  assert.equal(unchanged.installStatus,'up-to-date');
  assert.equal(unchanged.projectRules,'ready');
  assert.equal(unchanged.nextCommand,null);
  assert.equal(await readFile(reference,'utf8'),installed);

  await rm(reference);
  const missing=await run(['update','--review'],1);
  assert.equal(missing.executable,false);
  assert.ok(missing.blockers.some((message:string)=>message.includes('navigation link unavailable: references/project.md')));
 }finally{
  process.env.PATH=path;
 }
}));

test('review reports a locally edited owned entry block before pending research',()=>fixture(async(root,cacheRoot,stateRoot)=>{
 let stderr='';
 const run=cli(root,cacheRoot,stateRoot,text=>stderr+=text);
 const foundation=await run(['init','--agents','claude','--sdd','none','--defer-research','--review'],3);
 await run(['update','--apply',foundation.previewId,'--sessions-ended'],0);
 const entry=join(root,'CLAUDE.md');
 const baseline=await readFile(entry,'utf8');
 const local=baseline.replace('Project rules are pending.','Keep this local instruction.');
 await writeFile(entry,local);
 stderr='';
 const conflict=await run(['update','--review'],1);
 assert.equal(conflict.executable,false);
 assert.match(conflict.error,/CLAUDE\.md: Local edit in the Rigup-owned block was preserved/);
 assert.equal(conflict.installStatus,'conflict');
 assert.equal(conflict.nextCommand,'rigup update '+quoteShell(root)+' --review');
 assert.match(conflict.conflicts.find((item:{logicalId:string})=>item.logicalId==='entry:CLAUDE.md')?.reason,/outside the managed block/);
 assert.ok(stderr.includes('After resolving the conflicts, run:\n'+conflict.nextCommand));
 assert.doesNotMatch(stderr,/next apply/);
 const blocked=await run(['update','--apply',conflict.previewId,'--sessions-ended'],1);
 assert.match(blocked.error,/preview is blocked; prepare a new preview/);
 assert.equal(await readFile(entry,'utf8'),local);

 await writeFile(entry,baseline+'\nKeep this local instruction.\n');
 const pending=await run(['update',root,'--review'],3);
 assert.deepEqual(pending.conflicts,[]);
 assert.equal(pending.phase,'research');
 assert.equal(pending.nextCommand,null);
}));

test('harness MCP reconciles effective pending before returning noop or a cached approval',()=>fixture(async(root,cacheRoot,stateRoot)=>{
 const {apply}=await import('../src/installer/apply.js');
 const {doctor}=await import('../src/installer/doctor.js');
 const source=join(root,'README.md'),original='# Service\nUse the scoped error helper.\n';
 await writeFile(source,original);
 const run=cli(root,cacheRoot,stateRoot);
 const initial=await run(['init','--agents','claude','--sdd','none','--defer-research','--review'],3);
 await run(['update','--apply',initial.previewId,'--sessions-ended'],0);
 const mcp=await openResearchMcp(root,'claude',{cacheRoot,stateRoot});
 async function finish(){
  const begin=await mcp.call('rigup_begin',{root,mode:'update'});
  assert.notEqual(begin.status,'noop');
  const runId=begin.runId;
  if(begin.status==='planning'){
   const plan=await mcp.call('rigup_submit_plan',{runId,jobId:begin.job?.id,data:{...empty,guidance:[]}});
   const ready=await mcp.call('rigup_submit_plan',{runId,jobId:plan.job?.id,data:{...empty,guidance:[],artifacts:[],dispositions:[]}});
   assert.equal(ready.status,'ready');
  }else assert.equal(begin.status,'ready');
  const result=await mcp.call('rigup_finish',{runId});
  assert.equal(result.status,'preview');
  return result;
 }
 const a=await finish();
 const dependencies={cacheRoot:join(cacheRoot,'previews'),stateRoot};
 await assert.rejects(apply(a.previewId!,{...dependencies,hook:async point=>{
  if(point==='after-manifest'){
   await writeFile(source,'# Service\nAuthority temporarily removed.\n');
   throw Error('interrupted authority commit');
  }
 }}),/interrupted authority commit/);
 assert.equal((await apply(a.previewId!,{...dependencies,recover:true})).projectRules,'pending');
 await writeFile(source,original);
 const b=await finish();
 assert.notEqual(b.previewId,a.previewId);
 assert.equal((await mcp.call('rigup_finish',{runId:b.runId})).previewId,b.previewId);
 assert.equal((await apply(b.previewId!,dependencies)).projectRules,'ready');
 assert.equal((await doctor(root,{stateRoot})).projectRules,'ready');
 assert.equal((await mcp.call('rigup_begin',{root,mode:'update'})).status,'noop');
}));
