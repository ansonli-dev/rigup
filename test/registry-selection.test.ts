import {test} from 'node:test';
import assert from 'node:assert/strict';
import {access,mkdir,readdir,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import {delimiter,join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {project} from './helpers.js';
import {softwareInstallRecipe,assertToolOperationRecipe} from '../src/integrations/tools/recipes.js';
import {loadUpstreamLock} from '../src/integrations/upstream.js';
import {operationExecutor} from '../src/installer/operations.js';
import {stagedInstall} from '../src/installer/install-staging.js';
import {selectedNpmRegistry} from '../src/runtime-inputs.js';
import {createHash} from 'node:crypto';
import {npmRegistry} from './npm-registry-fixture.js';
import {saveNativeOperations} from './native-tool-fixture.js';
import {runCli} from '../src/cli.js';
import {testEnvironment} from './helpers.js';
import {applyRecordPath,loadManifest} from '../src/installer/baseline.js';

test('real npm keeps the original approval across retag, a same-version replacement and recovery',t=>project(root=>project(cache=>project(state=>npmRegistry(async registry=>{
 testEnvironment(t,{RIGUP_CONSUMER_PATH:'',npm_config_cache:join(state,'npm-cache')});
 const wiki=await registry.publish('openwiki','2.0.0',{bin:{openwiki:'dist/cli/cli.js'}},{'dist/cli/cli.js':'#!/usr/bin/env node\n'});
 const codegraph='@colbymchenry/codegraph',packageManifest={bin:{codegraph:'npm-shim.js'},engines:{node:'>=22.19.0'}};
 const files={'npm-shim.js':'#!/usr/bin/env node\n','index.js':`
 const {DatabaseSync}=require('node:sqlite');
 const {mkdirSync}=require('node:fs');
 const {join}=require('node:path');
 const {version}=require('./package.json');
 exports.CodeGraph=class {
  static isInitialized(){return false;}
  static init(root){
   const dir=join(root,process.env.CODEGRAPH_DIR);mkdirSync(dir);
   const db=new DatabaseSync(join(dir,'codegraph.db'));
   try{
    db.exec("CREATE TABLE project_metadata(key TEXT PRIMARY KEY,value TEXT); INSERT INTO project_metadata VALUES ('index_state','complete'); CREATE TABLE files(id TEXT); CREATE TABLE nodes(id TEXT);");
    db.prepare("INSERT INTO project_metadata VALUES ('indexed_with_version',?)").run(version);
   }finally{db.close();}
   return new this();
  }
  indexAll(){return {success:true};}
  getIndexState(){return 'complete';}
  close(){}
 };`};
 const original=await registry.publish(codegraph,'2.0.0',packageManifest,files);
 await registry.publish(codegraph,'2.1.0',packageManifest,files);
 const profile=join(state,'tools.yaml');await writeFile(profile,'projectRules: false\n');
 const prior=process.env.RIGUP_NPM_REGISTRY;process.env.RIGUP_NPM_REGISTRY=registry.url;
 const run=async(args:string[],expected:number)=>{
  let output='';const code=await runCli([...args,'--json'],{cwd:root,isTTY:false,write:text=>output+=text,services:{cacheRoot:cache,stateRoot:state}});
  assert.equal(code,expected,output);return JSON.parse(output);
 };
 const review=['init','--agents','codex','--sdd','none','--tools','openwiki,codegraph','--profile',profile,'--review'];
 try{
  const approved=await run(review,3);
  assert.equal(approved.executable,true);
  assert.equal(registry.requests.length,2);
  assert.deepEqual(approved.operations.map((operation:{version:string})=>operation.version),['2.0.0','2.0.0','2.0.0']);
  assert.equal(approved.operations[1].registry,registry.url);
  registry.tag(codegraph,'latest','2.1.0');
  const fresh=await run(review,3);
  assert.equal(fresh.operations[1].version,'2.1.0');assert.notEqual(fresh.previewId,approved.previewId);
  const replacement=await registry.publish(codegraph,'2.0.0',packageManifest,{...files,'replacement.txt':'Different tarball at the same version'});
  assert.notEqual(replacement.integrity,original.integrity);
  const applied=await run(['update','--apply',approved.previewId,'--sessions-ended'],3);
  assert.equal(applied.operations[0].status,'done');
  assert.match(applied.operations[1].message,/approved package identity/);
  assert.equal(await loadManifest(root),undefined);
  await assert.rejects(access(join(root,'.rigup/tools/codegraph')),{code:'ENOENT'});
  await assert.rejects(access(join(root,'.codex/config.toml')),{code:'ENOENT'});
  const tx=JSON.parse(await readFile(applyRecordPath(root,state),'utf8'));
  assert.equal(tx.receipts.openwiki.packageIntegrity,wiki.integrity);
  assert.equal((await run(['update','--review'],3)).interruptedPreviewId,approved.previewId);
  Object.assign(replacement,original);
  await rm(join(cache,'previews'),{recursive:true});
  assert.equal((await run(['update','--resume','--review'],3)).previewId,approved.previewId);
  await run(['update','--apply',approved.previewId,'--resume','--sessions-ended'],0);
  const manifest=await loadManifest(root);
  assert.equal(manifest?.installedTools?.codegraph.packageIntegrity,original.integrity);
  assert.equal(manifest?.initializedTools?.codegraph.version,'2.0.0');
  assert.equal(registry.requests.filter(request=>request.path.includes('/openwiki/-/')).length,1);
  assert.ok(registry.requests.some(request=>request.path.endsWith('/codegraph/-/2.0.0.tgz')));
  assert.ok(!registry.requests.some(request=>request.path.endsWith('/codegraph/-/2.1.0.tgz')));
  registry.responseStatus=503;
  const count=registry.requests.length;
  const update=await run(['update','--review'],0);assert.equal(update.installStatus,'up-to-date');
  const report=await run(['doctor'],3);
  assert.match(report.diagnostics.find((item:{id:string})=>item.id==='codegraph:binary').reason,/Installed 2\.0\.0/);
  assert.equal(registry.requests.length,count);
 }finally{if(prior===undefined)delete process.env.RIGUP_NPM_REGISTRY;else process.env.RIGUP_NPM_REGISTRY=prior;}
})))));

test('one approved CLI plan uses effective scoped npmrc, freezes its routes, and keeps auth private',t=>project(root=>project(cache=>project(state=>npmRegistry(wiki=>npmRegistry(async graph=>{
 const name='@colbymchenry/codegraph',token='synthetic-npmrc-registry-token';
 const openwiki=await wiki.publish('openwiki','2.0.0',{bin:{openwiki:'dist/cli/cli.js'}},{'dist/cli/cli.js':'#!/usr/bin/env node\n'});
 await wiki.publish('rigup-scoped-fixture-dependency','1.0.0');
 const codegraph=await graph.publish(name,'2.1.0',{bin:{codegraph:'npm-shim.js'},dependencies:{'rigup-scoped-fixture-dependency':'1.0.0'}},{'npm-shim.js':'#!/usr/bin/env node\n'});
 await graph.publish('openwiki','2.2.0',{bin:{openwiki:'dist/cli/cli.js'}},{'dist/cli/cli.js':'#!/usr/bin/env node\n'});
 const config=join(state,'user.npmrc');
 const npmrc='registry='+wiki.url+'\n@colbymchenry:registry='+graph.url+'\n//'+new URL(graph.url).host+'/:_authToken=\${RIGUP_NPM_FIXTURE_TOKEN}\n';
 await writeFile(config,npmrc);
 testEnvironment(t,{
  NPM_CONFIG_USERCONFIG:config,npm_config_userconfig:config,NPM_CONFIG_CACHE:join(state,'npm-cache'),npm_config_cache:join(state,'npm-cache'),
  RIGUP_CONSUMER_PATH:'',RIGUP_NPM_REGISTRY:'',RIGUP_NPM_FIXTURE_TOKEN:token,
 });
 await mkdir(join(root,'.rigup'));
 await writeFile(join(root,'.rigup/config.yaml'),JSON.stringify({
  agents:['codex'],backend:'host',projectRules:false,
  tools:['openwiki','codegraph'].map(id=>({id,agents:['codex'],install:true,initialize:false})),
 }));
 const {resolveProjectNpm,boundedCommandOutput}=await import('../src/integrations/tools/npm-resolution.js');
 const run=async(args:string[],expected:number)=>{
  let output='',diagnostic='';
  const code=await runCli([...args,'--json'],{cwd:root,isTTY:false,write:text=>output+=text,writeError:text=>diagnostic+=text,
   services:{cacheRoot:cache,stateRoot:state,npmView:async (argv,cwd,signal)=>{
    const route=argv.find(arg=>arg.startsWith('--@colbymchenry:registry='))?.split('=')[1]??argv[argv.indexOf('--registry')+1];
    if(![wiki.url,graph.url].includes(route))throw Error('fixture accepts local registries only');
    return boundedCommandOutput(await resolveProjectNpm(root,argv),cwd,signal);
   }}});
  assert.equal(code,expected,output+diagnostic);
  assert.ok(!(output+diagnostic).includes(token));
  return JSON.parse(output);
 };
 const approved=await run(['init','--review'],3);
 assert.equal(approved.executable,true,JSON.stringify(approved));
 assert.deepEqual(approved.operations.map((op:{registry:string;version:string})=>[op.registry,op.version]),[[wiki.url,'2.0.0'],[graph.url,'2.1.0']]);
 process.env.RIGUP_NPM_REGISTRY=graph.url;
 const override=await run(['init','--review'],3);
 assert.deepEqual(override.operations.map((op:{registry:string})=>op.registry),[graph.url,graph.url]);
 process.env.RIGUP_NPM_REGISTRY='';
 await writeFile(config,npmrc.replace('@colbymchenry:registry='+graph.url,'@colbymchenry:registry='+wiki.url));
 const changed=await run(['update','--apply',approved.previewId],1);
 assert.match(changed.error,/registry.*changed/i);
 await writeFile(config,npmrc);
 const installed=await run(['update','--apply',approved.previewId],0);
 assert.equal(installed.installStatus,'complete');
 const manifest=await loadManifest(root);
 assert.equal(manifest?.installedTools?.openwiki.packageIntegrity,openwiki.integrity);
 assert.equal(manifest?.installedTools?.codegraph.packageIntegrity,codegraph.integrity);
 assert.ok(graph.requests.some(request=>request.authorization==='Bearer '+token));
 assert.ok(wiki.requests.every(request=>!request.authorization));
 assert.ok(wiki.requests.some(request=>request.path.includes('/rigup-scoped-fixture-dependency/-/')));
 assert.ok(graph.requests.every(request=>!request.path.includes('rigup-scoped-fixture-dependency')));
 assert.ok(!JSON.stringify(manifest).includes(token));
 const lock=JSON.parse(await readFile(join(root,'.rigup/tools/codegraph/package-lock.json'),'utf8'));
 assert.equal(lock.packages[''].dependencies[name],'2.1.0');
 const requests=[wiki.requests.length,graph.requests.length];
 await run(['update','--apply',approved.previewId],0);
 assert.deepEqual([wiki.requests.length,graph.requests.length],requests);
}))))));

test('npm SRI normalization validates whole fields, accepts options and rejects malformed digests',async()=>{
 const {normalizeNpmIntegrity}=await import('../src/npm-integrity.mjs');
 const sri=(algorithm:string)=>algorithm+'-'+createHash(algorithm).update('fixture').digest('base64');
 const strongest=sri('sha512'),middle=sri('sha384'),weakest=sri('sha256');
 assert.equal(normalizeNpmIntegrity(`${weakest} ${strongest}?example ${middle} ${weakest}`),`${strongest} ${middle} ${weakest}`);
 for(const value of [undefined,'','sha512-'+weakest.slice(7),strongest+'=','sha384-Zm9v',strongest+' invalid-token'])assert.equal(normalizeNpmIntegrity(value),undefined);
});

test('a real npm view selects only the latest tag through a scoped internal registry',()=>project(root=>project(state=>npmRegistry(async registry=>{
 const {resolveNpmLatest}=await import('../src/integrations/tools/npm-resolution.js');
 const name='@colbymchenry/codegraph';
 for(const version of ['1.0.0','2.1.0','3.0.0-rc.1'])await registry.publish(name,version);
 const latest=await registry.publish(name,'2.0.0',{engines:{node:'>=24.2.0'}});
 registry.tag(name,'latest','2.0.0');registry.tag(name,'next','3.0.0-rc.1');
 const onlyLocal={root,stateRoot:state,registry:registry.url,nodeVersion:'24.2.0'};
 await writeFile(root+'/.npmrc','registry=https://ignored.invalid/\n');
 const previous=process.env.npm_config__authToken;process.env.npm_config__authToken='fixture-token';
 try{
  assert.deepEqual(await resolveNpmLatest(name,onlyLocal),{version:'2.0.0',packageIntegrity:latest.integrity,registry:registry.url,enginesNode:'>=24.2.0'});
  assert.equal(registry.requests.length,1);
  assert.ok(registry.requests.every(request=>!request.authorization));
  await assert.rejects(()=>resolveNpmLatest(name,{...onlyLocal,nodeVersion:'22.19.0'}),/codegraph@2\.0\.0 requires Node >=24\.2\.0/);
  registry.tag(name,'latest','3.0.0-rc.1');
  await assert.rejects(()=>resolveNpmLatest(name,onlyLocal),/stable latest/i);
  registry.responseStatus=503;
  await assert.rejects(()=>resolveNpmLatest(name,onlyLocal),error=>String(error).includes(name+'@latest')&&String(error).includes(registry.url));
  const abort=new AbortController();registry.onRequest=()=>abort.abort();
  await assert.rejects(()=>resolveNpmLatest(name,{...onlyLocal,signal:abort.signal}),{name:'AbortError'});
  assert.deepEqual(await readdir(state),[]);
 }finally{if(previous===undefined)delete process.env.npm_config__authToken;else process.env.npm_config__authToken=previous;}
 assert.deepEqual(await readdir(state),[]);
}))));

test('npm inspection keeps configured project and prefix cache paths read-only',t=>project(root=>project(prefix=>project(stateRoot=>npmRegistry(async registry=>{
 const {resolveNpmLatest}=await import('../src/integrations/tools/npm-resolution.js');
 const p=await registry.publish('openwiki','2.0.0');
 await writeFile(join(root,'package.json'),'{}');
 const cache=join(prefix,'npm-cache'),logs=join(root,'npm-logs');
 await writeFile(join(root,'.npmrc'),'registry='+registry.url+'\ncache='+cache.replaceAll('\\','/')+'\nlogs-dir='+logs.replaceAll('\\','/')+'\n');
 testEnvironment(t,{npm_config_cache:cache,npm_config_prefix:prefix});
 assert.equal((await resolveNpmLatest('openwiki',{root,stateRoot,nodeVersion:process.versions.node})).packageIntegrity,p.integrity);
 await assert.rejects(access(cache),{code:'ENOENT'});
 await assert.rejects(access(logs),{code:'ENOENT'});
 assert.deepEqual((await readdir(root)).sort(),['.npmrc','package.json']);
 assert.deepEqual(await readdir(prefix),[]);
})))));

test('npm metadata requires a latest tag and accepts an undeclared Node range',()=>project(root=>project(async state=>{
 const {resolveNpmLatest}=await import('../src/integrations/tools/npm-resolution.js');
 const integrity='sha512-'+createHash('sha512').update('fixture').digest('base64');
 const pack={name:'openwiki',version:'2.0.0','dist.integrity':integrity};
 const resolve=(fields:Record<string,unknown>)=>resolveNpmLatest('openwiki',{root,stateRoot:state,nodeVersion:'22.19.0',view:async()=>JSON.stringify(fields)});
 await assert.rejects(()=>resolve(pack),/stable latest tag/);
 assert.deepEqual(await resolve({...pack,'dist-tags.latest':'2.0.0'}),{version:'2.0.0',packageIntegrity:integrity,registry:'https://registry.npmjs.org/'});
 await assert.rejects(()=>resolveNpmLatest('openwiki',{root,stateRoot:state,nodeVersion:'22.19.0',view:async()=>{throw Object.assign(Error('untrusted npm output'),{code:'ETIMEDOUT'});}}),/^Error: Could not resolve openwiki@latest from https:\/\/registry\.npmjs\.org\//);
 assert.deepEqual(await readdir(state),[]);
})));

test('project npm skips shims and interpreters that resolve into the project', {skip:process.platform==='win32'},()=>project(root=>project(async outside=>{
 const {resolveProjectNpm}=await import('../src/integrations/tools/npm-resolution.js');
 const linked=join(outside,'linked'),unsafeNode=join(outside,'unsafe-node');
 await mkdir(linked);await mkdir(unsafeNode);
 await writeFile(join(root,'npm'),'#!/bin/sh\nexit 23\n',{mode:0o755});
 await writeFile(join(root,'node'),'#!/bin/sh\nexit 24\n',{mode:0o755});
 await symlink(join(root,'npm'),join(linked,'npm'));
 await symlink(join(root,'node'),join(unsafeNode,'node'));
 await writeFile(join(unsafeNode,'npm'),'#!/usr/bin/env node\nprocess.exit(25)\n',{mode:0o755});
 const path=process.env.PATH;process.env.PATH=[root,linked,unsafeNode,path??''].join(delimiter);
 try{
  const command=await resolveProjectNpm(root,['--version']);
  assert.ok(!command.env.PATH!.split(delimiter).includes(unsafeNode));
  const {stdout}=await promisify(execFile)(command.executable,command.args,{env:command.env});
  assert.match(stdout,/^\d+\.\d+\.\d+/);
 }finally{if(path===undefined)delete process.env.PATH;else process.env.PATH=path;}
})));

test('approved registry survives verified native install staging and reaches dispatch for both tools',()=>project(async root=>project(async state=>{
 const before=process.env.RIGUP_NPM_REGISTRY;
 process.env.RIGUP_NPM_REGISTRY='https://npm.company.test/team';
 try{
  const registry=await selectedNpmRegistry(root);assert.equal(registry,'https://npm.company.test/team/');
  for(const id of ['openwiki','codegraph'] as const){
   const pin=(await loadUpstreamLock()).find(item=>item.integrationId===id)!;
   const operation=softwareInstallRecipe(root,id,pin.version,pin.packageIntegrity,undefined,registry);
   assert.equal(operation.registry,registry);assertToolOperationRecipe(root,operation,[]);
   const staged=stagedInstall(root,operation,{token:'11111111-1111-1111-1111-111111111111'});
   assert.equal(staged.registry,registry);
   const approved=await saveNativeOperations(root,join(state,'previews'),[operation]);
   const result=await operationExecutor(approved,{stateRoot:state,launch:async actual=>{
    const args=actual.parameters.args;
    const route=args.find(arg=>arg.startsWith('--@colbymchenry:registry='))?.split('=')[1]??args[args.indexOf('--registry')+1];
    assert.equal(route,registry);
    return {status:'failed',message:'synthetic network unavailable'};
   }})(operation.id);
   assert.equal(result.status,'failed');
  }
 }finally{if(before===undefined)delete process.env.RIGUP_NPM_REGISTRY;else process.env.RIGUP_NPM_REGISTRY=before;}
})));

test('a registry change after review prevents fresh and resumed install dispatch and keeps package pins',()=>project(async root=>project(async state=>{
 const before=process.env.RIGUP_NPM_REGISTRY;
 process.env.RIGUP_NPM_REGISTRY='https://npm.company.test/approved/';
 const pin=(await loadUpstreamLock()).find(item=>item.integrationId==='openwiki')!;
 const operation=softwareInstallRecipe(root,'openwiki',pin.version,pin.packageIntegrity,undefined,process.env.RIGUP_NPM_REGISTRY);
 const approved=await saveNativeOperations(root,join(state,'previews'),[operation]);
 let calls=0;
 const dependencies={stateRoot:state,launch:async()=>{calls++;return {status:'failed' as const,message:'fixture network failure'};}};
 const execute=()=>operationExecutor(approved,dependencies)(operation.id);
 try{
  process.env.RIGUP_NPM_REGISTRY='https://npm.company.test/changed/';
  assert.equal((await execute()).status,'pending');
  assert.equal(calls,0);await assert.rejects(access(join(root,'.rigup/tools')),{code:'ENOENT'});
  process.env.RIGUP_NPM_REGISTRY=operation.registry;
  assert.equal((await execute()).status,'failed');assert.equal(calls,1);
  process.env.RIGUP_NPM_REGISTRY='https://npm.company.test/changed/';
  assert.equal((await execute()).status,'pending');assert.equal(calls,1);
  assert.throws(()=>assertToolOperationRecipe(root,{...operation,version:'999.0.0'},[]),/version\/integrity/);
  assert.throws(()=>assertToolOperationRecipe(root,{...operation,query:{...operation.query,integrity:'sha512-wrong'}},[]),/version\/integrity/);
 }finally{if(before===undefined)delete process.env.RIGUP_NPM_REGISTRY;else process.env.RIGUP_NPM_REGISTRY=before;}
})));

test('operation executor will dispatch only a unique ID in the approved snapshot',()=>project(root=>project(async state=>{
 const pin=(await loadUpstreamLock()).find(item=>item.integrationId==='openwiki')!;
 const op=softwareInstallRecipe(root,'openwiki',pin.version,pin.packageIntegrity);
 const approved=await saveNativeOperations(root,join(state,'previews'),[op]);
 const deps={stateRoot:state,launch:async()=>{throw Error('unexpected dispatch');}};
 const result=await operationExecutor(approved,deps)('unapproved');
 assert.match(result.message,/exactly one approved operation/);
 const duplicate=await saveNativeOperations(root,join(state,'previews'),[op,op]);
 assert.throws(()=>operationExecutor(duplicate,deps),/Preview is blocked/);
 assert.deepEqual(await readdir(state),['previews']);
})));

test('registry values reject credentials and query secrets without returning their bytes',()=>project(async root=>{
 const before=process.env.RIGUP_NPM_REGISTRY;
 try{
  for(const value of ['https://synthetic-secret@npm.test/','https://npm.test/?token=synthetic-secret','http://npm.company.test/']){
   process.env.RIGUP_NPM_REGISTRY=value;
   await assert.rejects(selectedNpmRegistry(root),error=>error instanceof Error&&!error.message.includes('synthetic-secret')&&error.message.includes('RIGUP_NPM_REGISTRY'));
  }
  delete process.env.RIGUP_NPM_REGISTRY;
  assert.equal(await selectedNpmRegistry(root),undefined);
  const operation=softwareInstallRecipe(root,'openwiki','1.2.3');
  assert.equal(operation.registry,undefined);
  assert.equal(operation.parameters.args[operation.parameters.args.indexOf('--registry')+1],'https://registry.npmjs.org/');
 }finally{if(before===undefined)delete process.env.RIGUP_NPM_REGISTRY;else process.env.RIGUP_NPM_REGISTRY=before;}
}));
