import {test} from 'node:test';import assert from 'node:assert/strict';
import {delimiter,join} from 'node:path';
import type {SetupOptions} from '../src/types.js';
import {project} from './helpers.js';import {mkdir,writeFile,readFile,readdir} from 'node:fs/promises';
import {doctor} from '../src/installer/doctor.js';import {preview} from '../src/installer/preview.js';import {apply} from '../src/installer/apply.js';import {scanRepository} from '../src/analyzer/repository.js';
async function fixture(fn:(root:string,cache:string,state:string)=>Promise<void>){await project(async root=>project(async cache=>project(async state=>{await writeFile(root+'/package.json',JSON.stringify({scripts:{test:'node -e "process.exit(7)"',environment:'node -e "process.exit(0)"'}}));const options={agents:['codex' as const],backend:'host' as const};const p=await preview({root,fingerprint:(await scanRepository(root,options)).fingerprint,options,assets:[],dispositions:[],operations:[],warnings:[],requirements:[],versions:{}},[],{cacheRoot:cache});await apply(p.previewId,{cacheRoot:cache,stateRoot:state});await fn(root,cache,state);})));}
test('doctor_separates_config_environment_tests_and_eval',()=>fixture(async(root,cache,state)=>{
 const r=await doctor(root,{runChecks:['environment','test','eval'],stateRoot:state});assert.equal(r.exitCode,1);assert.ok(r.diagnostics.some(d=>d.category==='config'&&d.state==='configured'));assert.ok(r.checks.some(c=>c.name==='environment'&&c.status==='passed'));assert.ok(r.checks.some(c=>c.name==='test'&&c.status==='failed'));assert.ok(r.checks.some(c=>c.name==='eval'&&c.status==='pending'));
}));
test('doctor_does_not_initialize_or_repair_business_by_default',()=>fixture(async(root,cache,state)=>{
 const manifest=await readFile(root+'/.rigup/manifest.json','utf8'),before=await readdir(root);const r=await doctor(root);assert.deepEqual(r.checks,[]);assert.equal(await readFile(root+'/.rigup/manifest.json','utf8'),manifest);assert.deepEqual(await readdir(root),before);
}));
test('reports_bind_checks_to_actual_commit_environment_and_time',()=>fixture(async(root,cache,state)=>{
 const r=await doctor(root,{runChecks:['environment'],stateRoot:state});const c=r.checks[0] as any;assert.ok(c.fingerprint);assert.ok(c.startedAt);assert.ok(c.finishedAt);assert.equal(c.environment.node,process.version);assert.equal(c.command.executable,'npm');assert.equal(c.commit,'unavailable');
}));
test('stale_result_does_not_validate_new_input',()=>fixture(async(root,cache,state)=>{
 const first=await doctor(root,{runChecks:['environment'],stateRoot:state});await writeFile(root+'/new.ts','changed');const next=await doctor(root,{runChecks:['environment'],stateRoot:state});assert.notEqual((first.checks[0] as any).fingerprint,(next.checks[0] as any).fingerprint);
}));
test('missing_secrets_are_pending_without_values_or_implicit_commands',()=>fixture(async(root,cache,state)=>{
 const file=root+'/.rigup/manifest.json';const m=JSON.parse(await readFile(file,'utf8'));m.options.customer={envRefs:['RIGUP_TEST_MISSING_SECRET'],commands:{feedback:{executable:'must-not-run',args:[],cwd:'.',envRefs:['RIGUP_TEST_MISSING_SECRET']}}};await writeFile(file,JSON.stringify(m));const report=await doctor(root);assert.ok(report.diagnostics.some(d=>d.id==='env:RIGUP_TEST_MISSING_SECRET'&&d.state==='pending'));assert.deepEqual(report.checks,[]);assert.doesNotMatch(JSON.stringify(report),/secret-value/);
}));
async function diagnosticFixture(tools:SetupOptions['tools'],check:(root:string,manifestPath:string)=>Promise<void>){
 await project(async root=>{
  await mkdir(join(root,'.rigup'));
  const manifestPath=join(root,'.rigup','manifest.json');
  await writeFile(manifestPath,JSON.stringify({schemaVersion:1,installId:'doctor-test',assets:[],options:{agents:['codex'],backend:'host',tools}}));
  await check(root,manifestPath);
 });
}
test('doctor finds a Codex launcher in a quoted PATH directory without executing it',()=>diagnosticFixture([],async root=>{
 const bin=join(root,'test bin');await mkdir(bin);
 const windows=process.platform==='win32';
 const command=join(bin,windows?'codex.ps1':'codex');
 await writeFile(command,windows?'throw "doctor must not execute the launcher"\n':'#!/bin/sh\nexit 73\n',{mode:0o700});
 const path=process.env.PATH;
 try{
  process.env.PATH=[join(root,'missing'),'"'+bin+'"'].join(delimiter);
  const report=await doctor(root);
  assert.equal(report.diagnostics.find(d=>d.id==='codex:binary')?.state,'available');
 }finally{if(path===undefined)delete process.env.PATH;else process.env.PATH=path;}
}));
test('doctor observes a completed external OpenWiki baseline without claiming ownership',()=>diagnosticFixture([{id:'openwiki',install:false,initialize:false,agents:['codex']}],async(root,manifestPath)=>{
 const before=await readFile(manifestPath,'utf8');
 const wiki=join(root,'openwiki');await mkdir(wiki);
 const marker=join(wiki,'.last-update.json');
 const completed={updatedAt:'2026-11-09T06:42:01.688Z',command:'init',gitHead:'686142ccbf8b4e6ef86b344a9e917c01ec825298',model:'host-agent/codex',status:'complete',language:'en'};
 const initialization=async()=>(await doctor(root)).diagnostics.find(d=>d.id==='openwiki:initialization');
 await writeFile(marker,JSON.stringify(completed));
 assert.equal((await initialization())?.state,'pending');
 await writeFile(join(wiki,'index.md'),'# Index\n');
 await writeFile(join(wiki,'quickstart.md'),'# Quickstart\n');
 assert.equal((await initialization())?.state,'initialized');
 assert.equal(await readFile(manifestPath,'utf8'),before);
 assert.equal(await readFile(marker,'utf8'),JSON.stringify(completed));
 await writeFile(marker,JSON.stringify({...completed,status:'pending'}));
 assert.equal((await initialization())?.state,'pending');
 await writeFile(marker,'invalid JSON');
 assert.equal((await initialization())?.state,'pending');
}));

test('Claude health probe requires connected project-scoped MCP and keeps output private',()=>project(root=>project(bin=>project(cacheRoot=>project(async stateRoot=>{
 const {runCli}=await import('../src/cli.js');
 const cli=async(args:string[],expected:number)=>{
  let output='';
  const code=await runCli([...args,'--json'],{cwd:root,isTTY:false,write:s=>output+=s,services:{cacheRoot,stateRoot}});
  assert.equal(code,expected,output);
  return JSON.parse(output);
 };
 const foundation=await cli(['init','--agents','claude','--defer-research'],3);
 await cli(['update','--apply',foundation.previewId,'--sessions-ended'],0);
 const script="const [command,sub,id]=process.argv.slice(2); if(command!=='mcp'||sub!=='get'||id!=='rigup')process.exit(1); console.log('rigup:\\n  Scope: '+process.env.RIGUP_TEST_CLAUDE_SCOPE+'\\n  Status: \\u221a Connected\\n  Private: fixture-token');";
 if(process.platform==='win32'){
  const packageRoot=join(bin,'node_modules','@anthropic-ai','claude-code');
  await mkdir(packageRoot,{recursive:true});
  await writeFile(join(bin,'claude.cmd'),'@echo off\r\n');
  await writeFile(join(packageRoot,'cli.js'),script);
 }else await writeFile(join(bin,'claude'),'#!'+process.execPath+'\n'+script,{mode:0o700});
 const path=process.env.PATH;
 try{
  process.env.PATH=bin+delimiter+path;
  process.env.RIGUP_TEST_CLAUDE_SCOPE='Project config (shared via .mcp.json)';
  const plain=await cli(['doctor'],3);
  assert.equal(plain.diagnostics.find((d:{id:string})=>d.id==='claude:load')?.state,'reload-required');
  const connected=await cli(['doctor','--check-host','claude'],3);
  assert.equal(connected.diagnostics.find((d:{id:string})=>d.id==='claude:load')?.state,'passed');
  assert.doesNotMatch(JSON.stringify(connected),/fixture-token/);
  process.env.RIGUP_TEST_CLAUDE_SCOPE='User config';
  const shadowed=await cli(['doctor','--check-host','claude'],3);
  assert.equal(shadowed.diagnostics.find((d:{id:string})=>d.id==='claude:load')?.state,'reload-required');
 }finally{
  process.env.PATH=path;
  delete process.env.RIGUP_TEST_CLAUDE_SCOPE;
 }
})))));
