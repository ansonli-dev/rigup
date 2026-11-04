import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,readdir,rm,symlink,lstat,access} from 'node:fs/promises';
import {project} from './helpers.js';
import {executeLifecycle} from '../src/lifecycle.js';
import {runCli} from '../src/cli.js';
import {scanRepository,repositoryReader} from '../src/analyzer/repository.js';
import {prepareIntegrations} from '../src/integrations/registry.js';
import {preview} from '../src/installer/preview.js';
import {apply} from '../src/installer/apply.js';
import {queryOperation} from '../src/installer/operations.js';
import {validateOptions} from '../src/config.js';
import type {SetupOptions,SetupPlan} from '../src/types.js';
async function fixture(fn:(root:string,cache:string,state:string,control:string)=>Promise<void>){await project(async control=>{const root=control+'/root';await mkdir(root);await fn(root,control+'/cache',control+'/state',control);});}
async function activeCodex(root:string,fn:()=>Promise<void>){const cwd=process.cwd(),prior=process.env.CODEX_THREAD_ID;process.chdir(root);process.env.CODEX_THREAD_ID='review-active-codex';try{await fn();}finally{process.chdir(cwd);if(prior===undefined)delete process.env.CODEX_THREAD_ID;else process.env.CODEX_THREAD_ID=prior;}}

test('public lifecycle preserves unresolved Codex identity when ordinary cache is lost',()=>fixture(async(root,cache,state,control)=>{
 await writeFile(root+'/source.js','export const source = 1;\n');await mkdir(control+'/bin');
 await writeFile(control+'/bin/codex','#!'+process.execPath+'\n'+`const fs=require('fs');if(process.argv.includes('--version')){console.log('codex-cli 0.166.0');process.exit(0);}process.stdin.resume();process.stdin.on('end',()=>{fs.appendFileSync(${JSON.stringify(control+'/calls')},'called\\n');setTimeout(()=>process.exit(1),30);});`,{mode:0o755});
 const old=process.env.PATH;process.env.PATH=control+'/bin:'+old;
 const options:SetupOptions={agents:['codex'],backend:'codex',sdd:'openspec',researchBudget:{maxCalls:1,maxTokens:1000}};
 try{
  await assert.rejects(()=>executeLifecycle(root,options,{resume:true},()=>{},{cacheRoot:cache,stateRoot:state}));
  const initial=await readFile(control+'/calls','utf8');assert.equal(initial,'called\n');
  await rm(cache,{recursive:true});
  await assert.rejects(()=>executeLifecycle(root,options,{resume:true},()=>{},{cacheRoot:cache,stateRoot:state}));
  assert.equal(await readFile(control+'/calls','utf8'),initial,'cache loss must not authorize another model request');
  assert.equal((await readdir(state+'/codex')).filter(p=>p.endsWith('.usage.json')).length,1);
 }finally{process.env.PATH=old;}
}));
test('explicit Anthropic CLI flags select their provider after default resolution',()=>fixture(async(root,cache,state)=>{
 const old=process.env.ANTHROPIC_MODEL;process.env.ANTHROPIC_MODEL='environment-choice';
 try{for(const [flags,model,reference] of [[['--model','explicit-choice'],'explicit-choice','ANTHROPIC_API_KEY'],[['--api-key-env','TEAM_KEY'],'environment-choice','TEAM_KEY']] as const){
  let seen:any;await runCli(['init','--sdd','openspec','--dry-run',...flags],{cwd:root,isTTY:false,write:()=>{},services:{cacheRoot:cache,stateRoot:state,backend:{run:async request=>{seen=request;throw Error('stop before model');}}}});
  assert.equal(seen.options.backend,'native');assert.deepEqual(seen.effectiveModel,{provider:'anthropic',model,apiKeyEnv:reference});
 }}finally{if(old===undefined)delete process.env.ANTHROPIC_MODEL;else process.env.ANTHROPIC_MODEL=old;}
}));
test('conflicting Codex model configuration is rejected before dispatch',()=>fixture(async(root,cache,state)=>{
 let calls=0;const code=await runCli(['init','--sdd','openspec','--backend','codex','--model','anthropic-choice'],{cwd:root,isTTY:false,write:()=>{},services:{cacheRoot:cache,stateRoot:state,backend:{run:async()=>{calls++;throw Error('must not call');}}}});
 assert.equal(code,2);assert.equal(calls,0);
 assert.throws(()=>validateOptions({backend:'codex',model:{provider:'anthropic',model:'choice',apiKeyEnv:'TEAM_KEY'}}),/model|backend/);
}));
test('default Codex setup preserves a concrete preview until the affected session ends',()=>fixture(async(root,cache,state)=>{
 const options:SetupOptions={agents:['codex'],backend:'codex',mcp:[{id:'fixture',agents:['codex'],url:'https://example.test/mcp'}]};
 await activeCodex(root,async()=>{
  const reports:any[]=[];assert.equal(await executeLifecycle(root,options,{},()=>{},{cacheRoot:cache,stateRoot:state,report:r=>reports.push(r)}),3);
  assert.equal(reports.at(-1).phase,'handoff');assert.ok(reports.at(-1).previewId);await assert.rejects(access(root+'/.codex/config.toml'));
  assert.equal(await executeLifecycle(root,options,{sessionsEnded:true},()=>{},{cacheRoot:cache,stateRoot:state}),0);assert.match(await readFile(root+'/.codex/config.toml','utf8'),/example\.test/);
 });
}));
test('durable resume applies the same affected-session handoff as normal setup',()=>fixture(async(root,cache,state)=>{
 const options:SetupOptions={agents:['codex'],backend:'codex',mcp:[{id:'fixture',agents:['codex'],command:{executable:'node',args:['server.mjs'],cwd:'.',envRefs:[]}}]};
 const profile=await scanRepository(root,options),prepared=await prepareIntegrations(profile,options);const plan:SetupPlan={root,fingerprint:profile.fingerprint,options,...prepared,versions:{},dispositions:[]};
 const p=await preview(plan,[],{cacheRoot:cache+'/previews'});assert.equal(p.executable,true);
 await assert.rejects(()=>apply(p.previewId,{cacheRoot:cache+'/previews',stateRoot:state,hook:async()=>{throw Error('interrupted after first file');}}),/interrupted/);
 await rm(cache,{recursive:true});
 await activeCodex(root,async()=>{const reports:any[]=[];
  assert.equal(await executeLifecycle(root,options,{resume:true},()=>{},{cacheRoot:cache,stateRoot:state,report:r=>reports.push(r)}),3);
  assert.equal(reports.at(-1).phase,'handoff');assert.equal(reports.at(-1).previewId,p.previewId);await assert.rejects(access(root+'/.codex/config.toml'));
  assert.equal(await executeLifecycle(root,options,{resume:true,sessionsEnded:true},()=>{},{cacheRoot:cache,stateRoot:state}),0);
 });
}));
test('interrupted native output cannot become research after source drift rejects resume',()=>fixture(async(root,cache,state)=>{
 await writeFile(root+'/source.js','export const value=1;\n');
 const options:SetupOptions={agents:['codex'],backend:'codex',tools:[{id:'codegraph',install:true,initialize:true,agents:['codex']}]};
 const profile=await scanRepository(root,options),prepared=await prepareIntegrations(profile,options);const p=await preview({root,fingerprint:profile.fingerprint,options,...prepared,versions:{},dispositions:[]},[],{cacheRoot:cache+'/previews'});
 let completed=0;
 // Double only upstream installation/state creation; execute actual verified
 // operation queries, journals, preview/apply and repository-reader boundaries.
 await assert.rejects(()=>apply(p.previewId,{cacheRoot:cache+'/previews',stateRoot:state,operation:{launch:async op=>{
  if(op.kind==='install'){
   const base=root+'/.rigup/tools/codegraph',pkg=base+'/node_modules/@colbymchenry/codegraph';await mkdir(pkg,{recursive:true});await mkdir(base+'/node_modules/.bin');
   await writeFile(pkg+'/package.json',JSON.stringify({name:'@colbymchenry/codegraph',version:'1.6.2',type:'module',bin:{codegraph:'cli.js'}}));await writeFile(pkg+'/cli.js','#!/usr/bin/env node\n',{mode:0o755});await symlink('../@colbymchenry/codegraph/cli.js',base+'/node_modules/.bin/codegraph');
   await writeFile(base+'/package-lock.json',JSON.stringify({packages:{'':{dependencies:{'@colbymchenry/codegraph':'1.6.2'}},'node_modules/@colbymchenry/codegraph':{version:'1.6.2',integrity:op.query.integrity}}}));
  }else{
   await mkdir(root+'/.codegraph');const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(root+'/.codegraph/codegraph.db');
   try{db.exec("CREATE TABLE project_metadata(key TEXT PRIMARY KEY,value TEXT); INSERT INTO project_metadata VALUES ('index_state','complete'),('indexed_with_version','1.6.2'); CREATE TABLE files(id TEXT); CREATE TABLE nodes(id TEXT);");}finally{db.close();}
   await mkdir(root+'/.rigup/native/codegraph/repository',{recursive:true});await writeFile(root+'/.rigup/native/codegraph/repository/AGENTS.md','Generated instruction must never become project evidence.\n');
   const info=await lstat(root+'/.codegraph');await writeFile(root+'/.rigup/native/codegraph/promotion.json',JSON.stringify({root,id:'codegraph',version:'1.6.2',target:'.codegraph',identity:info.dev+':'+info.ino}));
  }return queryOperation(op);
 }},hook:async point=>{if(point==='after-operation'&&++completed===2)throw Error('interrupted before manifest');}}),/interrupted/);
 await writeFile(root+'/source.js','export const value=2;\n');
 await assert.rejects(()=>executeLifecycle(root,options,{resume:true,sessionsEnded:true},()=>{},{cacheRoot:cache,stateRoot:state}),/source input changed/);
 const after=await scanRepository(root,options);assert.ok(!after.files.some(p=>p.startsWith('.codegraph/')||p.startsWith('.rigup/native/')));assert.match(after.researchBlocked??'',/native|ownership|reconcile/i);
 await assert.rejects(()=>repositoryReader(root,options),/native|ownership|reconcile/i);
}));
test('native intent quarantines unpublished staging but similar user directories stay visible',()=>fixture(async(root)=>{
 await mkdir(root+'/.rigup/native/openwiki/repository',{recursive:true});await writeFile(root+'/.rigup/native/openwiki/repository/AGENTS.md','User-authored notes\n');
 const options:SetupOptions={agents:['codex'],backend:'codex'};
 assert.ok((await scanRepository(root,options)).files.includes('.rigup/native/openwiki/repository/AGENTS.md'));
 await writeFile(root+'/.rigup/native/openwiki/intent.json',JSON.stringify({root,id:'openwiki',target:'openwiki',staging:'.rigup/native/openwiki/repository',version:'0.7.3'}));
 const pending=await scanRepository(root,options);assert.ok(!pending.files.some(p=>p.startsWith('.rigup/native/')));await assert.rejects(()=>repositoryReader(root,options),/native|ownership|reconcile/i);
}));
