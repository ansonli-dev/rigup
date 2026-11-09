import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {project} from './helpers.js';
import {runCli} from '../src/cli.js';
import {openResearchMcp} from '../src/research/mcp-workflow.js';

async function fixture(run:(root:string,cacheRoot:string,stateRoot:string)=>Promise<void>){
 await project(root=>project(cache=>project(state=>run(root,cache,state))));
}
function cli(root:string,cacheRoot:string,stateRoot:string){
 return async(args:string[],expected:number)=>{
  let output='';
  const result=await runCli([...args,'--json'],{cwd:root,isTTY:false,write:s=>output+=s,services:{cacheRoot,stateRoot}});
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
