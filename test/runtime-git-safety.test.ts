import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import crypto from 'node:crypto';
import {constants} from 'node:fs';
import {access,mkdir,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {delimiter,join,resolve} from 'node:path';
import {test} from 'node:test';
import {applyRuntimeInputs,runtimeEnvironment} from '../src/runtime-inputs.js';
import {readRuntimeFile} from '../src/runtime-private-env.js';
import {createWindowsPrivateDirectory} from '../src/private-access.js';
import type {SetupOptions} from '../src/types.js';
import {project} from './helpers.js';

const name='RIGUP_TEST_GIT_TOKEN',secret='synthetic-git-boundary-secret';
const blank=name+'=\n# preserve these bytes\n';
const options:SetupOptions={agents:[],backend:'host',projectRules:false,customer:{commands:{environment:{executable:process.execPath,args:['check.mjs'],cwd:'.',envRefs:[name]}}}};
const git=(root:string,...args:string[])=>execFileSync('git',['-C',root,'-c','core.hooksPath=','-c','init.templateDir=',...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']});

async function environment(values:Record<string,string|undefined>,run:()=>Promise<void>){
 const before=Object.fromEntries(Object.keys(values).map(key=>[key,process.env[key]]));
 try{
  for(const [key,value] of Object.entries(values)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  await run();
 }finally{
  for(const [key,value] of Object.entries(before)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
 }
}

async function runtimeFile(root:string){
 const directory=join(root,'.rigup');
 if(process.platform==='win32')await createWindowsPrivateDirectory(directory,'private fixture required');
 else await mkdir(directory,{mode:0o700});
 await writeFile(join(directory,'.gitignore'),'/.env\n/.env.rigup-*.tmp\n');
 await writeFile(join(directory,'.env'),blank,{mode:0o600});
}

async function remainsPrivate(root:string,overrides:Record<string,string|undefined>={}){
 await environment({...overrides,[name]:secret},async()=>{
  const summary=await applyRuntimeInputs(root,options);
  assert.equal(summary.template.state,'pending');
  assert.equal(await readFile(join(root,'.rigup/.env'),'utf8'),blank);
  assert.ok(!JSON.stringify(summary).includes(secret));
  await assert.rejects(runtimeEnvironment(root,options,'customer:environment'),/unchanged/);
  assert.deepEqual((await readdir(join(root,'.rigup'))).sort(),['.env','.gitignore']);
 });
}

for(const layout of ['root','ancestor','worktree'] as const)test('unavailable Git cannot import into tracked runtime input: '+layout,()=>project(parent=>project(async control=>{
 git(parent,'init','-q');
 let root=parent;
 if(layout==='ancestor'){root=join(parent,'nested');await mkdir(root);}
 if(layout==='worktree'){
  git(parent,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','--no-gpg-sign','-qm','fixture');
  root=join(control,'linked');
  git(parent,'worktree','add','--detach',root);
  assert.match(await readFile(join(root,'.git'),'utf8'),/^gitdir:/);
 }
 await runtimeFile(root);git(root,'add','-f','.rigup/.env');
 await remainsPrivate(root,{PATH:''});
})));

test('a corrupt Git index cannot turn a tracked runtime input into an untracked file',()=>project(async root=>{
 git(root,'init','-q');await runtimeFile(root);git(root,'add','-f','.rigup/.env');
 await writeFile(join(root,'.git/index'),'corrupt-index');
 await remainsPrivate(root);
 assert.equal(await readFile(join(root,'.git/index'),'utf8'),'corrupt-index');
}));

function trackCaseAlias(root:string,path:string){
 const blob=git(root,'hash-object','-w','.rigup/.env').trim();
 git(root,'update-index','--add','--cacheinfo','100644,'+blob+','+path);
 assert.equal(git(root,'ls-files').trim(),path);
}

for(const alias of ['.rigup/.ENV','.RIGUP/.env'])test('tracked index case alias denies private runtime reads and writes: '+alias,()=>project(async root=>{
 git(root,'init','-q');await runtimeFile(root);trackCaseAlias(root,alias);
 const file=await readRuntimeFile(root);
 assert.match(file.problem??'',/unchanged/);assert.equal(file.entries.size,0);assert.equal(file.text,'');
 await remainsPrivate(root);
 assert.equal(git(root,'ls-files').trim(),alias);
}));

test('a tracked case alias blocks initial runtime creation even when its worktree file is missing',()=>project(async root=>{
 git(root,'init','-q');await runtimeFile(root);trackCaseAlias(root,'.rigup/.ENV');
 await rm(join(root,'.rigup/.env'));
 await environment({[name]:secret},async()=>{
  const summary=await applyRuntimeInputs(root,options);
  assert.equal(summary.template.state,'pending');assert.ok(!JSON.stringify(summary).includes(secret));
  await assert.rejects(access(join(root,'.rigup/.env')),{code:'ENOENT'});
  assert.deepEqual(await readdir(join(root,'.rigup')),['.gitignore']);
 });
}));

for(const alias of [false,true])test('tracked '+(alias?'case-aliased ':'')+'runtime temporary path blocks secret staging',context=>project(async root=>{
 git(root,'init','-q');await runtimeFile(root);
 const uuid='00000000-0000-4000-8000-000000000000';
 const target='.rigup/.env.rigup-'+uuid+'.tmp';
 trackCaseAlias(root,alias?target.toUpperCase():target);
 const mocked=context.mock.method(crypto,'randomUUID',()=>uuid);syncBuiltinESMExports();
 try{
  await environment({[name]:secret},async()=>{
   const summary=await applyRuntimeInputs(root,options);
   assert.equal(summary.template.state,'pending');assert.ok(!JSON.stringify(summary).includes(secret));
   assert.equal(await readFile(join(root,'.rigup/.env'),'utf8'),blank);
   assert.deepEqual((await readdir(join(root,'.rigup'))).sort(),['.env','.gitignore']);
  });
 }
 finally{mocked.mock.restore();syncBuiltinESMExports();}
}));

test('an alternate Git index cannot hide a tracked runtime input',()=>project(root=>project(async control=>{
 git(root,'init','-q');await runtimeFile(root);git(root,'add','-f','.rigup/.env');
 await remainsPrivate(root,{GIT_INDEX_FILE:join(control,'alternate-index')});
})));

test('Git directory and work-tree environment overrides cannot hide a tracked runtime input',()=>project(root=>project(async alternate=>{
 git(root,'init','-q');git(alternate,'init','-q');await runtimeFile(root);git(root,'add','-f','.rigup/.env');
 await remainsPrivate(root,{GIT_DIR:join(alternate,'.git'),GIT_WORK_TREE:root});
})));

test('Git discovery environment overrides cannot hide an ancestor repository',()=>project(async parent=>{
 git(parent,'init','-q');const root=join(parent,'nested');await mkdir(root);await runtimeFile(root);git(root,'add','-f','.rigup/.env');
 await remainsPrivate(root,{GIT_CEILING_DIRECTORIES:parent});
}));

test('an invalid ancestor Git marker leaves runtime input unchanged',()=>project(async parent=>{
 await writeFile(join(parent,'.git'),'gitdir: missing-metadata\n');
 const root=join(parent,'nested');await mkdir(root);await runtimeFile(root);
 await remainsPrivate(root);
}));

test('genuinely non-Git projects still use their local ignore when Git is unavailable',()=>project(async root=>{
 await runtimeFile(root);
 await environment({PATH:'',[name]:secret},async()=>{
  const summary=await applyRuntimeInputs(root,options);
  assert.equal(summary.template.state,'written');
  assert.equal((await runtimeEnvironment(root,options,'customer:environment'))[name],secret);
  assert.ok(!JSON.stringify(summary).includes(secret));
 });
}));

test('unavailable Git does not create a new runtime file inside a repository',()=>project(async root=>{
 git(root,'init','-q');await mkdir(join(root,'.rigup'));
 await writeFile(join(root,'.rigup/.gitignore'),'/.env\n/.env.rigup-*.tmp\n');
 await environment({PATH:'',[name]:secret},async()=>{
  assert.equal((await applyRuntimeInputs(root,options)).template.state,'pending');
  await assert.rejects(access(join(root,'.rigup/.env')),{code:'ENOENT'});
 });
}));

test('Git safety probes receive only essential environment while checking the real repository',{skip:process.platform==='win32'&&'uses a POSIX executable forwarding fixture'},()=>project(root=>project(async control=>{
 git(root,'init','-q');await runtimeFile(root);
 git(root,'remote','add','origin','https://github.com/example/project.git');
 const remoteOptions:SetupOptions={...options,projectConventions:{tracker:{system:'github'}},customer:{commands:{mr:options.customer!.commands!.environment}}};
 let executable:string|undefined;
 for(const directory of (process.env.PATH??'').split(delimiter)){
  const candidate=resolve(directory,'git');
  try{await access(candidate,constants.X_OK);executable=candidate;break;}catch{/* Try the next installed Git executable. */}
 }
 assert.ok(executable);
 const trace=join(control,'git-probe.jsonl'),extra='RIGUP_UNRELATED_PROVIDER_KEY';
 const script='#!'+process.execPath+'\n'+
  'const fs=require("node:fs"),cp=require("node:child_process");\n'+
  'fs.appendFileSync('+JSON.stringify(trace)+',JSON.stringify({present:'+JSON.stringify([name,extra])+'.filter(key=>process.env[key]!==undefined)})+"\\n");\n'+
  'const result=cp.spawnSync('+JSON.stringify(executable)+',process.argv.slice(2),{stdio:"inherit",env:process.env});process.exit(result.status??1);\n';
 await writeFile(join(control,'git'),script,{mode:0o755});
 await environment({PATH:control+delimiter+process.env.PATH,[name]:secret,[extra]:'synthetic-unrelated-key'},async()=>{
  assert.equal((await applyRuntimeInputs(root,remoteOptions)).template.state,'written');
  const calls=(await readFile(trace,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.ok(calls.length>0,'the fixture must forward actual Git probes');
  assert.ok(calls.every(call=>call.present.length===0),'Git probes must not receive declared customer or unrelated provider credentials');
 });
})));
