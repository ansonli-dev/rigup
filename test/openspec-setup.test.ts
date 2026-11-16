import assert from 'node:assert/strict';
import {access,copyFile,mkdir,readFile,realpath,rename,symlink,writeFile} from 'node:fs/promises';
import {delimiter,dirname,join} from 'node:path';
import {test} from 'node:test';
import {writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {privateDirectory,signature} from '../src/generator/cache.js';
import {npmRegistry} from './npm-registry-fixture.js';
import {openspecPackage} from '../src/integrations/sdd/openspec.js';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {runCli,type CliIO} from '../src/cli.js';
import {inspectOpenSpec,prepareOpenSpec} from '../src/integrations/sdd/openspec-setup.js';
import {project,writeOpenSpecFixture} from './helpers.js';

test('OpenSpec entry inspection does not run project PATH git', {skip:process.platform==='win32'},()=>fixture(async(root,control)=>{
 const bin=join(root,'bin'),marker=join(control,'git-ran');
 await mkdir(bin);await writeFile(join(bin,'git'),'#!/bin/sh\ntouch '+JSON.stringify(marker)+'\n',{mode:0o755});
 const previous=process.env.PATH;
 process.env.PATH=bin+delimiter+previous;
 try{
  await inspectOpenSpec(root,{agents:['codex'],backend:'host'});
  await assert.rejects(access(marker),{code:'ENOENT'});
 }finally{process.env.PATH=previous;}
}));

async function fixture(run:(root:string,control:string)=>Promise<void>){
 await project(async control=>{
  const root=join(control,'project');
  await mkdir(root);
  await run(root,control);
 });
}

async function installFakeOpenSpec(bin:string,shebang='#!'+process.execPath,version='1.16.0',entries=['openspec-propose','openspec-apply-change','openspec-archive-change'],during:{version?:string;list?:string;init?:string}={}){
 await writeOpenSpecFixture(bin,`
const fs = require('node:fs');
const path = require('node:path');
const cwd = process.cwd();
const rootOverride = ${JSON.stringify(join(bin,'root-override.json'))};
switch (process.argv[2]) {
 case '--version':
  ${during.version??''}
  console.log(${JSON.stringify(version)});
  break;
 case 'list':
  ${during.list??''}
  console.log(fs.existsSync(rootOverride) ? fs.readFileSync(rootOverride,'utf8') : JSON.stringify({root: fs.existsSync('openspec/config.yaml') ? {path:cwd,source:'nearest'} : null}));
  break;
 case 'init':
  ${during.init??''}
  fs.mkdirSync('openspec/specs',{recursive:true});
  fs.mkdirSync('openspec/changes/archive',{recursive:true});
  fs.writeFileSync('openspec/config.yaml','schema: spec-driven\\n');
  fs.writeFileSync('openspec/specs/.gitkeep','');
  fs.writeFileSync('openspec/changes/archive/.gitkeep','');
  for (const name of ${JSON.stringify(entries)}) {
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
  const answers=['2','2','','',''];
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

test('a broken OpenSpec launcher still shows the original retry command',()=>fixture(async(root,control)=>{
 const bin=join(control,'bin');
 await installFakeOpenSpec(bin,undefined,'');
 const previous=process.env.PATH;process.env.PATH=bin+delimiter+previous;
 try{
  const cli=terminal(root,control,[]);
  const args=['init','--agents','codex','--sdd','openspec','--defer-research','--review','--language','zh-CN'];
  assert.equal(await runCli(args,cli.io),3,cli.output());
  assert.match(cli.output(),/existing openspec command did not start successfully/);
  assert.match(cli.output(),/^Next: rigup init .+ --agents codex --sdd openspec --defer-research --review --language 'zh-CN'$/m);
 }finally{process.env.PATH=previous;}
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
  const first=terminal(root,control,['2','2','2']);
  assert.equal(await runCli(['init'],first.io),3,first.output());
  assert.match(first.output(),/--agents codex --sdd openspec --prepare-openspec/);
  assert.doesNotMatch(first.output(),/openspec init --tools/);
  const prep=terminal(root,control,[]);
  assert.equal(await runCli(['init','--agents','codex','--sdd','openspec','--prepare-openspec','--json'],prep.io),0,prep.output());
  assert.equal(JSON.parse(prep.output()).nativeWorkflow,'ready');
  await assert.rejects(access(join(root,'.rigup/manifest.json')),{code:'ENOENT'});
  const resumed=terminal(root,control,['','']);
  assert.equal(await runCli(['init'],resumed.io),0,resumed.output());
  assert.doesNotMatch(resumed.output(),/目标 agents|原生 SDD；/);
  assert.match(await readFile(join(root,'openspec/config.yaml'),'utf8'),/# original project config/);
  assert.equal(await readFile(join(proposal,'SKILL.md'),'utf8'),existing);
 }finally{process.env.PATH=path;}
}));

for(const decision of ['2','3'])test('OpenSpec writes remain visible after '+(decision==='2'?'saving':'cancelling')+' the Rigup preview',()=>fixture(async(root,control)=>{
 const bin=join(control,'bin');await installFakeOpenSpec(bin);
 const path=process.env.PATH;process.env.PATH=bin+delimiter+path;
 try{
  const cli=terminal(root,control,['',decision]);
  assert.equal(await runCli(['init','--agents','codex','--sdd','openspec','--tools','none'],cli.io),decision==='2'?3:130,cli.output());
  assert.match(cli.output(),/OpenSpec 1\.16\.0 and selected project entries are ready/);
  assert.doesNotMatch(cli.output(),/Nothing was written/);
  await access(join(root,'openspec/config.yaml'));
  await assert.rejects(access(join(root,'.rigup/manifest.json')),{code:'ENOENT'});
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
  assert.match(report.pending.join('\n'),/working Node\.js.*user PATH/);
  await assert.rejects(access(join(root,'openspec/config.yaml')),{code:'ENOENT'});
 }finally{
  process.env.PATH=path;
  if(consumer===undefined)delete process.env.RIGUP_CONSUMER_PATH;
  else process.env.RIGUP_CONSUMER_PATH=consumer;
 }
}));

test('an existing OpenSpec CLI can complete native preparation with a different version and registry',()=>fixture(async(root,control)=>{
 const bin=join(control,'bin');await installFakeOpenSpec(bin,undefined,'2.0.0');
 const prior={PATH:process.env.PATH,RIGUP_NPM_REGISTRY:process.env.RIGUP_NPM_REGISTRY};
 process.env.PATH=bin+delimiter+prior.PATH;process.env.RIGUP_NPM_REGISTRY='https://npm.company.test/approved';
 try{
  const options={agents:['codex' as const],backend:'host' as const};
  assert.equal((await inspectOpenSpec(root,options)).canPrepare,true);
  const {planOpenSpecPreparation}=await import('../src/integrations/sdd/openspec-setup.js');
  const stateRoot=join(control,'state');
  const {approval}=await planOpenSpecPreparation(root,options,{stateRoot,view:async()=>{throw Error('unexpected npm view');}});
  assert.equal(approval?.kind,'existing');
  process.env.RIGUP_NPM_REGISTRY='https://npm.company.test/changed/';
  assert.deepEqual((await prepareOpenSpec(root,options,approval!,{stateRoot,write:()=>{}})).requirements,[]);
  await access(join(root,'openspec','config.yaml'));
 }finally{for(const [key,value] of Object.entries(prior))if(value===undefined)delete process.env[key];else process.env[key]=value;}
}));

test('OpenSpec preparation verifies the approved launcher and complete native output before project writes',()=>fixture(async(root,control)=>{
 const bin=join(control,'bin'),stateRoot=join(control,'state'),marker=join(control,'unexpected-launch');
 const path=process.env.PATH;process.env.PATH=bin+delimiter+path;
 const options={agents:['codex' as const],backend:'host' as const};
 try{
  await installFakeOpenSpec(bin,undefined,'2.0.0',['openspec-propose']);
  const {planOpenSpecPreparation}=await import('../src/integrations/sdd/openspec-setup.js');
  const {approval}=await planOpenSpecPreparation(root,options,{stateRoot});assert.equal(approval?.kind,'existing');
  await assert.rejects(prepareOpenSpec(root,options,approval!,{stateRoot,write:()=>{}}),/missing native entry/);
  await assert.rejects(access(join(root,'openspec')),{code:'ENOENT'});
  await writeOpenSpecFixture(bin,`require('node:fs').writeFileSync(${JSON.stringify(marker)},'unsafe'); console.log('2.0.0');`);
  await assert.rejects(prepareOpenSpec(root,options,approval!,{stateRoot,write:()=>{}}),/CLI changed after approval/);
  await assert.rejects(access(marker),{code:'ENOENT'});
 }finally{process.env.PATH=path;}
}));

test('OpenSpec preparation rechecks existing entries after staged generation before publishing',()=>fixture(async(root,control)=>{
 const bin=join(control,'bin'),stateRoot=join(control,'state');
 const skills=join(root,'.agents','skills'),proposal=join(skills,'openspec-propose','SKILL.md');
 const generated=['openspec-apply-change','openspec-archive-change'];
 await mkdir(join(root,'openspec'));await writeFile(join(root,'openspec','config.yaml'),'schema: spec-driven\n');
 await mkdir(dirname(proposal),{recursive:true});
 await writeFile(proposal,'---\nname: openspec-propose\ndescription: Existing proposal.\n---\n');
 await installFakeOpenSpec(bin,undefined,'2.0.0',generated,{init:`fs.unlinkSync(${JSON.stringify(proposal)});`});
 const path=process.env.PATH;process.env.PATH=bin+delimiter+path;
 try{
  const options={agents:['codex' as const],backend:'host' as const};
  const {planOpenSpecPreparation}=await import('../src/integrations/sdd/openspec-setup.js');
  const {approval}=await planOpenSpecPreparation(root,options,{stateRoot});
  assert.equal(approval?.kind,'existing');
  assert.equal(approval.needsRoot,false);
  await assert.rejects(prepareOpenSpec(root,options,approval,{stateRoot,write:()=>{}}),/missing native entry: openspec-propose/);
  for(const name of generated)await assert.rejects(access(join(skills,name,'SKILL.md')),{code:'ENOENT'});
 }finally{process.env.PATH=path;}
}));

test('OpenSpec preparation stops if project root creation becomes necessary during staged generation',()=>fixture(async(root,control)=>{
 const bin=join(control,'bin'),stateRoot=join(control,'state'),config=join(root,'openspec','config.yaml');
 await mkdir(dirname(config));await writeFile(config,'schema: spec-driven\n');
 await installFakeOpenSpec(bin,undefined,'2.0.0',undefined,{init:`fs.unlinkSync(${JSON.stringify(config)});`});
 const path=process.env.PATH;process.env.PATH=bin+delimiter+path;
 try{
  const options={agents:['codex' as const],backend:'host' as const};
  const {planOpenSpecPreparation}=await import('../src/integrations/sdd/openspec-setup.js');
  const {approval}=await planOpenSpecPreparation(root,options,{stateRoot});
  assert.equal(approval?.kind,'existing');
  assert.equal(approval.needsRoot,false);
  await assert.rejects(prepareOpenSpec(root,options,approval,{stateRoot,write:()=>{}}),/preparation scope changed/);
  await assert.rejects(access(join(root,'.agents')),{code:'ENOENT'});
 }finally{process.env.PATH=path;}
}));

for(const step of ['version','list','init'] as const)test(`OpenSpec never invokes a replacement launcher after ${step}`,()=>fixture(async(root,control)=>{
 const bin=join(control,'bin'),stateRoot=join(control,'state'),armed=join(control,'armed'),marker=join(control,'unexpected-launch');
 const listed=join(control,'listed');
 const replacement=`\nfs.writeFileSync(${JSON.stringify(marker)},process.argv[2]);\n`;
 const replace=`fs.appendFileSync(__filename,${JSON.stringify(replacement)});`;
 // Replace on the second approved list, after preparation has made progress.
 const onApprovedCommand=step==='list'?`if (fs.existsSync(${JSON.stringify(listed)})) { ${replace} } else fs.writeFileSync(${JSON.stringify(listed)},'');`:replace;
 await installFakeOpenSpec(bin,undefined,'2.0.0',undefined,{
  [step]:`if (fs.existsSync(${JSON.stringify(armed)})) { ${onApprovedCommand} }`
 });
 const path=process.env.PATH;process.env.PATH=bin+delimiter+path;
 try{
  const options={agents:['codex' as const],backend:'host' as const};
  const {planOpenSpecPreparation}=await import('../src/integrations/sdd/openspec-setup.js');
  const {approval}=await planOpenSpecPreparation(root,options,{stateRoot});
  assert.equal(approval?.kind,'existing');
  await writeFile(armed,'approved');
  await assert.rejects(prepareOpenSpec(root,options,approval,{stateRoot,write:()=>{}}),/CLI changed after approval/);
  await assert.rejects(access(marker),{code:'ENOENT'});
  await assert.rejects(access(join(root,'openspec')),{code:'ENOENT'});
 }finally{process.env.PATH=path;}
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

const nativeProgram=`#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
const {version}=require('../package.json');
if(process.argv[2]==='--version')console.log(version);
else if(process.argv[2]==='list')console.log(JSON.stringify({root:fs.existsSync('openspec/config.yaml')?{path:process.cwd(),source:'nearest'}:null}));
else if(process.argv[2]==='init'){
 fs.mkdirSync('openspec',{recursive:true});fs.writeFileSync('openspec/config.yaml','schema: spec-driven\\n');
 for(const name of ['openspec-propose','openspec-apply-change','openspec-archive-change']){
  const directory=path.join('.agents','skills',name);
  fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,'SKILL.md'),'---\\nname: '+name+'\\ndescription: Native fixture.\\n---\\n');
 }
}else process.exitCode=2;
`;
const prepareFlags=['init','--agents','codex','--sdd','openspec','--prepare-openspec','--sessions-ended'];
type TestRegistry = Parameters<Parameters<typeof npmRegistry>[0]>[0];
async function openSpecRegistry(control:string,run:(registry:TestRegistry,paths:{prefix:string;bin:string;packageJson:string;receipt:string})=>Promise<void>){
 await npmRegistry(async registry=>{
  const prefix=join(control,'prefix'),bin=process.platform==='win32'?prefix:join(prefix,'bin');
  await mkdir(bin,{recursive:true});
  const packageJson=join(prefix,process.platform==='win32'?'node_modules':'lib/node_modules',openspecPackage,'package.json');
  const receipt=join(control,'state','openspec-'+signature({prefix,name:openspecPackage})+'.json');
  const environment={RIGUP_CONSUMER_PATH:[bin,dirname(process.execPath)].join(delimiter),npm_config_prefix:prefix,
   RIGUP_NPM_REGISTRY:registry.url,ANTHROPIC_API_KEY:'synthetic-provider-secret',npm_config__authToken:'synthetic-npm-secret'};
  const prior=Object.fromEntries(Object.keys(environment).map(name=>[name,process.env[name]]));
  Object.assign(process.env,environment);
  try{await run(registry,{prefix,bin,packageJson,receipt});}
  finally{for(const [name,value] of Object.entries(prior))if(value===undefined)delete process.env[name];else process.env[name]=value;}
 });
}
const publishOpenSpec=(registry:TestRegistry,version='2.0.0',extra:Record<string,string>={},enginesNode='>=22.19.0')=>
 registry.publish(openspecPackage,version,{bin:{openspec:'bin/openspec.js'},engines:{node:enginesNode}},{'bin/openspec.js':nativeProgram,...extra});

test('OpenSpec installs the approved version into an isolated prefix with real npm',()=>fixture((root,control)=>openSpecRegistry(control,async(registry,paths)=>{
 const approved=await publishOpenSpec(registry);
 await publishOpenSpec(registry,'2.1.0');
 const readonly=terminal(root,control,[]);
 assert.equal(await runCli(['init','--agents','codex','--sdd','openspec','--review','--json'],readonly.io),3,readonly.output());
 assert.equal(registry.requests.length,0);
 registry.onRequest=()=>{
  if(registry.requests.length===2)registry.tag(openspecPackage,'latest','2.1.0');
 };
 const cli=terminal(root,control,[]);
 assert.equal(await runCli([...prepareFlags,'--json'],cli.io),0,cli.output());
 const result=JSON.parse(cli.output());
 assert.equal(result.nativeWorkflow,'ready');
 assert.deepEqual(result.nativePreparation,{kind:'install',name:openspecPackage,version:'2.0.0',registry:registry.url,prefix:paths.prefix,agents:['codex'],needsRoot:true,needsEntries:['codex']});
 assert.equal(JSON.parse(await readFile(paths.packageJson,'utf8')).version,'2.0.0');
 assert.deepEqual(JSON.parse(await readFile(paths.receipt,'utf8')),{name:openspecPackage,prefix:paths.prefix,version:'2.0.0',packageIntegrity:approved.integrity,registry:registry.url});
 assert.ok(registry.requests.some(request=>request.path.endsWith('/2.0.0.tgz')));
 assert.ok(!registry.requests.some(request=>request.path.endsWith('/2.1.0.tgz')));
 assert.ok(registry.requests.every(request=>!request.authorization));
 await access(join(root,'.agents/skills/openspec-propose/SKILL.md'));
 await access(join(root,'openspec/config.yaml'));
})));

test('OpenSpec reports the verified global CLI if project preparation fails',()=>fixture((root,control)=>openSpecRegistry(control,async(registry,paths)=>{
 await publishOpenSpec(registry,'2.0.0',{
  'bin/openspec.js':nativeProgram.replace("else if(process.argv[2]==='init'){","else if(process.argv[2]==='init'){process.exit(7);"),
 });
 const cli=terminal(root,control,[]);
 let status:unknown;
 cli.io.services!.report=report=>{status=report.installStatus;};
 assert.equal(await runCli(prepareFlags,cli.io),1,cli.output());
 assert.equal(status,'partial',cli.output());
 assert.match(cli.output(),/Result: OpenSpec partially prepared/);
 assert.ok(cli.output().includes('OpenSpec CLI 2.0.0 installed and verified in '+paths.prefix+'.'));
 assert.match(cli.output(),/^Next: rigup init .+ --sdd openspec --prepare-openspec$/m);
 assert.equal(JSON.parse(await readFile(paths.receipt,'utf8')).version,'2.0.0');
 await assert.rejects(access(join(root,'openspec')),{code:'ENOENT'});
})));

test('OpenSpec rejects a weaker matching digest after npm successfully packs the replacement',()=>fixture((root,control)=>openSpecRegistry(control,async(registry,paths)=>{
 const approved=await publishOpenSpec(registry);
 const replacement=await publishOpenSpec(registry,'2.0.0',{'replacement.txt':'Different package bytes'});
 replacement.advertisedIntegrity=approved.integrity+' sha256-'+createHash('sha256').update(replacement.bytes).digest('base64');
 registry.onRequest=()=>{if(registry.requests.length===2)delete replacement.advertisedIntegrity;};
 const cli=terminal(root,control,[]);
 assert.equal(await runCli([...prepareFlags,'--json'],cli.io),1,cli.output());
 assert.match(JSON.parse(cli.output()).error,/OpenSpec package integrity mismatch/);
 assert.ok(registry.requests.some(request=>request.path.endsWith('/2.0.0.tgz')));
 await assert.rejects(access(paths.packageJson),{code:'ENOENT'});
 await assert.rejects(access(join(root,'openspec')),{code:'ENOENT'});
})));

for(const changed of ['prefix','registry'] as const)test('OpenSpec rechecks '+changed+' after pack',()=>fixture((root,control)=>openSpecRegistry(control,async(registry,paths)=>{
 await publishOpenSpec(registry);
 const sentinel=join(paths.bin,process.platform==='win32'?'openspec.ps1':'openspec');
 registry.onTarball=()=>{
  if(changed==='prefix')writeFileSync(sentinel,'Unrelated user file',{mode:0o600});
  else process.env.RIGUP_NPM_REGISTRY='https://changed.example.test/';
 };
 const cli=terminal(root,control,[]);
 assert.equal(await runCli([...prepareFlags,'--json'],cli.io),1,cli.output());
 assert.match(JSON.parse(cli.output()).error,changed==='prefix'?/scope.*changed/:/registry.*changed/i);
 await assert.rejects(access(paths.packageJson),{code:'ENOENT'});
 if(changed==='prefix')assert.equal(await readFile(sentinel,'utf8'),'Unrelated user file');
})));

for(const interactive of [false,true])test('OpenSpec receipt failure remains a partial install in '+(interactive?'guided init':'JSON preparation'),()=>fixture((root,control)=>openSpecRegistry(control,async(registry,paths)=>{
 await publishOpenSpec(registry);
 await privateDirectory(join(control,'state'),root);
 await mkdir(paths.receipt);
 const cli=terminal(root,control,interactive?['2','2','']:[]);
 assert.equal(await runCli(interactive?['init']:[...prepareFlags,'--json'],cli.io),1,cli.output());
 assert.match(cli.output(),/receipt could not be saved/);
 if(!interactive)assert.equal(JSON.parse(cli.output()).installStatus,'partial');
 assert.equal(JSON.parse(await readFile(paths.packageJson,'utf8')).version,'2.0.0');
 await assert.rejects(access(join(root,'openspec')),{code:'ENOENT'});
 const requestCount=registry.requests.length;
 const next=terminal(root,control,[]);
 assert.equal(await runCli([...prepareFlags,'--json'],next.io),0,next.output());
 assert.equal(JSON.parse(next.output()).nativePreparation.kind,'existing');
 assert.equal(registry.requests.length,requestCount);
})));

test('OpenSpec registry errors are blockers and cancelling the metadata query exits 130',()=>fixture((root,control)=>openSpecRegistry(control,async registry=>{
 await publishOpenSpec(registry);
 registry.responseStatus=503;
 const failed=terminal(root,control,[]);
 assert.equal(await runCli([...prepareFlags,'--json'],failed.io),3,failed.output());
 assert.ok(JSON.parse(failed.output()).pending.some((line:string)=>line.includes(openspecPackage+'@latest')&&line.includes(registry.url)));
 const cancelled=terminal(root,control,[]),abort=new AbortController();
 cancelled.io.services!.signal=abort.signal;
 registry.onRequest=()=>abort.abort();
 assert.equal(await runCli([...prepareFlags,'--json'],cancelled.io),130,cancelled.output());
 await assert.rejects(access(join(root,'openspec')),{code:'ENOENT'});
})));

test('portable OpenSpec approval uses the consumer Node engines range', {skip:process.platform==='win32'},()=>fixture((root,control)=>openSpecRegistry(control,async(registry,paths)=>{
 await publishOpenSpec(registry);
 const wrapper=join(paths.bin,'node');
 await writeFile(wrapper,'#!/bin/sh\nif [ "$1" = "--version" ]; then printf "v20.0.0\\n"; exit; fi\nexec '+JSON.stringify(process.execPath)+' "$@"\n',{mode:0o755});
 const cli=terminal(root,control,[]);
 assert.equal(await runCli([...prepareFlags,'--json'],cli.io),3,cli.output());
 assert.match(JSON.parse(cli.output()).pending.join(' '),/@fission-ai\/openspec@2\.0\.0 requires Node >=22\.19\.0 \(found v20\.0\.0\)/);
 assert.equal(registry.requests.length,1);
})));

test('Windows npm preflight uses the global prefix on PATH and refuses to overwrite a package', {
 skip:process.platform!=='win32'&&'uses Windows npm shims',
},()=>fixture(async(root,control)=>{
 const prefix=join(control,'npm prefix');
 const npmPackage=join(prefix,'node_modules','npm');
 await mkdir(join(npmPackage,'bin'),{recursive:true});
 await writeFile(join(npmPackage,'package.json'),JSON.stringify({name:'npm',bin:{npm:'bin/npm-cli.js'}}));
 await writeFile(join(npmPackage,'bin','npm-cli.js'),"if(process.argv.slice(2).join(' ')==='prefix -g') console.log("+JSON.stringify(prefix)+");");
 await writeFile(join(prefix,'npm.cmd'),'@echo off\r\nnode "%~dp0node_modules\\npm\\bin\\npm-cli.js" %*\r\n');
 const prefixNode=join(prefix,'node.exe');
 const earlier=join(control,'earlier bin');
 await mkdir(earlier);
 await Promise.all([copyFile(process.execPath,prefixNode),copyFile(process.execPath,join(earlier,'node.exe'))]);
 const path=process.env.RIGUP_CONSUMER_PATH;
 process.env.RIGUP_CONSUMER_PATH=[earlier,prefix].join(delimiter);
 try{
  const options={agents:['codex' as const],backend:'host' as const};
  const setup=await inspectOpenSpec(root,options);
  assert.equal(setup.prefix,prefix);
  assert.equal(setup.node?.file,await realpath(prefixNode));
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
