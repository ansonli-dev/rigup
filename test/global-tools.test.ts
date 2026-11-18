import {scanRepository} from '../src/analyzer/repository.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,access,unlink} from 'node:fs/promises';
import {join,delimiter,dirname} from 'node:path';
import {npmRegistry} from './npm-registry-fixture.js';
import {project,testEnvironment} from './helpers.js';
import {executeLifecycle,type LifecycleFlags} from '../src/lifecycle.js';
import {apply} from '../src/installer/apply.js';

const globalBin=(prefix:string)=>process.platform==='win32'?prefix:join(prefix,'bin');
const globalLauncher=(prefix:string,id:string)=>join(globalBin(prefix),id+(process.platform==='win32'?'.cmd':''));

test('approved global tool uses exact registry version after retag and leaves project receipts empty',t=>globalFixture(t,async({root,prefix,stateRoot,cacheRoot,registry})=>{
 let previewId='',operations:unknown[]=[];
 const code=await executeLifecycle(root,{agents:['claude'],backend:'host',sdd:undefined,tools:[{id:'openwiki',install:false,initialize:false,agents:['claude']}]},{dryRun:true,globalTools:['openwiki']} as LifecycleFlags,()=>{},{stateRoot,cacheRoot,report:r=>{if(r.previewId)previewId=String(r.previewId);if(r.operations)operations=r.operations as unknown[];}});
 assert.equal(code,0);assert.equal(operations.length,1,'missing global install plan');
 await assert.rejects(access(globalLauncher(prefix,'openwiki')),{code:'ENOENT'});
 await registry.publish('openwiki','0.10.0',{bin:{openwiki:'cli.js'}},{'cli.js':'#!/usr/bin/env node\nconsole.log("0.10.0");\n'});registry.tag('openwiki','latest','0.10.0');
 const result=await apply(previewId,{stateRoot,cacheRoot:join(cacheRoot,'previews')});
 assert.equal(result.status,'complete',JSON.stringify(result));
 assert.equal(JSON.parse(await readFile(join(prefix,process.platform==='win32'?'node_modules/openwiki/package.json':'lib/node_modules/openwiki/package.json'),'utf8')).version,'0.9.0');
 assert.deepEqual(JSON.parse(await readFile(join(root,'.rigup/manifest.json'),'utf8')).installedTools,{});
}));

import {planGlobalNpmInstall,globalNpmInstallOperation,runGlobalNpmInstall} from '../src/integrations/tools/global-npm.js';
import {preview} from '../src/installer/preview.js';
import {signature} from '../src/generator/cache.js';
import {saveDurable} from '../src/private-record.js';
import {processIdentity} from '../src/installer/lock.js';
import {loadContinuation} from '../src/lifecycle.js';
import type {SetupPlan} from '../src/types.js';

async function globalFixture(t:Parameters<typeof testEnvironment>[0],run:(fixture:{root:string;prefix:string;stateRoot:string;cacheRoot:string;registry:Parameters<Parameters<typeof npmRegistry>[0]>[0]})=>Promise<void>){
 await project(control=>npmRegistry(async registry=>{
  const root=join(control,'project'),prefix=join(control,'prefix'),stateRoot=join(control,'state'),cacheRoot=join(control,'cache');
  await mkdir(root);await mkdir(stateRoot,{mode:0o700});await mkdir(globalBin(prefix),{recursive:true});
  await registry.publish('openwiki','0.9.0',{bin:{openwiki:'cli.js'}},{'cli.js':'#!/usr/bin/env node\nconsole.log("0.9.0");\n'});
  await registry.publish('@colbymchenry/codegraph','1.6.2',{bin:{codegraph:'cli.js'}},{'cli.js':'#!/usr/bin/env node\nconsole.log("1.6.2");\n'});
  let runtimeBin=dirname(process.execPath);
  if(process.platform!=='win32'){
   runtimeBin=join(control,'runtime');await mkdir(runtimeBin);
   await symlink(process.execPath,join(runtimeBin,'node'));
   await symlink(await realpath(join(dirname(process.execPath),'npm')),join(runtimeBin,'npm'));
  }
  testEnvironment(t,{npm_config_prefix:prefix,npm_config_cache:join(control,'npm-cache'),RIGUP_CONSUMER_PATH:[globalBin(prefix),runtimeBin].join(delimiter),RIGUP_NPM_REGISTRY:registry.url});
  await run({root,prefix,stateRoot,cacheRoot,registry});
 }));
}
async function emptyPlan(root:string,operations:SetupPlan['operations']):Promise<SetupPlan>{return {root,fingerprint:(await scanRepository(root,{agents:[],backend:'host'})).fingerprint,options:{agents:[],backend:'host'},operations,assets:[],dispositions:[],warnings:[],requirements:[],versions:{}};}

test('a second global failure retains the first receipt and requires the original apply approval',t=>globalFixture(t,async({root,stateRoot,cacheRoot,registry})=>{
 const first=await planGlobalNpmInstall(root,'openwiki',{stateRoot});
 const second=await planGlobalNpmInstall(root,'codegraph',{stateRoot});
 const prepared=await preview(await emptyPlan(root,[globalNpmInstallOperation(first),globalNpmInstallOperation(second)]),[],{cacheRoot,stateRoot});
 await registry.publish('@colbymchenry/codegraph','1.6.2',{bin:{codegraph:'cli.js'}},{'cli.js':'#!/usr/bin/env node\nconsole.log("replaced");\n'});
 const result=await apply(prepared.previewId,{stateRoot,cacheRoot});
 assert.equal(result.status,'failed');assert.equal(result.operations[0].status,'done');assert.equal(result.operations[1].status,'failed');
 assert.equal(result.operations[0].globalReceipt?.version,'0.9.0');
 let next='';
 assert.equal(await executeLifecycle(root,{agents:['claude'],backend:'host'},{dryRun:true},()=>{},{stateRoot,cacheRoot,report:r=>{if(r.nextCommand)next=String(r.nextCommand);}}),3);
 assert.match(next,/--resume --review/,'interrupted global installation must retain original approval');
}));

test('before-manifest failure reports completed global installation and resumes without npm',t=>globalFixture(t,async({root,stateRoot,cacheRoot,registry})=>{
 const approval=await planGlobalNpmInstall(root,'openwiki',{stateRoot});
 const prepared=await preview(await emptyPlan(root,[globalNpmInstallOperation(approval)]),[],{cacheRoot,stateRoot});
 const failed=await apply(prepared.previewId,{stateRoot,cacheRoot,hook:async point=>{if(point==='before-manifest')throw Error('fixture fault');}});
 assert.equal(failed.status,'failed');assert.equal(failed.operations[0].status,'done');assert.match(failed.nextCommand??'',/--resume/);
 const count=registry.requests.length;
 assert.equal((await apply(prepared.previewId,{stateRoot,cacheRoot,recover:true})).status,'complete');
 assert.equal(registry.requests.length,count);
}));

test('a reused PID cannot block a completed global writer receipt',t=>globalFixture(t,async({root,prefix,stateRoot,registry})=>{
 const operation=globalNpmInstallOperation(await planGlobalNpmInstall(root,'openwiki',{stateRoot}));
 const inputs={stateRoot,authorizationRef:'original'};
 assert.equal((await runGlobalNpmInstall(operation,inputs)).status,'done');
 const path=join(stateRoot,'global-npm-'+signature({prefix})+'.operations.json');
 const record=JSON.parse(await readFile(path,'utf8'));
 record.records[0].identity={pid:process.pid};
 await saveDurable(path,JSON.stringify(record));
 const requests=registry.requests.length;
 assert.equal((await runGlobalNpmInstall(operation,{...inputs,recover:true})).status,'done');
 assert.equal(registry.requests.length,requests);
 assert.equal(JSON.parse(await readFile(path,'utf8')).records[0].identity,undefined);
}));

test('global resume reuses the verified archive after an interruption before installation',t=>globalFixture(t,async({root,prefix,stateRoot,registry})=>{
 const approval=await planGlobalNpmInstall(root,'openwiki',{stateRoot});
 const operation=globalNpmInstallOperation(approval);
 const inputs={stateRoot,authorizationRef:'original'};
 await assert.rejects(runGlobalNpmInstall(operation,{...inputs,beforeInstall:async()=>{throw Error('interrupted after pack');}}),/interrupted after pack/);
 const stage=(await readdir(stateRoot)).find(name=>/^global-npm-[a-f0-9-]{36}$/.test(name));
 assert.ok(stage,'verified archive should remain in the owned stage');
 assert.ok((await readdir(join(stateRoot,stage))).includes('openwiki-0.9.0.tgz'));
 await assert.rejects(access(globalLauncher(prefix,'openwiki')),{code:'ENOENT'});
 const requests=registry.requests.length;
 registry.responseStatus=503;
 assert.equal((await runGlobalNpmInstall(operation,{...inputs,recover:true})).status,'done');
 assert.equal(registry.requests.length,requests);
 await assert.rejects(access(join(stateRoot,stage)),{code:'ENOENT'});
}));

for(const change of ['registry','prefix','npm','tarball'] as const)test('global apply rejects changed '+change+' before prefix writes',t=>globalFixture(t,async({root,prefix,stateRoot,registry})=>{
 const approval=await planGlobalNpmInstall(root,'openwiki',{stateRoot});
 if(change==='registry')process.env.RIGUP_NPM_REGISTRY='http://127.0.0.1:9/team/';
 if(change==='prefix')approval.prefixIdentity='changed';
 if(change==='npm')approval.npmIdentity='changed';
 if(change==='tarball')await registry.publish('openwiki','0.9.0',{bin:{openwiki:'cli.js'}},{'cli.js':'#!/usr/bin/env node\nconsole.log("replaced");\n'});
 await assert.rejects(runGlobalNpmInstall(globalNpmInstallOperation(approval),{stateRoot,authorizationRef:'approved'}),/changed|integrity/i);
 await assert.rejects(access(globalLauncher(prefix,'openwiki')),{code:'ENOENT'});
}));

test('another project cannot start a different global package while the prefix writer lives',t=>globalFixture(t,async({root,prefix,stateRoot})=>{
 const first=await planGlobalNpmInstall(root,'openwiki',{stateRoot});
 const other=join(root,'..','second');await mkdir(other);
 const second=await planGlobalNpmInstall(other,'codegraph',{stateRoot});
 const path=join(stateRoot,'global-npm-'+signature({prefix})+'.operations.json');
 await saveDurable(path,JSON.stringify({records:[{approval:first,authorizationRef:'first',stage:'dispatching',identity:await processIdentity(process.pid)}]}));
 await assert.rejects(runGlobalNpmInstall(globalNpmInstallOperation(second),{stateRoot,authorizationRef:'second'}),/writing process still active/);
 await assert.rejects(access(globalLauncher(prefix,'codegraph')),{code:'ENOENT'});
}));

import {runCli} from '../src/cli.js';
import {writeFile,readdir,symlink,realpath} from 'node:fs/promises';
for(const scope of ['project','global'] as const)test('missing tools offer '+scope+' scope and saving or cancelling writes no software',t=>globalFixture(t,async({root,prefix,stateRoot,cacheRoot})=>{
 const questions:string[]=[];
 let output='';
 const result=await runCli(['init','--agents','claude','--sdd','none','--tools','openwiki,codegraph'],{cwd:root,isTTY:true,write:text=>output+=text,ask:async question=>{
  questions.push(question.message);
  if(question.message.includes('安装范围'))return [scope];
  return ['Save preview, apply later'];
 },services:{stateRoot,cacheRoot,confirmPreview:async()=> 'save'}});
 assert.equal(result,3,output);assert.equal(questions.filter(question=>question.includes('安装范围')).length,2);
 for(const id of ['openwiki','codegraph']){
  const question=questions.find(message=>message.startsWith(id+' 安装范围'))??'';
  assert.ok(question.includes('.rigup/tools/'+id)&&question.includes(prefix),question);
 }
 await assert.rejects(access(globalLauncher(prefix,'openwiki')),{code:'ENOENT'});
 await assert.rejects(access(join(root,'.rigup/manifest.json')),{code:'ENOENT'});
 const files=await readdir(join(cacheRoot,'previews'));
 const saved=JSON.parse(await readFile(join(cacheRoot,'previews',files[0]),'utf8')).data;
 assert.deepEqual(saved.plan.operations.map((operation:{id:string})=>operation.id),scope==='global'?['install-global:openwiki','install-global:codegraph']:['install:openwiki','install:codegraph','initialize:codegraph']);
 const approved=saved.plan.operations[0];
 const details=output.match(/^Details: (.+)$/m)?.[1];
 assert.ok(details,output);
 const identity='registry '+approved.registry+' scope '+(scope==='global'?prefix:'.rigup/tools/openwiki')+' integrity '+approved.query.integrity;
 assert.ok(output.includes(identity),output);
 assert.ok((await readFile(details,'utf8')).includes(identity));
}));

test('host continuation retains global consent, hands off, then second project reuses PATH',t=>globalFixture(t,async({root,prefix,stateRoot,cacheRoot})=>{
 const options={agents:['claude' as const],backend:'host' as const,projectRules:true,tools:[{id:'openwiki' as const,install:false,initialize:false,agents:['claude' as const]}]};
 let output='';const services={stateRoot,cacheRoot,confirmPreview:async()=> 'save' as const};
 assert.equal(await executeLifecycle(root,options,{globalTools:['openwiki']},text=>output+=text,services),3);
 const first=output.match(/--continue ([a-f0-9]{64})/)?.[1];assert.ok(first,output);
 const continuation=await loadContinuation(root,first,services);assert.deepEqual(continuation.flags.globalTools,['openwiki']);
 let other='';assert.equal(await executeLifecycle(root,options,{},text=>other+=text,services),3);
 assert.notEqual(other.match(/--continue ([a-f0-9]{64})/)?.[1],first,'PATH-only consent must not authorize global writes');
 testEnvironment(t,{CLAUDECODE:'1'});
 const previousCwd=process.cwd();process.chdir(root);t.after(()=>process.chdir(previousCwd));
 let previewId='';
 for(let round=0;round<6;round++){
  const path=output.match(/Pending host (?:research|generation): (.+)\n/)?.[1];assert.ok(path,output);
  const request=JSON.parse(await readFile(path,'utf8')),phase=request.context.expectedOutput??'analyze';
  const data=phase==='plan'?{observations:[],unknowns:[],guidance:[],artifacts:[],dispositions:[]}:{observations:[],unknowns:[],guidance:[]};
  const response=path.replace(/(?:\.request)?\.json$/,'.response.json');
  await writeFile(response,JSON.stringify({requestId:request.requestId,requestDigest:request.requestDigest,model:'global-host-fixture',data}),{mode:0o600});
  output='';
  const code=await executeLifecycle(root,continuation.options,{...continuation.flags,response},text=>output+=text,{...services,report:report=>{if(report.previewId)previewId=String(report.previewId);}});
  assert.equal(code,3,output);if(previewId)break;
 }
 assert.ok(previewId,output);assert.match(output,/Saved preview/);
 await assert.rejects(access(globalLauncher(prefix,'openwiki')),{code:'ENOENT'});
 delete process.env.CLAUDECODE;process.chdir(previousCwd);
 assert.equal((await apply(previewId,{stateRoot,cacheRoot:join(cacheRoot,'previews')})).status,'complete');
 const otherRoot=join(root,'..','other-project');await mkdir(otherRoot);
 let json='';
 assert.equal(await runCli(['init','--agents','claude','--sdd','none','--tools','openwiki','--dry-run','--json'],{cwd:otherRoot,isTTY:false,write:text=>json+=text,services}),0,json);
 assert.deepEqual(JSON.parse(json).operations,[]);
}));

test('a dead PID from a legacy prefix lock can be recovered',t=>globalFixture(t,async({root,prefix,stateRoot})=>{
 const approval=await planGlobalNpmInstall(root,'openwiki',{stateRoot});
 await saveDurable(join(stateRoot,signature({resource:'openspec:'+prefix})+'.lock'),JSON.stringify({root,id:'legacy',identity:{pid:2147483647,started:'old'}}));
 const result=await runGlobalNpmInstall(globalNpmInstallOperation(approval),{stateRoot,authorizationRef:'approved',recover:true});
 assert.equal(result.status,'done',result.message);
 await access(globalLauncher(prefix,'openwiki'));
}));

import {queryGlobalNpmInstall} from '../src/integrations/tools/global-npm.js';

test('a completed global receipt cannot change version or integrity independently of its approval',t=>globalFixture(t,async({root,prefix,stateRoot})=>{
 const approval=await planGlobalNpmInstall(root,'openwiki',{stateRoot});
 assert.equal((await runGlobalNpmInstall(globalNpmInstallOperation(approval),{stateRoot,authorizationRef:'approved'})).status,'done');
 const path=join(stateRoot,'global-npm-'+signature({prefix,name:'openwiki'})+'.json');
 const receipt=JSON.parse(await readFile(path,'utf8'));receipt.version='9.9.9';await saveDurable(path,JSON.stringify(receipt));
 assert.equal((await queryGlobalNpmInstall(approval,stateRoot)).status,'unknown');
}));

for(const target of ['empty','partial'] as const)test('interrupted global '+target+' target requires provable recovery', {skip:process.platform==='win32'},t=>globalFixture(t,async({root,prefix,stateRoot})=>{
 const approval=await planGlobalNpmInstall(root,'openwiki',{stateRoot});
 await saveDurable(join(stateRoot,'global-npm-'+signature({prefix})+'.operations.json'),JSON.stringify({records:[{approval,authorizationRef:'original',stage:'dispatching',identity:{pid:2147483647,started:'exited'}}]}));
 if(target==='partial'){
  await writeFile(globalLauncher(prefix,'openwiki'),'incomplete launcher',{mode:0o755});
  await assert.rejects(runGlobalNpmInstall(globalNpmInstallOperation(approval),{stateRoot,authorizationRef:'original',recover:true}),/original approval|reconcile/);
  assert.equal(await readFile(globalLauncher(prefix,'openwiki'),'utf8'),'incomplete launcher');
 }else assert.equal((await runGlobalNpmInstall(globalNpmInstallOperation(approval),{stateRoot,authorizationRef:'original',recover:true})).status,'done');
}));

test('reconfiguring missing saved PATH tool can select project software while retaining initialization preference',t=>globalFixture(t,async({root,stateRoot,cacheRoot})=>{
 await mkdir(join(root,'.rigup'));
 await writeFile(join(root,'.rigup/config.yaml'),'agents: [claude]\nbackend: host\nprojectRules: false\ntools:\n - id: openwiki\n   install: false\n   initialize: true\n   agents: [claude]\n');
 let output='';
 assert.equal(await runCli(['update','--configure','--tools','openwiki','--dry-run'],{cwd:root,isTTY:true,write:text=>output+=text,ask:async question=>question.message.includes('安装范围')?['project']:question.defaults??[],services:{stateRoot,cacheRoot}}),0,output);
 const [file]=await readdir(join(cacheRoot,'previews'));
 const saved=JSON.parse(await readFile(join(cacheRoot,'previews',file),'utf8')).data;
 assert.equal(saved.plan.operations[0]?.id,'install:openwiki');
 assert.equal(saved.plan.options.tools[0].initialize,true);
}));

import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
test('killing the controller leaves its npm process group blocking a second project', {skip:process.platform==='win32'},t=>globalFixture(t,async({root,prefix,stateRoot,registry})=>{
 const first=await planGlobalNpmInstall(root,'openwiki',{stateRoot});
 const other=join(root,'..','second');await mkdir(other);const second=await planGlobalNpmInstall(other,'codegraph',{stateRoot});
 let release!:()=>void;registry.tarballGate=new Promise<void>(done=>{release=done;});
 let requested!:()=>void;const downloading=new Promise<void>(done=>{requested=done;});registry.onTarball=requested;
 const module=pathToFileURL(resolve('src/integrations/tools/global-npm.ts')).href;
 const source='import {globalNpmInstallOperation,runGlobalNpmInstall} from '+JSON.stringify(module)+'; await runGlobalNpmInstall(globalNpmInstallOperation('+JSON.stringify(first)+'),'+JSON.stringify({stateRoot,authorizationRef:'first'})+');';
 const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',source],{cwd:process.cwd(),env:process.env,stdio:['ignore','ignore','pipe']});
 let error='';child.stderr.on('data',data=>error+=data);
 const exited=new Promise<void>(done=>child.once('exit',()=>done()));
 let timer:ReturnType<typeof setTimeout>|undefined;
 let identity:{pid:number}|undefined;
 try{
  await Promise.race([downloading,exited.then(()=>{throw Error('Controller exited early: '+error);}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Controller timeout: '+error)),15000);})]);
  const journal=JSON.parse(await readFile(join(stateRoot,'global-npm-'+signature({prefix})+'.operations.json'),'utf8'));
  identity=journal.records[0].identity;assert.ok(identity);
  child.kill('SIGKILL');await exited;
  assert.doesNotThrow(()=>process.kill(-identity!.pid,0));
  await assert.rejects(runGlobalNpmInstall(globalNpmInstallOperation(second),{stateRoot,authorizationRef:'second',recover:true}),/writing process still active|process group exit/);
  await assert.rejects(access(globalLauncher(prefix,'codegraph')),{code:'ENOENT'});
 }finally{
  if(timer)clearTimeout(timer);child.kill('SIGKILL');await exited;
  if(identity)try{process.kill(-identity.pid,'SIGKILL');}catch{}
  release();
 }
}));

test('a detached npm success can publish a global receipt after the controller is killed', {skip:process.platform==='win32'},t=>globalFixture(t,async({root,prefix,stateRoot,registry})=>{
 await registry.publish('rigup-fixture-dependency','1.0.0',{}, {'index.js':'module.exports = 42;\n'});
 await registry.publish('openwiki','0.9.0',{bin:{openwiki:'cli.js'},dependencies:{'rigup-fixture-dependency':'1.0.0'}},
  {'cli.js':'#!/usr/bin/env node\nconsole.log(require("rigup-fixture-dependency"));\n'});
 const approval=await planGlobalNpmInstall(root,'openwiki',{stateRoot});
 const inputs={stateRoot,authorizationRef:'original'};
 const module=pathToFileURL(resolve('src/integrations/tools/global-npm.ts')).href;
 const source='import {globalNpmInstallOperation,runGlobalNpmInstall} from '+JSON.stringify(module)+
  '; await runGlobalNpmInstall(globalNpmInstallOperation('+JSON.stringify(approval)+'),'+JSON.stringify(inputs)+');';
 let release!:()=>void,requested!:()=>void;
 const gate=new Promise<void>(done=>{release=done;});
 const installing=new Promise<void>(done=>{requested=done;});
 registry.onRequest=()=>{
  if(!registry.requests.at(-1)?.path.endsWith('/rigup-fixture-dependency/-/1.0.0.tgz'))return;
  registry.tarballGate=gate;requested();
 };
 const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',source],{stdio:['ignore','ignore','pipe']});
 let error='';child.stderr.on('data',data=>error+=data);
 const exited=new Promise<void>(done=>child.once('exit',()=>done()));
 const {setTimeout:delay}=await import('node:timers/promises');
 try{
  await Promise.race([installing,exited.then(()=>{throw Error('Controller exited early: '+error);}),
   delay(20_000,undefined,{ref:false}).then(()=>{throw Error('npm did not reach its dependency: '+error);})]);
  const journal=JSON.parse(await readFile(join(stateRoot,'global-npm-'+signature({prefix})+'.operations.json'),'utf8'));
  const {identity,scratch}=journal.records[0];
  assert.ok(identity.pid);
  child.kill('SIGKILL');await exited;
  await assert.rejects(runGlobalNpmInstall(globalNpmInstallOperation(approval),{...inputs,recover:true}),/process still active/);
  release();
  const {writerAlive}=await import('../src/installer/operations.js');
  for(let attempt=0;attempt<150&&await writerAlive(identity);attempt++)await delay(100);
  assert.equal(await writerAlive(identity),false);
  const stage=join(stateRoot,'global-npm-'+scratch.token);
  assert.equal(JSON.parse(await readFile(join(stage,'installed.json'),'utf8')).code,0);
  const requests=registry.requests.length;
  registry.responseStatus=503;
  assert.equal((await runGlobalNpmInstall(globalNpmInstallOperation(approval),{...inputs,recover:true})).status,'done');
  assert.equal(registry.requests.length,requests);
  await access(globalLauncher(prefix,'openwiki'));
  await assert.rejects(access(stage),{code:'ENOENT'});
 }finally{release();child.kill('SIGKILL');await exited;}
}));

test('global CodeGraph refuses a launcher whose required platform payload was not installed',t=>globalFixture(t,async({root,stateRoot,registry})=>{
 await registry.publish('@colbymchenry/codegraph','1.6.2',{bin:{codegraph:'cli.js'},optionalDependencies:{['@colbymchenry/codegraph-'+process.platform+'-'+process.arch]:'1.6.2'}},{'cli.js':'#!/usr/bin/env node\nconsole.log("shim");\n'});
 const approval=await planGlobalNpmInstall(root,'codegraph',{stateRoot});
 await assert.rejects(runGlobalNpmInstall(globalNpmInstallOperation(approval),{stateRoot,authorizationRef:'approved'}),/platform package|CodeGraph/);
 assert.equal((await queryGlobalNpmInstall(approval,stateRoot)).status,'unknown');
}));

test('an unrelated completed package does not prove an old prefix lock writer exited',t=>globalFixture(t,async({root,prefix,stateRoot})=>{
 const first=await planGlobalNpmInstall(root,'openwiki',{stateRoot});
 assert.equal((await runGlobalNpmInstall(globalNpmInstallOperation(first),{stateRoot,authorizationRef:'first'})).status,'done');
 const second=await planGlobalNpmInstall(root,'codegraph',{stateRoot});
 await saveDurable(join(stateRoot,signature({resource:'openspec:'+prefix})+'.lock'),JSON.stringify({root,id:'unrecorded-controller',identity:{pid:process.pid,started:'old'}}));
 await assert.rejects(runGlobalNpmInstall(globalNpmInstallOperation(second),{stateRoot,authorizationRef:'second',recover:true}),/locked/i);
}));

test('cancelling the second global package reports the first and resumes both original approvals',t=>globalFixture(t,async({root,prefix,stateRoot,cacheRoot})=>{
 const operations=await Promise.all(['openwiki','codegraph'].map(async id=>globalNpmInstallOperation(await planGlobalNpmInstall(root,id as 'openwiki'|'codegraph',{stateRoot}))));
 const prepared=await preview(await emptyPlan(root,operations),[],{cacheRoot,stateRoot});
 const abort=new AbortController();
 const partial=await apply(prepared.previewId,{stateRoot,cacheRoot,signal:abort.signal,hook:async point=>{if(point==='after-operation')abort.abort();}});
 assert.equal(partial.exitCode,130);assert.equal(partial.operations[0].status,'done');assert.match(partial.nextCommand??'',/--resume/);
 await assert.rejects(access(globalLauncher(prefix,'codegraph')),{code:'ENOENT'});
 const completed=await apply(prepared.previewId,{stateRoot,cacheRoot,recover:true});
 assert.equal(completed.status,'complete');assert.deepEqual(completed.operations.map(result=>result.globalReceipt?.version),['0.9.0','1.6.2']);
 assert.deepEqual(JSON.parse(await readFile(join(root,'.rigup/manifest.json'),'utf8')).installedTools,{});
}));

test('malformed global writer evidence blocks installation before dispatch',t=>globalFixture(t,async({root,prefix,stateRoot})=>{
 const approval=await planGlobalNpmInstall(root,'openwiki',{stateRoot});
 await saveDurable(join(stateRoot,'global-npm-'+signature({prefix})+'.operations.json'),JSON.stringify({records:[{approval,authorizationRef:'invalid',stage:'dispatching'}]}));
 await assert.rejects(runGlobalNpmInstall(globalNpmInstallOperation(approval),{stateRoot,authorizationRef:'approved'}),/Global npm operations|record|evidence/);
 await assert.rejects(access(globalLauncher(prefix,'openwiki')),{code:'ENOENT'});
}));

test('global CodeGraph retains an explicit native initialization preference and subsequent PATH updates remain executable',t=>globalFixture(t,async({root,stateRoot,cacheRoot})=>{
 await mkdir(join(root,'.rigup'));
 await writeFile(join(root,'.rigup/config.yaml'),'agents: [claude]\nbackend: host\nprojectRules: false\ntools:\n - id: codegraph\n   install: false\n   initialize: true\n   agents: [claude]\n');
 let output='';
 assert.equal(await runCli(['update','--configure','--tools','codegraph','--dry-run'],{cwd:root,isTTY:true,write:text=>output+=text,ask:async question=>question.message.includes('安装范围')?['global']:question.defaults??[],services:{stateRoot,cacheRoot}}),0,output);
 const [file]=await readdir(join(cacheRoot,'previews'));
 const saved=JSON.parse(await readFile(join(cacheRoot,'previews',file),'utf8')).data;
 assert.equal(saved.plan.options.tools[0].initialize,true);
 assert.equal((await apply(saved.preview.previewId,{stateRoot,cacheRoot:join(cacheRoot,'previews')})).status,'complete');
 output='';
 assert.equal(await runCli(['update','--dry-run','--json'],{cwd:root,isTTY:false,write:text=>output+=text,services:{stateRoot,cacheRoot}}),0,output);
 assert.equal(JSON.parse(output).executable,true);
}));

import {assertGlobalOperation} from '../src/integrations/tools/global-npm.js';
test('global recipe cannot substitute another package behind a selected integration id',t=>globalFixture(t,async({root,stateRoot})=>{
 const approval=await planGlobalNpmInstall(root,'openwiki',{stateRoot});
 const substituted=globalNpmInstallOperation({...approval,name:'@colbymchenry/codegraph'});
 assert.throws(()=>assertGlobalOperation(root,substituted),/recipe|package/);
}));

for(const point of ['after-operation','before-manifest'] as const)test('global launcher removal at '+point+' prevents committing project wiring',t=>globalFixture(t,async({root,prefix,stateRoot,cacheRoot,registry})=>{
 const approval=await planGlobalNpmInstall(root,'openwiki',{stateRoot});
 const plan=await emptyPlan(root,[globalNpmInstallOperation(approval)]);
 plan.assets=[{logicalId:'test:wiring',target:'wiring.txt',content:'approved wiring\n',ownership:{kind:'file'},source:{kind:'fixed-template',ref:'fixture'}}];
 const prepared=await preview(plan,[],{cacheRoot,stateRoot});
 const failed=await apply(prepared.previewId,{stateRoot,cacheRoot,hook:async current=>{if(current===point)await unlink(globalLauncher(prefix,'openwiki'));}});
 assert.equal(failed.status,'failed');assert.equal(failed.operations[0].status,'done');assert.match(failed.nextCommand??'',/--resume/);
 await assert.rejects(access(join(root,'.rigup/manifest.json')),{code:'ENOENT'});
 if(point==='after-operation')await assert.rejects(access(join(root,'wiring.txt')),{code:'ENOENT'});
 const requests=registry.requests.length;
 const resumed=await apply(prepared.previewId,{stateRoot,cacheRoot,recover:true});
 assert.equal(resumed.status,'failed');assert.equal(resumed.operations[0].status,'done');assert.match(resumed.nextCommand??'',/--resume/);
 assert.equal(registry.requests.length,requests,'resume must not reinstall changed approved software');
}));

for(const recovery of ['committed','complete'] as const)test('global '+recovery+' replay rejects a changed launcher and keeps the original result',t=>globalFixture(t,async({root,prefix,stateRoot,cacheRoot,registry})=>{
 const approval=await planGlobalNpmInstall(root,'openwiki',{stateRoot});
 const prepared=await preview(await emptyPlan(root,[globalNpmInstallOperation(approval)]),[],{cacheRoot,stateRoot});
 const installed=await apply(prepared.previewId,{stateRoot,cacheRoot,hook:async point=>{if(recovery==='committed'&&point==='after-manifest')throw Error('controller interrupted');}});
 assert.equal(installed.status,recovery==='committed'?'failed':'complete');
 await unlink(globalLauncher(prefix,'openwiki'));
 const manifest=await readFile(join(root,'.rigup/manifest.json'),'utf8'),requests=registry.requests.length;
 const replay=await apply(prepared.previewId,{stateRoot,cacheRoot,recover:true});
 assert.equal(replay.status,'failed');assert.equal(replay.operations[0].status,'done');assert.match(replay.nextCommand??'',/--resume/);
 assert.equal(registry.requests.length,requests);assert.equal(await readFile(join(root,'.rigup/manifest.json'),'utf8'),manifest);
}));

test('global apply refuses an earlier PATH launcher without running it',t=>globalFixture(t,async({root,prefix,stateRoot,cacheRoot})=>{
 const approval=await planGlobalNpmInstall(root,'openwiki',{stateRoot});
 const prepared=await preview(await emptyPlan(root,[globalNpmInstallOperation(approval)]),[],{cacheRoot,stateRoot});
 const shadow=join(root,'..','shadow'),marker=join(root,'..','unapproved-command-ran');await mkdir(shadow);
 const failed=await apply(prepared.previewId,{stateRoot,cacheRoot,hook:async point=>{
  if(point!=='after-operation')return;
  await writeFile(join(shadow,process.platform==='win32'?'openwiki.cmd':'openwiki'),process.platform==='win32'?'@echo unexpected > '+marker:'#!/usr/bin/env node\nrequire("fs").writeFileSync('+JSON.stringify(marker)+',"unexpected");\n',{mode:0o755});
  process.env.RIGUP_CONSUMER_PATH=shadow+delimiter+process.env.RIGUP_CONSUMER_PATH;
 }});
 assert.equal(failed.status,'failed');assert.equal(failed.operations[0].status,'done');assert.match(failed.nextCommand??'',/--resume/);
 await assert.rejects(access(marker),{code:'ENOENT'});await assert.rejects(access(join(root,'.rigup/manifest.json')),{code:'ENOENT'});
 await access(globalLauncher(prefix,'openwiki'));
}));

test('configuration drift before global replay preserves the saved completion and recovery command',t=>globalFixture(t,async({root,stateRoot,cacheRoot,registry})=>{
 const approval=await planGlobalNpmInstall(root,'openwiki',{stateRoot});
 const prepared=await preview(await emptyPlan(root,[globalNpmInstallOperation(approval)]),[],{cacheRoot,stateRoot});
 const interrupted=await apply(prepared.previewId,{stateRoot,cacheRoot,hook:async point=>{if(point==='after-operation')throw Error('controller interrupted');}});
 assert.equal(interrupted.status,'failed');assert.equal(interrupted.operations[0].status,'done');
 await mkdir(join(root,'.rigup'),{recursive:true});
 await writeFile(join(root,'.rigup/config.yaml'),'projectRules: false\n');
 const requests=registry.requests.length;
 const resumed=await apply(prepared.previewId,{stateRoot,cacheRoot,recover:true});
 assert.equal(resumed.status,'failed');assert.equal(resumed.operations[0].status,'done');assert.match(resumed.nextCommand??'',/--resume/);
 assert.ok(resumed.warnings.some(warning=>/source input changed/.test(warning)));
 assert.equal(registry.requests.length,requests);await assert.rejects(access(join(root,'.rigup/manifest.json')),{code:'ENOENT'});
}));
