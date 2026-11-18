import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {openspecFixturePath,project,testEnvironment} from './helpers.js';
import {runCli} from '../src/cli.js';
import {openResearchMcp} from '../src/research/mcp-workflow.js';
import {quoteShell} from '../src/shell-command.js';
import {signature} from '../src/generator/cache.js';

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

test('MCP analysis seeds favor root guidance, build manifests and distinct directories',()=>fixture(async(root,cacheRoot,stateRoot)=>{
 const files:Record<string,string>={
  'AGENTS.md':'# Agent guidance\nCheck user-facing behavior.\n',
  'CLAUDE.md':'# Team guidance\nKeep reproducible evidence.\n',
  'pom.xml':'<project/>\n',
  'z-service/src/Later.java':'class Later {}\n',
  'z-service/tests/LaterTest.java':'class LaterTest {}\n',
  'docs/operations.md':'# Operations\nPerform the narrow check.\n',
  'notes/extra.blob':'Optional readable research source.\n',
  '.idea/workspace.xml':'<project/>\n',
  '.rigupignore':'ignored/\n',
  'ignored/src/Unavailable.java':'class Unavailable {}\n',
  'yarn.lock':'# Lock body\n',
 };
 for(let module=0;module<27;module++){
  const dir='a'+String(module).padStart(2,'0');
  files[dir+'/pom.xml']='<project/>\n';
  files[dir+'/AGENTS.md']='# Module guidance\n';
 }
 for(let index=0;index<205;index++)files['a00/src/Source'+index+'.java']='class Fixture {}\n';
 for(const [path,body] of Object.entries(files)){
  const file=join(root,path);
  await mkdir(dirname(file),{recursive:true});
  await writeFile(file,body);
 }

 const run=cli(root,cacheRoot,stateRoot);
 const foundation=await run(['init','--agents','claude','--sdd','none','--defer-research','--review'],3);
 await run(['update','--apply',foundation.previewId],0);
 const mcp=await openResearchMcp(root,'claude',{cacheRoot,stateRoot});
 const begin=await mcp.call('rigup_begin',{root,mode:'init'});
 const seeds=begin.job?.seedPaths??[];
 assert.equal(begin.job?.stage,'analysis');
 assert.deepEqual(seeds.slice(0,2),['AGENTS.md','CLAUDE.md']);
 assert.equal(seeds.find(path=>path.endsWith('pom.xml')),'pom.xml');
 for(const path of ['a00/src/Source0.java','z-service/src/Later.java','z-service/tests/LaterTest.java','docs/operations.md'])assert.ok(seeds.includes(path),path);
 for(const path of ['yarn.lock','.idea/workspace.xml','notes/extra.blob','ignored/src/Unavailable.java'])assert.ok(!seeds.includes(path),path);
 assert.equal(new Set(seeds).size,seeds.length);
 assert.ok(seeds.length<=170);
 assert.match(begin.instructions??'',/seed paths.*sample/i);

 const plan=await mcp.call('rigup_submit_plan',{runId:begin.runId,jobId:begin.job?.id,data:{...empty,citations:[{path:'notes/extra.blob',startLine:1,endLine:1}]}});
 assert.equal(plan.job?.stage,'plan');
 assert.equal(plan.job?.seedPaths,undefined);
}));

test('MCP lists and calls tools after negotiation and ignores extra argument fields',t=>fixture(async(root,cacheRoot,stateRoot)=>{
 const run=cli(root,cacheRoot,stateRoot);
 const base=await run(['init','--agents','claude','--sdd','none','--defer-research','--review'],3);
 await run(['update','--apply',base.previewId],0);
 const home=join(cacheRoot,'home');await mkdir(home);
 testEnvironment(t,{HOME:home,USERPROFILE:home});
 const {Readable,Writable}=await import('node:stream');
 const {serveResearchMcp}=await import('../src/research/mcp-stdio.js');
 const requests=[
  {id:1,method:'tools/list'},
  {id:2,method:'initialize',params:{protocolVersion:'2025-11-25'}},
  {id:3,method:'tools/list'},
  {id:4,method:'tools/call',params:{name:'rigup_begin',arguments:{root,mode:'init',clientMetadata:{fixture:true}}}},
  {id:5,method:'tools/call',params:{name:'rigup_begin',arguments:{root}}},
  {id:6,method:'tools/call',params:{name:'rigup_begin',arguments:{root,mode:false}}},
  {id:7,method:'tools/call',params:{name:'unknown_tool',arguments:{root,mode:'init'}}},
 ];
 const input=Readable.from(requests.map(request=>JSON.stringify({jsonrpc:'2.0',...request})+'\n'));
 let text='';
 const output=new Writable({write(chunk,_encoding,done){text+=String(chunk);done();}});
 await serveResearchMcp(['--host','claude'],{cwd:root,input,output});
 const replies=Object.fromEntries(text.trim().split('\n').map(line=>{const value=JSON.parse(line);return [value.id,value];}));
 assert.equal(replies[1].error.code,-32002);
 assert.equal(replies[2].result.protocolVersion,'2025-11-25');
 assert.equal(replies[3].result.tools[0].inputSchema.additionalProperties,true);
 assert.equal(replies[4].result.structuredContent.status,'planning');
 for(const id of [5,6,7])assert.equal(replies[id].error.code,-32602);
}));

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
 const path=join(cacheRoot,'previews',preview.previewId+'.json');
 const legacy=JSON.parse(await readFile(path,'utf8'));
 delete legacy.data.approvalNonce;
 await writeFile(path,JSON.stringify({...legacy,digest:signature(legacy.data)}));
 const regenerated=await mcp.call('rigup_finish',{runId});
 assert.notEqual(regenerated.previewId,preview.previewId);
 assert.equal(regenerated.preview?.executable,true);
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

test('MCP rejects excluded citations and refreshes a digestless job without changing sessions',()=>fixture(async(root,cacheRoot,stateRoot)=>{
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
 const updated=await mcp.call('rigup_submit_plan',{runId:begin.runId,jobId:begin.job?.id,data:{...empty,citations:[{path:'README.md',startLine:1,endLine:1}]}});
 assert.equal(updated.runId,begin.runId);
 assert.equal(updated.job?.stage,'analysis');
 assert.notEqual(updated.job?.id,begin.job?.id);
 assert.match(updated.instructions??'',/read.*evidence/i);
 assert.equal((await mcp.call('rigup_begin',{root,mode:'update'})).runId,begin.runId);
 await writeFile(join(root,'other.md'),'Outside the configured research scope\n');
 await writeFile(join(root,'.rigup','config.yaml'),'scope: [README.md]\ndocumentLanguage: zh-CN\n');
 const narrowed=await mcp.call('rigup_begin',{root,mode:'update'});
 assert.notEqual(narrowed.runId,begin.runId);
 assert.deepEqual(narrowed.job?.seedPaths,['README.md']);
 assert.equal(narrowed.job?.options.documentLanguage,'zh-CN');
}));

test('MCP reuses accepted pages across unrelated edits and refreshes only stale page evidence',()=>fixture(async(root,cacheRoot,stateRoot)=>{
 await mkdir(join(root,'src'));
 for(const name of ['plan','alpha','beta','support','other'])await writeFile(join(root,'src',name+'.ts'),name+' fixture\n');
 const run=cli(root,cacheRoot,stateRoot);
 const foundation=await run(['init','--agents','claude','--sdd','none','--defer-research','--review'],3);
 await run(['update','--apply',foundation.previewId],0);
 const mcp=await openResearchMcp(root,'claude',{cacheRoot,stateRoot});
 const begin=await mcp.call('rigup_begin',{root,mode:'init'}),runId=begin.runId;
 const planning=await mcp.call('rigup_submit_plan',{runId,jobId:begin.job?.id,data:empty});
 const artifacts=['alpha','beta'].map(logicalId=>({
  logicalId,target:'docs/rigup/'+logicalId+'.md',purpose:'Document the fixture',consumer:'agent-entry',required:true,reason:'Capture the accepted workflow',
  sourceRefs:[{path:'src/plan.ts',startLine:1,endLine:1}],seedPaths:[],relatedArtifacts:[],acceptance:['Preserve approved scope'],
 }));
 let page=await mcp.call('rigup_submit_plan',{runId,jobId:planning.job?.id,data:{...empty,artifacts,dispositions:[]}});
 const submitPage=async(jobId:string|undefined,name:string)=>{
  const path='src/'+name+'.ts';
  const observations=name==='alpha'?[{
   topic:'Routine',classification:'convention',statement:'Use the routine',scope:['src'],
   supportingEvidence:[{path,startLine:1,endLine:1},{path:'src/support.ts',startLine:1,endLine:1}],counterEvidence:[],
   coverage:{independentSupports:2,counterexampleSearched:true,counterexampleQueries:['deviant routine']},
  }]:[];
  return mcp.call('rigup_submit_page',{runId,jobId,data:{...empty,observations,citations:[{path,startLine:1,endLine:1}],content:'Existing workflow for '+name+'.\n'}});
 };
 const accept=(jobId?:string)=>mcp.call('rigup_submit_page',{runId,jobId,data:{...empty,accepted:true,reason:'Evidence supports this page'}});
 assert.equal(page.job?.artifact,'alpha');
 page=await accept((await submitPage(page.job?.id,'alpha')).job?.id);
 assert.equal(page.job?.artifact,'beta');
 assert.equal((await accept((await submitPage(page.job?.id,'beta')).job?.id)).status,'ready');
 await writeFile(join(root,'src','other.ts'),'unrelated edit\n');
 const unchanged=await mcp.call('rigup_begin',{root,mode:'update'});
 assert.equal(unchanged.runId,runId);
 assert.equal(unchanged.status,'ready');
 await writeFile(join(root,'src','alpha.ts'),'new source for this page only\n');
 const stale=await mcp.call('rigup_begin',{root,mode:'update'});
 assert.equal(stale.runId,runId);
 assert.equal(stale.job?.artifact,'alpha');
 assert.equal((await accept((await submitPage(stale.job?.id,'alpha')).job?.id)).status,'ready');
 await writeFile(join(root,'src','counter.ts'),'deviant routine\n');
 const counterexample=await mcp.call('rigup_begin',{root,mode:'update'});
 assert.equal(counterexample.runId,runId);
 assert.equal(counterexample.job?.artifact,'alpha');
 assert.equal((await accept((await submitPage(counterexample.job?.id,'alpha')).job?.id)).status,'ready');
 const final=await mcp.call('rigup_finish',{runId});
 await run(['update','--apply',final.previewId!],0);
 assert.equal((await mcp.call('rigup_begin',{root,mode:'update'})).status,'noop');
 await writeFile(join(root,'src','discovered.ts'),'new evidence after apply\n');
 const next=await mcp.call('rigup_begin',{root,mode:'update'});
 assert.notEqual(next.runId,runId);
 assert.equal(next.job?.stage,'analysis');
}));

test('rigup_finish retries blocked npm resolution and keeps an approved version across retagging',()=>fixture(async(root,cacheRoot,stateRoot)=>{
 const run=cli(root,cacheRoot,stateRoot);
 const foundation=await run(['init','--agents','claude','--sdd','none','--defer-research','--review'],3);
 await run(['update','--apply',foundation.previewId,'--sessions-ended'],0);
 await writeFile(join(root,'.rigup','config.yaml'),JSON.stringify({agents:['claude'],backend:'host',projectRules:true,
  tools:[{id:'openwiki',install:true,initialize:false,agents:['claude']}]}));
 let calls=0,blocked=true,version='2.0.0';
 const prior=process.env.RIGUP_NPM_REGISTRY;process.env.RIGUP_NPM_REGISTRY='https://first.example.test/npm/';
 try{
  const mcp=await openResearchMcp(root,'claude',{cacheRoot,stateRoot,npmView:async()=>{
   calls++;if(blocked)throw Error('registry offline');
   return JSON.stringify({name:'openwiki',version,'dist-tags.latest':version,'dist.integrity':'sha512-'+Buffer.alloc(64,5).toString('base64')});
  }});
  const begin=await mcp.call('rigup_begin',{root,mode:'update'}),runId=begin.runId;
  const plan=await mcp.call('rigup_submit_plan',{runId,jobId:begin.job?.id,data:{...empty,guidance:[]}});
  assert.equal(calls,0);
  const ready=await mcp.call('rigup_submit_plan',{runId,jobId:plan.job?.id,data:{...empty,guidance:[],artifacts:[],dispositions:[]}});
  assert.equal(ready.status,'ready');assert.equal(calls,1);
  const pending=await mcp.call('rigup_finish',{runId});
  assert.match(pending.preview!.blockers.join('\n'),/openwiki@latest.*first\.example\.test/);
  assert.equal(calls,2);
  blocked=false;
  const resolved=await mcp.call('rigup_finish',{runId});assert.equal(resolved.preview?.operations[0].version,'2.0.0');assert.equal(calls,3);
  version='2.1.0';
  assert.equal((await mcp.call('rigup_finish',{runId})).previewId,resolved.previewId);assert.equal(calls,3);
  process.env.RIGUP_NPM_REGISTRY='https://second.example.test/npm/';
  const moved=await mcp.call('rigup_finish',{runId});
  assert.notEqual(moved.previewId,resolved.previewId);assert.equal(moved.preview?.operations[0].version,'2.1.0');assert.equal(calls,4);
 }finally{if(prior===undefined)delete process.env.RIGUP_NPM_REGISTRY;else process.env.RIGUP_NPM_REGISTRY=prior;}
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
 assert.equal((await mcp.call('rigup_begin',{root,mode:'update'})).status,'noop');

 const nativeConfig=join(root,'openspec/config.yaml');
 const originalConfig=await readFile(nativeConfig);
 await rm(nativeConfig);
 const missingRoot=await mcp.call('rigup_begin',{root,mode:'update'});
 assert.equal(missingRoot.status,'pending');
 assert.match(missingRoot.nextCommand??'',/--prepare-openspec --install-scope project/);
 await writeFile(nativeConfig,originalConfig);

 const consumerPath=process.env.RIGUP_CONSUMER_PATH;
 process.env.RIGUP_CONSUMER_PATH=stateRoot;
 try{
  const missingCli=await mcp.call('rigup_finish',{runId});
  assert.equal(missingCli.status,'pending');
  assert.match(missingCli.nextCommand??'',/--prepare-openspec --install-scope project/);
 }finally{if(consumerPath===undefined)delete process.env.RIGUP_CONSUMER_PATH;else process.env.RIGUP_CONSUMER_PATH=consumerPath;}

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
 assert.doesNotMatch(stderr,/owned after|next apply/);
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
 const {confirmedHarnessSource}=await import('./helpers.js');
 const authority=await confirmedHarnessSource(root,{agents:['claude'],backend:'host',projectRules:true});
 const source=join(root,authority.path),original=await readFile(source,'utf8');
 const run=cli(root,cacheRoot,stateRoot);
 const initial=await run(['init','--agents','claude','--sdd','none','--defer-research','--review'],3);
 await run(['update','--apply',initial.previewId,'--sessions-ended'],0);
 const mcp=await openResearchMcp(root,'claude',{cacheRoot,stateRoot});
 async function finish(){
  const begin=await mcp.call('rigup_begin',{root,mode:'update'});
  assert.notEqual(begin.status,'noop');
  const runId=begin.runId;
  if(begin.status==='planning'){
   const plan=await mcp.call('rigup_submit_plan',{runId,jobId:begin.job?.id,data:{...empty,guidance:begin.job?.sourceGuidance??[]}});
   const ready=await mcp.call('rigup_submit_plan',{runId,jobId:plan.job?.id,data:{...empty,guidance:plan.job?.sourceGuidance??[],artifacts:[],dispositions:[]}});
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

test('harness MCP exports scoped confirmation and rejects cross-scope citations and old jobs',()=>fixture(async(root,cacheRoot,stateRoot)=>{
 const {confirmedHarnessSource}=await import('./helpers.js');
 const settings={agents:['claude' as const],backend:'host' as const,projectRules:true};
 const authority=await confirmedHarnessSource(root,settings);
 const run=cli(root,cacheRoot,stateRoot);
 const initial=await run(['init','--agents','claude','--sdd','none','--defer-research','--review'],3);
 await run(['update','--apply',initial.previewId,'--sessions-ended'],0);
 const mcp=await openResearchMcp(root,'claude',{cacheRoot,stateRoot});
 const first=await mcp.call('rigup_begin',{root,mode:'update'});
 assert.deepEqual(first.job?.sourceGuidance?.[0]?.scope,['api']);
 assert.ok(first.job?.sourceEvidence?.some(item=>item.evidence.path===authority.path&&item.content.includes(authority.body)));
 const source=first.job!.sourceGuidance![0];
 await assert.rejects(mcp.call('rigup_submit_plan',{runId:first.runId,jobId:first.job?.id,data:{...empty,guidance:[{...source,scope:['.']}]}}),/claim scope exceeds/);
 const accepted=await mcp.call('rigup_submit_plan',{runId:first.runId,jobId:first.job?.id,data:{...empty,guidance:[source]}});
 assert.deepEqual(accepted.job?.sourceGuidance,first.job?.sourceGuidance);
 const file=join(root,authority.path);
 await writeFile(file,(await readFile(file,'utf8')).replace('status: confirmed','status: draft'));
 await assert.rejects(mcp.call('rigup_submit_plan',{runId:first.runId,jobId:accepted.job?.id,data:{...empty,guidance:[source],artifacts:[],dispositions:[]}}),/source|run/i);
 const next=await mcp.call('rigup_begin',{root,mode:'update'});
 assert.notEqual(next.job?.id,first.job?.id);
 assert.equal(next.job?.sourceGuidance,undefined);
}));

test('unified harness CLI and MCP produce equivalent scoped plans',()=>fixture(async(root,cacheRoot,stateRoot)=>{
 const {confirmedHarnessSource}=await import('./helpers.js');
 const {validateResearch}=await import('../src/analyzer/backend.js');
 const settings={agents:['claude' as const],backend:'host' as const,projectRules:true,scope:['api'],
  projectConventions:{topics:[
   {id:'api-errors',title:'API errors',scope:['api'],source:'knowledge/api-errors.md'},
   {id:'api-validation',title:'API validation',scope:['api']},
   {id:'ui-states',title:'UI states',scope:['web']},
  ]}};
 await confirmedHarnessSource(root,settings);
 await mkdir(join(root,'web'));await writeFile(join(root,'web','page.ts'),'export const page = true;\n');
 await mkdir(join(root,'.rigup'));await writeFile(join(root,'.rigup','config.yaml'),JSON.stringify(settings));
 const run=cli(root,cacheRoot,stateRoot);
 const foundation=await run(['init','--agents','claude','--sdd','none','--defer-research','--review'],3);
 await run(['update','--apply',foundation.previewId,'--sessions-ended'],0);
 const backend:import('../src/analyzer/backend.js').AnalysisBackend={run:async(request,reader)=>{
  assert.deepEqual(request.sourceGuidance?.[0]?.scope,['api']);
  const data={...empty,guidance:[],...(request.expectedOutput==='plan'?{artifacts:[],dispositions:[]}:{})};
  await validateResearch(data,reader);
  return {status:'complete',value:{data,model:'fixture',unknowns:[],usage:{calls:1,tokens:1}}};
 }};
 let output='';
 assert.equal(await runCli(['update','--backend','host','--review','--json'],{cwd:root,isTTY:false,write:text=>output+=text,services:{cacheRoot,stateRoot,backend}}),3,output);
 const cliReview=JSON.parse(output);
 const mcp=await openResearchMcp(root,'claude',{cacheRoot,stateRoot});
 const first=await mcp.call('rigup_begin',{root,mode:'update'});
 const plan=await mcp.call('rigup_submit_plan',{runId:first.runId,jobId:first.job?.id,data:{...empty,guidance:[]}});
 assert.equal((await mcp.call('rigup_submit_plan',{runId:first.runId,jobId:plan.job?.id,data:{...empty,guidance:[],artifacts:[],dispositions:[]}})).status,'ready');
 const finish=await mcp.call('rigup_finish',{runId:first.runId});
 assert.equal(finish.preview?.executable,true);
 assert.deepEqual(finish.preview?.harness,cliReview.harness);
 assert.deepEqual(finish.preview?.projectDocuments,cliReview.projectDocuments);
 assert.deepEqual(finish.preview?.blockers,cliReview.blockers);
 assert.deepEqual(finish.preview?.projectDocuments?.map(doc=>[doc.target.includes('api-validation--'),doc.action]),[[true,'preserve']]);
}));

test('an installed workflow can switch languages through MCP and CLI with the same managed identities',()=>fixture(async(root,cacheRoot,stateRoot)=>{
 const {confirmedHarnessSource}=await import('./helpers.js');
 const {loadManifest}=await import('../src/installer/baseline.js');
 const {digest}=await import('../src/analyzer/evidence.js');
 const settings={agents:['codex' as const],backend:'host' as const,projectRules:true,sdd:'superpowers' as const,
  projectConventions:{topics:[
   {id:'api-errors',title:'API errors',scope:['api'],source:'knowledge/api-errors.md'},
   {id:'api-validation',title:'API validation',scope:['api']},
  ]}};
 await confirmedHarnessSource(root,settings);
 const policy='Verify the request ID before writing to the audit log.';
 await writeFile(join(root,'POLICY.md'),policy+'\n');
 await mkdir(join(root,'.rigup'));
 await writeFile(join(root,'.rigup','config.yaml'),JSON.stringify(settings));
 for(const name of ['brainstorming','writing-plans','executing-plans','verification-before-completion']){
  const target=join(root,'.agents','skills',name,'SKILL.md');
  await mkdir(dirname(target),{recursive:true});
  await writeFile(target,`---\nname: ${name}\ndescription: Native Superpowers fixture.\n---\n`);
 }
 const run=cli(root,cacheRoot,stateRoot);
 const foundation=await run(['init','--language','en','--defer-research','--review'],3);
 await run(['update','--apply',foundation.previewId],0);
 const identities=async()=>(await loadManifest(root))!.assets.map(({logicalId,target,ownership})=>({logicalId,target,ownership})).sort((a,b)=>a.target.localeCompare(b.target));
 const before=await identities();
 const context=join(root,'.agents','skills','change-prepare','references','project.md');
 const original=await readFile(context,'utf8');
 assert.match(original,/Native prepare: brainstorming, writing-plans/);
 assert.match(original,/## Team conventions/);
 const mcp=await openResearchMcp(root,'codex',{cacheRoot,stateRoot});
 const begin=await mcp.call('rigup_begin',{root,mode:'update',language:'zh-CN'});
 assert.equal(begin.job?.options.documentLanguage,'zh-CN');
 const plan=await mcp.call('rigup_submit_plan',{runId:begin.runId,jobId:begin.job?.id,data:{...empty,guidance:[]}});
 await mcp.call('rigup_submit_plan',{runId:begin.runId,jobId:plan.job?.id,data:{...empty,guidance:[{
  topic:'Audit log',scope:['.'],sourceRef:{path:'POLICY.md',startLine:1,endLine:1,digest:digest(policy)},
  coverageStatus:'reusable',consumers:['prepare'],gaps:[],
 }],artifacts:[],dispositions:[]}});
 const finished=await mcp.call('rigup_finish',{runId:begin.runId});
 assert.equal(finished.preview?.executable,true);
 await run(['update','--apply',finished.previewId!],0);
 const translated=await readFile(context,'utf8');
 assert.match(translated,/原生准备: brainstorming, writing-plans/);
 assert.match(translated,/## Team conventions/);
 assert.match(translated,/\[POLICY\.md\]/);
 assert.deepEqual(await identities(),before);

 const newMachine=cli(root,cacheRoot,join(cacheRoot,'fresh-state'));
 const update=await newMachine(['update','--language','en','--review'],3);
 assert.equal(update.executable,true);
 assert.equal(update.projectRules,'ready');
 await newMachine(['update','--apply',update.previewId],0);
 const reverted=await readFile(context,'utf8');
 assert.match(reverted,/Native prepare: brainstorming, writing-plans/);
 assert.match(reverted,/\[POLICY\.md\]/);
 assert.deepEqual(await identities(),before);
}));
