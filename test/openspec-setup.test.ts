import assert from 'node:assert/strict';
import {access,mkdir,readFile,rename,symlink,writeFile} from 'node:fs/promises';
import {delimiter,dirname,join} from 'node:path';
import {test} from 'node:test';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {syncBuiltinESMExports} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {runCli,type CliIO} from '../src/cli.js';
import {inspectOpenSpec,prepareOpenSpec} from '../src/integrations/sdd/openspec-setup.js';
import {project,writeOpenSpecFixture} from './helpers.js';

async function fixture(run:(root:string,control:string)=>Promise<void>){
 await project(async control=>{
  const root=join(control,'project');
  await mkdir(root);
  await run(root,control);
 });
}

async function installFakeOpenSpec(bin:string,shebang='#!'+process.execPath){
 await writeOpenSpecFixture(bin,`
const fs = require('node:fs');
const path = require('node:path');
const cwd = process.cwd();
const rootOverride = ${JSON.stringify(join(bin,'root-override.json'))};
switch (process.argv[2]) {
 case '--version':
  console.log('1.16.0');
  break;
 case 'list':
  console.log(fs.existsSync(rootOverride) ? fs.readFileSync(rootOverride,'utf8') : JSON.stringify({root: fs.existsSync('openspec/config.yaml') ? {path:cwd,source:'nearest'} : null}));
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
`,shebang);
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
  const answers=['','2','','','','',''];
  const first=terminal(root,control,answers);
  const code=await runCli(['init'],first.io);
  assert.equal(code,0,first.output());
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
  await writeFile(join(bin,'root-override.json'),JSON.stringify({root:{path:join(control,'store'),source:'declared'}}));
  let setup=await inspectOpenSpec(root,options);
  assert.equal(setup.needsRoot,false);
  assert.equal(setup.canPrepare,true);
  await writeFile(join(bin,'root-override.json'),JSON.stringify({root:null,status:[{code:'no_root_with_registered_stores'}]}));
  setup=await inspectOpenSpec(root,options);
  assert.equal(setup.needsRoot,true);
  assert.equal(setup.canPrepare,true);
  await writeFile(join(bin,'root-override.json'),JSON.stringify({root:{path:join(control,'store'),source:'global_default'}}));
  assert.equal((await inspectOpenSpec(root,options)).needsRoot,true);
 }finally{
  process.env.PATH=path;
 }
}));

test('OpenSpec startup uses the filtered PATH for env interpreters',()=>fixture(async(root,control)=>{
 const bin=join(control,'bin with spaces');
 await installFakeOpenSpec(bin,'#!/usr/bin/env node');
 const projectBin=join(root,'bin');
 await writeOpenSpecFixture(projectBin,`require('node:fs').writeFileSync('project-openspec-was-invoked','unsafe');`);
 await writeFile(join(projectBin,process.platform==='win32'?'node.exe':'node'),'#!/bin/sh\nprintf unsafe > "$PWD/node-was-invoked"\nexit 1\n',{mode:0o755});
 const path=process.env.PATH;
 process.env.PATH=['.',root,projectBin,bin,path].join(delimiter);
 try{
  const setup=await inspectOpenSpec(root,{agents:['codex'],backend:'host'});
  assert.equal(setup.cliVersion,'1.16.0');
  await assert.rejects(access(join(root,'node-was-invoked')),{code:'ENOENT'});
  await assert.rejects(access(join(root,'project-openspec-was-invoked')),{code:'ENOENT'});
 }finally{process.env.PATH=path;}
}));

test('read-only OpenSpec preflight omits unrelated credentials while preserving explicit npm prefix',()=>fixture(async(root,control)=>{
 const bin=join(control,'bin'),prefix=join(control,'global-prefix');
 const names=['ANTHROPIC_API_KEY','OPENAI_API_KEY','npm_config__authToken','UNRELATED_PRIVATE_TOKEN'];
 await writeOpenSpecFixture(bin,`const names=${JSON.stringify(names)};
if(names.some(name=>process.env[name])||process.env.npm_config_prefix!==${JSON.stringify(prefix)})process.exit(98);
console.log(process.argv[2]==='--version'?'1.16.0':JSON.stringify({root:{path:process.cwd(),source:'declared'}}));`);
 const prior=Object.fromEntries(['PATH','npm_config_prefix',...names].map(name=>[name,process.env[name]]));
 process.env.PATH=bin+delimiter+prior.PATH;process.env.npm_config_prefix=prefix;for(const name of names)process.env[name]='synthetic-unrelated-credential';
 try{
  const setup=await inspectOpenSpec(root,{agents:[],backend:'host'});
  assert.equal(setup.cliVersion,'1.16.0');assert.deepEqual(setup.requirements,[]);
 }finally{for(const [name,value] of Object.entries(prior))if(value===undefined)delete process.env[name];else process.env[name]=value;}
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

test('separate OpenSpec approval binds the registry before native initialization',()=>fixture(async(root,control)=>{
 const bin=join(control,'bin');await installFakeOpenSpec(bin);
 const prior={PATH:process.env.PATH,RIGUP_NPM_REGISTRY:process.env.RIGUP_NPM_REGISTRY};
 process.env.PATH=bin+delimiter+prior.PATH;process.env.RIGUP_NPM_REGISTRY='https://npm.company.test/approved';
 try{
  const options={agents:['codex' as const],backend:'host' as const};
  const approved=await inspectOpenSpec(root,options);
  assert.equal(approved.registry,'https://npm.company.test/approved/');
  process.env.RIGUP_NPM_REGISTRY='https://npm.company.test/changed/';
  await assert.rejects(prepareOpenSpec(root,options,approved,{stateRoot:join(control,'state'),write:()=>{}}),/registry.*changed.*review/i);
  await assert.rejects(access(join(root,'openspec')),{code:'ENOENT'});
 }finally{for(const [key,value] of Object.entries(prior))if(value===undefined)delete process.env[key];else process.env[key]=value;}
}));

test('ready native OpenSpec permits independent foundation with unsafe private runtime input',()=>fixture(async(root,control)=>{
 const bin=join(control,'bin');await installFakeOpenSpec(bin);
 await mkdir(join(root,'openspec'));await writeFile(join(root,'openspec/config.yaml'),'schema: spec-driven\n');
 for(const name of ['openspec-propose','openspec-apply-change','openspec-archive-change']){
  const directory=join(root,'.agents/skills',name);await mkdir(directory,{recursive:true});
  await writeFile(join(directory,'SKILL.md'),'---\nname: '+name+'\ndescription: Existing native entry.\n---\n');
 }
 await mkdir(join(root,'.rigup'));
 const bytes='UNRELATED_PRIVATE_INPUT="synthetic-preserved-value"\n';await writeFile(join(root,'.rigup/.env'),bytes,{mode:0o600});
 const exec=promisify(execFile);await exec('git',['init','--quiet',root]);await exec('git',['-C',root,'add','--force','.rigup/.env']);
 const prior=process.env.PATH;process.env.PATH=bin+delimiter+prior;
 try{
  const setup=await inspectOpenSpec(root,{agents:['codex'],backend:'host'});assert.deepEqual(setup.requirements,[]);
  const input=terminal(root,control,[]);
  assert.equal(await runCli(['init','--agents','codex','--sdd','openspec','--defer-research','--json'],input.io),3,input.output());
  const prepared=JSON.parse(input.output());assert.equal(prepared.executable,true,input.output());
  const commit=terminal(root,control,[]);
  assert.equal(await runCli(['update','--apply',prepared.previewId,'--sessions-ended','--json'],commit.io),0,commit.output());
  assert.equal(JSON.parse(commit.output()).runtimeSetup.template.state,'pending');
  assert.ok(await readFile(join(root,'.rigup/manifest.json')));
  assert.ok(await readFile(join(root,'.agents/skills/change-prepare/SKILL.md')));
  assert.equal(await readFile(join(root,'.rigup/.env'),'utf8'),bytes);
  assert.doesNotMatch(input.output()+commit.output(),/synthetic-preserved-value/);
 }finally{if(prior===undefined)delete process.env.PATH;else process.env.PATH=prior;}
}));

test('OpenSpec pack and install use the approved registry with isolated npm credentials and pinned integrity',async context=>fixture(async(root,control)=>{
 const prefix=join(control,'prefix'),bin=process.platform==='win32'?prefix:join(prefix,'bin'),log=join(control,'npm-arguments.jsonl');
 await mkdir(bin,{recursive:true});await mkdir(join(root,'openspec'));await writeFile(join(root,'openspec/config.yaml'),'schema: spec-driven\n');
 const bytes=Buffer.from('synthetic tarball fixture'),integrity='sha512-'+createHash('sha512').update(bytes).digest('base64');
 // Replace only the upstream package bytes pin: npm dispatch and filesystem effects stay real.
 const originalRead=fs.readFile;
 const mocked=context.mock.method(fs,'readFile',async(...args:Parameters<typeof fs.readFile>)=>{
  const result=await originalRead(...args);
  if(String(args[0]).endsWith('/docs/compatibility/upstream-lock.json')){
   const lock=JSON.parse(result.toString());lock.integrations.find((entry:{integrationId:string})=>entry.integrationId==='openspec').packageIntegrity=integrity;
   return JSON.stringify(lock);
  }
  return result;
 });
 syncBuiltinESMExports();
 const native=`console.log(process.argv[2]==='--version'?'1.16.0':JSON.stringify({root:{path:${JSON.stringify(root)},source:'declared'}}));`;
 const script=`const fs=require('node:fs'),path=require('node:path');const args=process.argv.slice(2),prefix=${JSON.stringify(prefix)};
if(args[0]==='prefix'){console.log(prefix);process.exit(0);}
if(process.env.ANTHROPIC_API_KEY||process.env.npm_config__authToken)process.exit(98);
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');
if(args[0]==='pack'){fs.writeFileSync(path.join(args[args.indexOf('--pack-destination')+1],'fission-ai-openspec-1.16.0.tgz'),${JSON.stringify(bytes.toString())});}
else if(args[0]==='install'){
 if(process.platform==='win32'){const pkg=path.join(prefix,'node_modules/@fission-ai/openspec');fs.mkdirSync(path.join(pkg,'bin'),{recursive:true});fs.writeFileSync(path.join(pkg,'package.json'),JSON.stringify({name:'@fission-ai/openspec',bin:{openspec:'bin/openspec.js'}}));fs.writeFileSync(path.join(pkg,'bin/openspec.js'),${JSON.stringify(native)});fs.writeFileSync(path.join(prefix,'openspec.cmd'),'@echo off\\r\\n');}
 else fs.writeFileSync(path.join(prefix,'bin/openspec'),'#!'+${JSON.stringify(process.execPath)}+'\\n'+${JSON.stringify(native)},{mode:0o755});
}else process.exit(99);`;
 if(process.platform==='win32'){
  const pkg=join(prefix,'node_modules/npm');await mkdir(join(pkg,'bin'),{recursive:true});
  await writeFile(join(pkg,'package.json'),JSON.stringify({name:'npm',bin:{npm:'bin/npm-cli.js'}}));await writeFile(join(pkg,'bin/npm-cli.js'),script);await writeFile(join(bin,'npm.cmd'),'@echo off\r\n');
 }else await writeFile(join(bin,'npm'),'#!'+process.execPath+'\n'+script,{mode:0o755});
 const prior={RIGUP_CONSUMER_PATH:process.env.RIGUP_CONSUMER_PATH,RIGUP_NPM_REGISTRY:process.env.RIGUP_NPM_REGISTRY,ANTHROPIC_API_KEY:process.env.ANTHROPIC_API_KEY,npm_config__authToken:process.env.npm_config__authToken};
 process.env.RIGUP_CONSUMER_PATH=[bin,dirname(process.execPath)].join(delimiter);process.env.RIGUP_NPM_REGISTRY='https://npm.company.test/internal/';
 process.env.ANTHROPIC_API_KEY='synthetic-provider-secret';process.env.npm_config__authToken='synthetic-npm-secret';
 try{
  const options={agents:[],backend:'host' as const},approved=await inspectOpenSpec(root,options);
  assert.equal(approved.canPrepare,true);
  const result=await prepareOpenSpec(root,options,approved,{stateRoot:join(control,'state'),write:()=>{}});
  assert.deepEqual(result.requirements,[]);
  const commands=(await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line) as string[]);
  assert.deepEqual(commands.map(args=>args[0]),['pack','install']);
  for(const args of commands){assert.equal(args[args.indexOf('--registry')+1],'https://npm.company.test/internal/');assert.ok(args.includes('--userconfig'));assert.ok(args.includes('--globalconfig'));}
  assert.ok(commands[0].includes('@fission-ai/openspec@1.16.0'));
 }finally{
  mocked.mock.restore();syncBuiltinESMExports();
  for(const [key,value] of Object.entries(prior))if(value===undefined)delete process.env[key];else process.env[key]=value;
 }
}));

test('Windows npm preflight uses the global prefix on PATH and refuses to overwrite a package', {
 skip:process.platform!=='win32'&&'uses Windows npm shims',
},()=>fixture(async(root,control)=>{
 const prefix=join(control,'npm prefix');
 const npmPackage=join(prefix,'node_modules','npm');
 await mkdir(join(npmPackage,'bin'),{recursive:true});
 await writeFile(join(npmPackage,'package.json'),JSON.stringify({name:'npm',bin:{npm:'bin/npm-cli.js'}}));
 await writeFile(join(npmPackage,'bin','npm-cli.js'),"if(process.argv.slice(2).join(' ')==='prefix -g') console.log("+JSON.stringify(prefix)+");");
 await writeFile(join(prefix,'npm.cmd'),'@echo off\r\nnode "%~dp0node_modules\\npm\\bin\\npm-cli.js" %*\r\n');
 const path=process.env.RIGUP_CONSUMER_PATH;
 process.env.RIGUP_CONSUMER_PATH=[prefix,dirname(process.execPath)].join(delimiter);
 try{
  const options={agents:['codex' as const],backend:'host' as const};
  const setup=await inspectOpenSpec(root,options);
  assert.equal(setup.prefix,prefix);
  assert.equal(setup.canPrepare,true);
  await mkdir(join(prefix,'node_modules','@fission-ai','openspec'),{recursive:true});
  assert.equal((await inspectOpenSpec(root,options)).canPrepare,false);
 }finally{
  if(path===undefined)delete process.env.RIGUP_CONSUMER_PATH;
  else process.env.RIGUP_CONSUMER_PATH=path;
 }
}));

test('Windows OpenSpec preflight resolves a local npm prefix through its package entry', {
 skip:process.platform!=='win32'&&'uses Windows npm shims',
},()=>fixture(async(root,control)=>{
 const modules=join(control,'npm prefix & tools','node_modules');
 const shims=join(modules,'.bin'),pkg=join(modules,'@fission-ai','openspec');
 const entryDir=join(pkg,'bin'),entry=join(entryDir,'openspec.js');
 await mkdir(shims,{recursive:true});await mkdir(entryDir,{recursive:true});
 await writeFile(join(pkg,'package.json'),JSON.stringify({name:'@fission-ai/openspec',bin:{openspec:'./bin/openspec.js'}}));
 await writeFile(entry,'console.log(process.argv[2]==="--version"?"1.16.0":JSON.stringify({root:null}));');
 await writeFile(join(shims,'openspec.cmd'),'@echo off\r\nexit /b 97\r\n');
 const path=process.env.RIGUP_CONSUMER_PATH;
 process.env.RIGUP_CONSUMER_PATH=[shims,dirname(process.execPath)].join(delimiter);
 try{
  const options={agents:['codex' as const],backend:'host' as const};
  const setup=await inspectOpenSpec(root,options);
  assert.deepEqual(setup.cli?.args,[entry]);
  assert.equal(setup.cliVersion,'1.16.0');
  assert.equal(setup.canPrepare,true);
  const external=join(control,'substituted entry');
  await rename(entryDir,external);
  await symlink(external,entryDir,'junction');
  const unsafe=await inspectOpenSpec(root,options);
  assert.equal(unsafe.cli,undefined);
  assert.match(unsafe.requirements.join('\n'),/existing openspec command could not be resolved/);
 }finally{
  if(path===undefined)delete process.env.RIGUP_CONSUMER_PATH;
  else process.env.RIGUP_CONSUMER_PATH=path;
 }
}));
