import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {appendFile,chmod,link,mkdir,readdir,readFile,stat,symlink,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {parseEnv} from 'node:util';
import {runCli} from '../src/cli.js';
import {project} from './helpers.js';
import {applyRuntimeInputs,runtimeEnvironment,runtimeSetupSummary} from '../src/runtime-inputs.js';
import type {SetupOptions} from '../src/types.js';

const local='RIGUP_TEST_SERVICE_TOKEN';
const missing='RIGUP_TEST_SERVICE_URL';
const host='RIGUP_TEST_HOST_TOKEN';
const ci='RIGUP_TEST_CI_TOKEN';
const ambient='synthetic-service-initial';
const git=(root:string,...args:string[])=>execFileSync('git',['-C',root,...args],{encoding:'utf8'});

test('apply keeps private inputs out of previews and uses them only for the declared check',()=>project(async root=>project(async state=>{
 const secretFile=join(root,'.rigup','.env');
 const run=async(args:string[],expected:number)=>{
  let stdout='',stderr='';
  const code=await runCli([...args,'--json'],{cwd:root,isTTY:false,write:text=>stdout+=text,writeError:text=>stderr+=text,
   services:{cacheRoot:join(state,'cache'),stateRoot:join(state,'state')}});
  assert.equal(code,expected,stdout+stderr);
  assert.doesNotMatch(stdout+stderr,/synthetic-(?:service|host|ci|unrelated)/);
  return JSON.parse(stdout);
 };
 const original={...process.env};
 process.env[local]=ambient;
 process.env[host]='synthetic-host-value';
 process.env[ci]='synthetic-ci-value';
 process.env.RIGUP_TEST_UNRELATED_TOKEN='synthetic-unrelated-value';
 try{
  git(root,'init');
  await mkdir(join(root,'.rigup'));
  await writeFile(join(root,'.rigup/config.yaml'),JSON.stringify({
   agents:['codex'],backend:'host',projectRules:false,customSkills:[{source:'custom',position:'deliver'}],
   customer:{commands:{environment:{executable:process.execPath,args:['environment.mjs'],cwd:'.',envRefs:[local,missing]}}},
   mcp:[{id:'knowledge',agents:['codex'],url:'https://mcp.example.test',bearerTokenEnv:host}],
   quality:{gitlab:{checks:[],openwiki:{envRefs:[ci],sourcePaths:['src/**/*']}}},
  }));
  await mkdir(join(root,'custom'));
  await writeFile(join(root,'custom/SKILL.md'),'---\nname: customer-verify\ndescription: Verify the local environment.\n---\nVerify environment.\n');
  await writeFile(join(root,'environment.mjs'),`
  if (process.env.${local} !== 'manual-local-value' || process.env.${missing} !== 'https://tests.example.test/#suite' ||
   process.env.${host} || process.env.${ci} || process.env.RIGUP_TEST_UNRELATED_TOKEN) process.exit(1);
  `);
  const dry=await run(['init','--dry-run'],0);
  assert.equal(dry.runtimeSetup.inputs.find((input:{name:string})=>input.name===local).source,'calling-environment');
  await assert.rejects(readFile(secretFile),{code:'ENOENT'});
  assert.deepEqual(await readdir(join(root,'.rigup')),['config.yaml']);
  const installed=await run(['init'],0);
  assert.equal(installed.runtimeSetup.template.state,'written');
  assert.deepEqual(installed.runtimeSetup.template.imported,[{name:local,source:'calling-environment'}]);
  assert.equal(installed.runtimeSetup.inputs.find((input:{name:string})=>input.name===missing).state,'missing');
  assert.equal(installed.runtimeSetup.inputs.find((input:{name:string})=>input.name===host).destination,'agent host (codex)');
  assert.equal(installed.runtimeSetup.inputs.find((input:{name:string})=>input.name===ci).destination,'GitLab CI variables');
  assert.equal(installed.runtimeSetup.inputs.find((input:{name:string})=>input.name===ci).state,'unverified');
  assert.equal(parseEnv(await readFile(secretFile,'utf8'))[local],ambient);
  assert.equal(parseEnv(await readFile(secretFile,'utf8'))[missing],'');
  assert.doesNotMatch(await readFile(secretFile,'utf8'),/RIGUP_TEST_(?:HOST|CI|UNRELATED)_TOKEN/);
  assert.equal(git(root,'check-ignore','.rigup/.env').trim(),'.rigup/.env');
  if(process.platform!=='win32')assert.equal((await stat(secretFile)).mode&0o777,0o600);
  const manifest=JSON.parse(await readFile(join(root,'.rigup/manifest.json'),'utf8'));
  for(const asset of manifest.assets){
   assert.notEqual(asset.target,'.rigup/.env');
   if(asset.baseline)assert.doesNotMatch(await readFile(join(root,asset.baseline),'utf8'),/synthetic-(?:service|host|ci|unrelated)/);
  }

  const originalFile=await readFile(secretFile,'utf8');
  await writeFile(secretFile,originalFile.replace(ambient,'manual-local-value').replace(missing+'=',missing+'= # my endpoint')+'# my comment\n');
  await appendFile(secretFile,'UNDECLARED="other-value"\n');
  process.env[missing]='https://tests.example.test/#suite';
  process.env[local]='synthetic-service-later';
  const review=await run(['update','--review'],3);
  assert.equal(parseEnv(await readFile(secretFile,'utf8'))[missing],'');
  await run(['update','--apply',review.previewId,'--sessions-ended'],0);
  const updated=await readFile(secretFile,'utf8');
  assert.match(updated,/# my endpoint\n# my comment\nUNDECLARED="other-value"\n$/);
  assert.equal(parseEnv(updated)[local],'manual-local-value');
  assert.equal(parseEnv(updated)[missing],process.env[missing]);
  const doctor=await run(['doctor','--run-checks','environment'],3);
  assert.equal(doctor.checks.find((check:{name:string})=>check.name==='environment').status,'passed');
  assert.equal(doctor.runtimeSetup.inputs.find((input:{name:string})=>input.name===local).source,'project-file');
  assert.equal(doctor.runtimeSetup.inputs.find((input:{name:string})=>input.name===ci).state,'unverified');
  assert.equal((await run(['update','--review'],0)).installStatus,'up-to-date');
  assert.equal(await readFile(secretFile,'utf8'),updated);
 }finally{
  for(const name of [local,missing,host,ci,'RIGUP_TEST_UNRELATED_TOKEN']){
   if(original[name]===undefined)delete process.env[name];else process.env[name]=original[name];
  }
 }
})));

const runtimeOptions:SetupOptions={agents:['codex'],backend:'host',projectRules:false,customer:{commands:{environment:{executable:process.execPath,args:['check.mjs'],cwd:'.',envRefs:['RUNTIME_VALUE']}}}};
async function ignoredRuntime(root:string){
 await mkdir(join(root,'.rigup'));
 await writeFile(join(root,'.rigup/.gitignore'),'/.env\n/.env.rigup-*.tmp\n');
}

test('private local values round trip quotes and newlines while comments and undeclared bytes survive',()=>project(async root=>{
 await ignoredRuntime(root);
 const before=process.env.RUNTIME_VALUE;
 const value='quotes " and \' and `; $HOME $(touch nope)\\literal\nsecond # line';
 process.env.RUNTIME_VALUE=value;
 try{
  assert.equal((await applyRuntimeInputs(root,runtimeOptions)).template.state,'written');
  assert.equal((await runtimeEnvironment(root,runtimeOptions,'customer:environment')).RUNTIME_VALUE,value);
  await appendFile(join(root,'.rigup/.env'),'# keep my note\nUNDECLARED="secret never forwarded"\n');
  const original=await readFile(join(root,'.rigup/.env'),'utf8');
  process.env.RUNTIME_VALUE='replacement';
  assert.equal((await applyRuntimeInputs(root,runtimeOptions)).template.needsUpdate,false);
  assert.equal(await readFile(join(root,'.rigup/.env'),'utf8'),original);
  const env=await runtimeEnvironment(root,runtimeOptions,'customer:environment');
  assert.equal(env.RUNTIME_VALUE,value);assert.equal(env.UNDECLARED,undefined);
 }finally{if(before===undefined)delete process.env.RUNTIME_VALUE;else process.env.RUNTIME_VALUE=before;}
}));

test('unsafe private runtime files stay byte-identical and leave unrelated setup pending',()=>project(async root=>{
 await ignoredRuntime(root);
 const path=join(root,'.rigup/.env');
 for(const content of ['RUNTIME_VALUE="synthetic-duplicate"\nRUNTIME_VALUE=other\n','RUNTIME_VALUE="synthetic-unclosed\n','RUNTIME_VALUE=ok\ninvalid secret text\n']){
  await writeFile(path,content,{mode:0o600});
  const summary=await applyRuntimeInputs(root,runtimeOptions);
  assert.equal(summary.template.state,'pending');
  assert.doesNotMatch(JSON.stringify(summary),/synthetic-|secret text/);
  assert.equal(await readFile(path,'utf8'),content);
  await assert.rejects(runtimeEnvironment(root,runtimeOptions,'customer:environment'),/Invalid.*syntax/);
 }
}));

for(const kind of ['tracked','symlink','hardlink','broad','negated'] as const){
test(`${kind} runtime inputs are not read or overwritten`,t=>project(async parent=>project(async root=>{
  await ignoredRuntime(root);git(root,'init');
  const path=join(root,'.rigup/.env'),secret='RUNTIME_VALUE="synthetic-unsafe-input"\n';
  if(kind==='symlink'){
   await writeFile(join(parent,'outside'),secret,{mode:0o600});
   try{await symlink(join(parent,'outside'),path);}
   catch(error){if(process.platform==='win32'&&(error as NodeJS.ErrnoException).code==='EPERM'){t.skip('Windows file symlink privilege is unavailable');return;}throw error;}
  }else{
   await writeFile(path,secret,{mode:0o600});
   if(kind==='hardlink')await link(path,join(root,'linked'));
   if(kind==='broad'){
    if(process.platform==='win32')execFileSync(join(process.env.SystemRoot??'C:\\Windows','System32','icacls.exe'),[path,'/grant','*S-1-1-0:(R)']);
    else await chmod(path,0o644);
   }
   if(kind==='tracked')git(root,'add','-f','.rigup/.env');
   if(kind==='negated')await appendFile(join(root,'.rigup/.gitignore'),'!/.env\n');
  }
  const summary=await applyRuntimeInputs(root,runtimeOptions);
  assert.equal(summary.template.state,'pending',kind);
  assert.doesNotMatch(JSON.stringify(summary),/synthetic-/);
  assert.equal(await readFile(path,'utf8'),secret);
})));
}

test('a declared GitLab tracker does not infer a known GitHub remote',()=>project(async root=>{
 git(root,'init');git(root,'remote','add','origin','https://github.com/example/project.git');
 const options:SetupOptions={...runtimeOptions,projectConventions:{tracker:{system:'gitlab'}},customer:{commands:{mr:{executable:'glab',args:['mr','view'],cwd:'.',envRefs:[]}}}};
 const summary=await runtimeSetupSummary(root,options);
 assert.equal(summary.inputs.find(input=>input.name==='RIGUP_TRACKER_URL')?.state,'missing');
}));

test('a configured remote action leaves ambiguous Git project targets pending',()=>project(async root=>project(async state=>{
 git(root,'init');
 git(root,'remote','add','origin','https://git.company.test/groups/team/app.git');
 git(root,'remote','add','mirror','https://git.company.test/groups/team/mirror.git');
 await mkdir(join(root,'.rigup'));
 await writeFile(join(root,'.rigup/config.yaml'),JSON.stringify({
  agents:['codex'],backend:'host',projectRules:false,projectConventions:{tracker:{system:'gitlab'}},
  customSkills:[{source:'custom',position:'deliver'}],
  customer:{commands:{mr:{executable:'glab',args:['mr','view'],cwd:'.',envRefs:[]}}},
 }));
 await mkdir(join(root,'custom'));
 await writeFile(join(root,'custom/SKILL.md'),'---\nname: customer-remote\ndescription: Use the configured remote workflow.\n---\nUse the configured remote workflow.\n');
 const run=async(args:string[],expected:number)=>{
  let output='';
  const code=await runCli([...args,'--json'],{cwd:root,isTTY:false,write:text=>output+=text,services:{cacheRoot:join(state,'cache'),stateRoot:join(state,'state')}});
  assert.equal(code,expected,output);
  return JSON.parse(output);
 };
 const first=await run(['init'],0);
 const target=(result:typeof first)=>result.runtimeSetup.inputs.find((input:{name:string})=>input.name==='RIGUP_TRACKER_URL');
 assert.equal(target(first).state,'missing');
 git(root,'remote','remove','mirror');
 const second=await run(['update'],0);
 assert.equal(target(second).source,'repository-remote');
 assert.equal(parseEnv(await readFile(join(root,'.rigup/.env'),'utf8')).RIGUP_TRACKER_URL,'https://git.company.test/groups/team/app');
})));
