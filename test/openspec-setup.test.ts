import assert from 'node:assert/strict';
import {access,mkdir,readFile,writeFile} from 'node:fs/promises';
import {delimiter,join} from 'node:path';
import {test} from 'node:test';
import {runCli,type CliIO} from '../src/cli.js';
import {inspectOpenSpec} from '../src/integrations/sdd/openspec-setup.js';
import {project} from './helpers.js';

async function fixture(run:(root:string,control:string)=>Promise<void>){
 await project(async control=>{
  const root=join(control,'project');
  await mkdir(root);
  await run(root,control);
 });
}

async function installFakeOpenSpec(bin:string,shebang='#!'+process.execPath){
 await mkdir(bin,{recursive:true});
 await writeFile(join(bin,'openspec'),shebang+'\n'+`
const fs = require('node:fs');
const path = require('node:path');
const cwd = process.cwd();
switch (process.argv[2]) {
 case '--version':
  console.log('1.16.0');
  break;
 case 'list':
  console.log(process.env.RIGUP_TEST_OPENSPEC_ROOT || JSON.stringify({root: fs.existsSync('openspec/config.yaml') ? {path:cwd,source:'nearest'} : null}));
  break;
 case 'init':
  fs.mkdirSync('openspec/specs',{recursive:true});
  fs.mkdirSync('openspec/changes/archive',{recursive:true});
  fs.writeFileSync('openspec/config.yaml','schema: spec-driven\\n');
  fs.writeFileSync('openspec/specs/.gitkeep','');
  fs.writeFileSync('openspec/changes/archive/.gitkeep','');
  for (const name of ['openspec-propose','openspec-apply-change','openspec-archive-change']) {
   const dir = path.join('.agents','skills',name);
   fs.mkdirSync(dir,{recursive:true});
   fs.writeFileSync(path.join(dir,'SKILL.md'),'---\\nname: '+name+'\\ndescription: OpenSpec fixture.\\n---\\n');
  }
  break;
 default:
  process.exitCode=2;
}
`,{mode:0o755});
}

function terminal(root:string,control:string,answers:string[]){
 let output='';
 const io:CliIO={cwd:root,isTTY:true,write:text=>{output+=text;},
  read:async()=>answers.shift()??null,services:{stateRoot:join(control,'state'),cacheRoot:join(control,'cache')}};
 return {io,output:()=>output};
}

test('guided first init prepares OpenSpec before tool choices and applies the reviewed base workflow',()=>fixture(async(root,control)=>{
 const bin=join(control,'bin');
 await installFakeOpenSpec(bin);
 const path=process.env.PATH;
 process.env.PATH=bin+delimiter+path;
 try{
  const answers=['','2','','','','','',''];
  const first=terminal(root,control,answers);
  assert.equal(await runCli(['init'],first.io),0,first.output());
  assert.equal(answers.length,0);
  assert.ok(first.output().indexOf('自动补齐')<first.output().indexOf('可选工具'),first.output());
  assert.match(first.output(),/Install complete/);
  assert.match(await readFile(join(root,'.agents/skills/change-prepare/references/project.md'),'utf8'),/Native prepare: openspec-propose/);
  assert.match(await readFile(join(root,'openspec/config.yaml'),'utf8'),/spec-driven/);
 }finally{process.env.PATH=path;}
}));

test('a separate init resumes the OpenSpec selection and preserves existing project configuration',()=>fixture(async(root,control)=>{
 const bin=join(control,'bin');
 await installFakeOpenSpec(bin);
 const path=process.env.PATH;
 process.env.PATH=bin+delimiter+path;
 try{
  await mkdir(join(root,'openspec'));
  await writeFile(join(root,'openspec/config.yaml'),'schema: spec-driven\n# original project config\n');
  const proposal=join(root,'.agents/skills/openspec-propose');
  await mkdir(proposal,{recursive:true});
  const existing='---\nname: openspec-propose\ndescription: Existing project proposal.\n---\n';
  await writeFile(join(proposal,'SKILL.md'),existing);
  const first=terminal(root,control,['','2','2']);
  assert.equal(await runCli(['init'],first.io),3,first.output());
  assert.match(first.output(),/--agents codex --sdd openspec --prepare-openspec/);
  assert.doesNotMatch(first.output(),/openspec init --tools/);
  const prep=terminal(root,control,[]);
  assert.equal(await runCli(['init','--agents','codex','--sdd','openspec','--prepare-openspec','--json'],prep.io),0,prep.output());
  assert.equal(JSON.parse(prep.output()).nativeWorkflow,'ready');
  await assert.rejects(access(join(root,'.rigup/manifest.json')),{code:'ENOENT'});
  const resumed=terminal(root,control,['','','','','']);
  assert.equal(await runCli(['init'],resumed.io),0,resumed.output());
  assert.doesNotMatch(resumed.output(),/目标 agents|原生 SDD；/);
  assert.match(await readFile(join(root,'openspec/config.yaml'),'utf8'),/# original project config/);
  assert.equal(await readFile(join(proposal,'SKILL.md'),'utf8'),existing);
 }finally{process.env.PATH=path;}
}));

test('preflight accepts a declared store and prepares a missing local root with registered stores',()=>fixture(async(root,control)=>{
 const bin=join(control,'bin');
 await installFakeOpenSpec(bin);
 const path=process.env.PATH;
 process.env.PATH=bin+delimiter+path;
 try{
  const options={agents:['codex' as const],backend:'host' as const};
  process.env.RIGUP_TEST_OPENSPEC_ROOT=JSON.stringify({root:{path:join(control,'store'),source:'declared'}});
  let setup=await inspectOpenSpec(root,options);
  assert.equal(setup.needsRoot,false);
  assert.equal(setup.canPrepare,true);
  process.env.RIGUP_TEST_OPENSPEC_ROOT=JSON.stringify({root:null,status:[{code:'no_root_with_registered_stores'}]});
  setup=await inspectOpenSpec(root,options);
  assert.equal(setup.needsRoot,true);
  assert.equal(setup.canPrepare,true);
  process.env.RIGUP_TEST_OPENSPEC_ROOT=JSON.stringify({root:{path:join(control,'store'),source:'global_default'}});
  assert.equal((await inspectOpenSpec(root,options)).needsRoot,true);
 }finally{
  process.env.PATH=path;
  delete process.env.RIGUP_TEST_OPENSPEC_ROOT;
 }
}));

test('OpenSpec startup uses the filtered PATH for env interpreters',()=>fixture(async(root,control)=>{
 const bin=join(control,'bin');
 await installFakeOpenSpec(bin,'#!/usr/bin/env node');
 await writeFile(join(root,'node'),'#!/bin/sh\nprintf unsafe > "$PWD/node-was-invoked"\nexit 1\n',{mode:0o755});
 const path=process.env.PATH;
 process.env.PATH=['.',root,bin,path].join(delimiter);
 try{
  const setup=await inspectOpenSpec(root,{agents:['codex'],backend:'host'});
  assert.equal(setup.cliVersion,'1.16.0');
  await assert.rejects(access(join(root,'node-was-invoked')),{code:'ENOENT'});
 }finally{process.env.PATH=path;}
}));

test('portable setup checks the user PATH rather than the bundled runtime PATH',()=>fixture(async(root,control)=>{
 const bin=join(control,'bundle','bin');
 await installFakeOpenSpec(bin);
 const path=process.env.PATH,consumer=process.env.RIGUP_CONSUMER_PATH;
 process.env.PATH=bin+delimiter+path;
 process.env.RIGUP_CONSUMER_PATH='';
 try{
  const input=terminal(root,control,[]);
  const code=await runCli(['init','--agents','codex','--sdd','openspec','--defer-research','--json'],input.io);
  assert.equal(code,3,input.output());
  const report=JSON.parse(input.output());
  assert.ok(report.pending.includes('OpenSpec CLI is missing from PATH'));
  assert.match(report.pending.join('\n'),/Node\.js 22\.12.*user PATH/);
  await assert.rejects(access(join(root,'openspec/config.yaml')),{code:'ENOENT'});
 }finally{
  process.env.PATH=path;
  if(consumer===undefined)delete process.env.RIGUP_CONSUMER_PATH;
  else process.env.RIGUP_CONSUMER_PATH=consumer;
 }
}));
