import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as wait} from 'node:timers/promises';
import {test} from 'node:test';import assert from 'node:assert/strict';
import {loadUpstreamLock} from '../src/integrations/registry.js';
import {project} from './helpers.js';import {acquireLock} from '../src/installer/lock.js';
import {operationExecutor,pendingOperations,assertNoUnknownWriters,queryOperation,type OperationDependencies} from '../src/installer/operations.js';import {prepareSoftwareInstall} from './native-tool-fixture.js';
import fs,{mkdir,rename,writeFile,readFile,unlink,lstat} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {join} from 'node:path';
import {saveNativeOperations,writeNativeToolFixture} from './native-tool-fixture.js';
import {apply} from '../src/installer/apply.js';
import type {PreviewData} from '../src/installer/preview.js';
import {saveDurable} from '../src/private-record.js';
import type {SetupOperation} from '../src/types.js';
async function fixture(fn:(root:string,state:string)=>Promise<void>){await project(async root=>project(async state=>fn(root,state)));}
function dispatch(approval:PreviewData,dependencies:OperationDependencies){
 return operationExecutor(approval,dependencies)(approval.plan.operations[0].id);
}
async function completeFixtureInstall(root:string,operation:SetupOperation){
 const {name,version,integrity,packageLock}=operation.query;
 await writeNativeToolFixture(root,'openwiki',version,'commonjs',operation.protection.target);
 await writeFile(join(root,packageLock),JSON.stringify({packages:{'':{dependencies:{[name]:version}},['node_modules/'+name]:{version,integrity}}}));
 return queryOperation(operation);
}
test('same_target_lock_prevents_second_apply',()=>fixture(async(root,state)=>{
 const first=await acquireLock(root,{stateRoot:state});try{await assert.rejects(()=>acquireLock(root,{stateRoot:state}),/locked|occupied/);await assert.rejects(()=>acquireLock(root,{stateRoot:state,recover:true}),/locked|occupied/);}finally{await first.release();}const next=await acquireLock(root,{stateRoot:state});await next.release();
}));
test('a malformed process identity leaves the existing lock in place',()=>fixture(async(root,state)=>{
 const lock=await acquireLock(root,{stateRoot:state});
 const path=state+'/'+signature(lock.root)+'.lock';
 const record=JSON.stringify({root:lock.root,id:lock.id,identity:{pid:0,started:null}});
 await writeFile(path,record);
 await assert.rejects(()=>acquireLock(root,{stateRoot:state,recover:true}),/lock.*process|process identity cannot be confirmed/i);
 assert.equal(await readFile(path,'utf8'),record);
 await lock.release();
}));
test('a concurrent lock recovery cannot replace the stale lock while its guard is held',()=>fixture(async(root,state)=>{
 const path=state+'/'+signature(root)+'.lock';
 const former=spawn(process.execPath,['-e','process.exit(0)'],{stdio:'ignore'});
 const pid=former.pid;await once(former,'exit');assert.ok(pid);
 const stale=JSON.stringify({root,id:'stale',identity:{pid,started:'v0.8 legacy timestamp'}});
 await writeFile(path,stale,{mode:0o600});
 await writeFile(path+'.recovery','other controller',{mode:0o600});
 await assert.rejects(()=>acquireLock(root,{stateRoot:state,recover:true}),/recovery.*in progress/);
 assert.equal(await readFile(path,'utf8'),stale);
 await unlink(path+'.recovery');
 const next=await acquireLock(root,{stateRoot:state,recover:true});
 await next.release();
}));
async function awaitPid(file:string){
 const deadline=Date.now()+5000;
 while(Date.now()<deadline){
  const pid=Number(await readFile(file,'utf8').catch(()=>0));
  if(pid>0)return pid;
  await wait(30);
 }
 throw Error('The fixture did not start: '+file);
}

for(const resource of [undefined,'native-host:omp','openspec:fixture-prefix'])test(
 'a real live lock excludes another controller and a dead legacy PID can be recovered: '+(resource??'project'),
 ()=>fixture(async(root,stateRoot)=>{
  const module=new URL('../src/installer/lock.ts',import.meta.url).href;
  const path=join(stateRoot,signature(resource?{resource}:root)+'.lock');
  const ready=join(stateRoot,'ready');
  const payload={root,stateRoot,resource,ready};
  const program="import {writeFileSync} from 'node:fs';const spec="+JSON.stringify(payload)+";"+
   "const {acquireLock}=await import("+JSON.stringify(module)+");"+
   "await acquireLock(spec.root,spec);writeFileSync(spec.ready,String(process.pid));setInterval(()=>{},10000);";
  const owner=spawn(process.execPath,['--import','tsx','--input-type=module','-e',program],{stdio:'ignore'});
  const exit=once(owner,'exit');
  try{
   const pid=await awaitPid(ready);
   const record=JSON.parse(await readFile(path,'utf8'));
   assert.equal(record.pid,pid);
   await assert.rejects(acquireLock(root,{stateRoot,resource,recover:true}),/locked|occupied/);
   owner.kill('SIGKILL');await exit;
   await writeFile(path,JSON.stringify({root,id:record.id,identity:{pid,started:'v0.8 legacy timestamp'}}));
   const next=await acquireLock(root,{stateRoot,resource,recover:true});
   try{assert.notEqual(next.id,record.id);}finally{await next.release();}
  }finally{owner.kill('SIGKILL');await exit;}
 }));

test('a writer with a dead controller continues to exclude the shared host resource',()=>fixture((root,stateRoot)=>project(async other=>{
 const module=new URL('../src/integrations/host-setup/runtime.ts',import.meta.url).href;
 const marker=join(root,'writer.pid');
 const writer="require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},10000);";
 const command={executable:process.execPath,args:['-e',writer,marker],env:{}};
 const program="const {withHostWriter}=await import("+JSON.stringify(module)+");"+
  "await withHostWriter("+JSON.stringify({root,stateRoot})+",'omp',r=>r.run("+JSON.stringify(command)+","+
  JSON.stringify(root)+",15000,async()=>undefined));";
 const owner=spawn(process.execPath,['--import','tsx','--input-type=module','-e',program],{stdio:'ignore'});
 const exit=once(owner,'exit');
 let writerPid:number|undefined;
 try{
  writerPid=await awaitPid(marker);
  owner.kill('SIGKILL');await exit;
  const {withHostWriter}=await import('../src/integrations/host-setup/runtime.js');
  await assert.rejects(withHostWriter({root:other,stateRoot},'omp',async()=>assert.fail('second writer started')),/still active|occupied/);
  await assert.rejects(assertNoUnknownWriters(root,stateRoot),/still active/);
 }finally{
  owner.kill('SIGKILL');await exit;
  if(writerPid)try{process.kill(writerPid,'SIGKILL');}catch{}
 }
})));

test('the next project tool waits for the first writer to finish',()=>fixture(async(root,stateRoot)=>{
 const pins=await loadUpstreamLock(),cacheRoot=join(stateRoot,'previews');
 const operations:SetupOperation[]=[];
 for(const id of ['openwiki','codegraph'] as const){
  const pin=pins.find(item=>item.integrationId===id)!;
  const operation=await prepareSoftwareInstall(root,id,pin.version,pin.packageIntegrity);
  if('pending' in operation||'reused' in operation)assert.fail('fixture tool did not need an install');
  operations.push(operation);
 }
 const {preview}=await saveNativeOperations(root,cacheRoot,operations);
 const launched:string[]=[];
 const result=await apply(preview.previewId,{cacheRoot,stateRoot,operation:{launch:async operation=>{
  launched.push(operation.integrationId);
  if(operation.integrationId==='openwiki')await wait(200);
  return {status:'pending',message:'fixture pauses before publication'};
 }}});
 assert.equal(result.status,'pending');
 assert.deepEqual(launched,['openwiki']);
 const journal=await pendingOperations(root,stateRoot);
 assert.deepEqual(journal.map(item=>item.operation.integrationId),['openwiki']);
}));

test('a reused PID cannot block a completed project writer receipt',()=>fixture(async(root,stateRoot)=>{
 const pin=(await loadUpstreamLock()).find(item=>item.integrationId==='openwiki')!;
 const operation=await prepareSoftwareInstall(root,'openwiki',pin.version,pin.packageIntegrity);
 if('pending' in operation||'reused' in operation)assert.fail('fixture tool did not need an install');
 const approval=await saveNativeOperations(root,join(stateRoot,'previews'),[operation]);
 assert.equal((await dispatch(approval,{stateRoot,launch:actual=>completeFixtureInstall(root,actual)})).status,'done');
 const path=join(stateRoot,signature(root)+'.operations.json');
 const journal=JSON.parse(await readFile(path,'utf8'));
 journal.operations[0].identity={pid:process.pid};
 await saveDurable(path,JSON.stringify(journal));
 await assertNoUnknownWriters(root,stateRoot);
 assert.equal((await dispatch(approval,{stateRoot,launch:async()=>assert.fail('completed operation dispatched again')})).status,'done');
 assert.equal((await pendingOperations(root,stateRoot))[0].identity,undefined);
}));

test('pending_record_is_durable_before_dispatch',()=>fixture(async(root,state)=>{
 const op=await prepareSoftwareInstall(root,'openwiki','0.7.3',(await loadUpstreamLock()).find(r=>r.integrationId==='openwiki')!.packageIntegrity);if('pending' in op||'reused' in op)throw Error('fixture');
 const approval=await saveNativeOperations(root,join(state,'previews'),[op]);let dispatched=0;
 await assert.rejects(()=>dispatch(approval,{stateRoot:state,save:async()=>{throw Error('state unavailable');},launch:async()=>{dispatched++;return {status:'done',message:'fake'};}}),/state unavailable/);assert.equal(dispatched,0);
}));
test('cancellation after reserving staging leaves an undispatched operation resumable',()=>fixture(async(root,state)=>{
 const recipe=(await loadUpstreamLock()).find(r=>r.integrationId==='openwiki')!;
 const op=await prepareSoftwareInstall(root,'openwiki',recipe.version,recipe.packageIntegrity);
 if('pending' in op||'reused' in op)throw Error('fixture');
 const approval=await saveNativeOperations(root,join(state,'previews'),[op]);
 const controller=new AbortController();
 const result=await dispatch(approval,{stateRoot:state,signal:controller.signal,save:async(path,content)=>{
  await saveDurable(path,content);
  if(JSON.parse(content).operations[0].installStage?.identity)controller.abort();
 },launch:async()=>{throw Error('cancelled operation was dispatched');}});
 assert.equal(result.status,'pending');
 assert.equal((await pendingOperations(root,state))[0].stage,'prepared');
 await assertNoUnknownWriters(root,state);
}));
test('cancellation during the final registry read stops before dispatch',t=>fixture(async(root,state)=>{
 const recipe=(await loadUpstreamLock()).find(r=>r.integrationId==='openwiki')!;
 const op=await prepareSoftwareInstall(root,'openwiki',recipe.version,recipe.packageIntegrity);
 if('pending' in op||'reused' in op)throw Error('fixture');
 const approval=await saveNativeOperations(root,join(state,'previews'),[op]);
 const controller=new AbortController();
 let stagingSaved=false;
 const original=fs.lstat;
 const probe=t.mock.method(fs,'lstat',async (...args:Parameters<typeof fs.lstat>)=>{
  try{return await original(...args);}
  finally{if(stagingSaved&&args[0]===join(root,'.rigup','.env'))controller.abort();}
 });
 syncBuiltinESMExports();
 try{
  const result=await dispatch(approval,{stateRoot:state,signal:controller.signal,save:async(path,content)=>{
   await saveDurable(path,content);
   stagingSaved=!!JSON.parse(content).operations[0].installStage?.identity;
  },launch:async()=>{throw Error('cancelled operation was dispatched');}});
  assert.equal(result.message,'Cancelled before dispatch');
  assert.equal((await pendingOperations(root,state))[0].stage,'prepared');
 }finally{probe.mock.restore();syncBuiltinESMExports();}
}));
test('unsupported_remote_operation_is_not_dispatched_or_retried',()=>fixture(async(root,state)=>{
 const op=await prepareSoftwareInstall(root,'openwiki','0.7.3',(await loadUpstreamLock()).find(r=>r.integrationId==='openwiki')!.packageIntegrity);if('pending' in op||'reused' in op)throw Error('fixture');
 const cacheRoot=join(state,'previews');
 const {preview}=await saveNativeOperations(root,cacheRoot,[{...op,integrationId:'unknown-remote'}]);
 assert.equal(preview.executable,false);
 await assert.rejects(()=>apply(preview.previewId,{cacheRoot,stateRoot:state}),/preview is blocked/);
}));
import {signature} from '../src/generator/cache.js';
test('an accepted staging result is recovered without another launch',()=>fixture(async(root,state)=>{
 const integrity=(await loadUpstreamLock()).find(r=>r.integrationId==='openwiki')!.packageIntegrity!;const op=await prepareSoftwareInstall(root,'openwiki','0.7.3',integrity);if('pending' in op||'reused' in op)throw Error('fixture');
 const approval=await saveNativeOperations(root,join(state,'previews'),[op]);let creates=0;
 const launch=async(dispatched:SetupOperation)=>{creates++;await completeFixtureInstall(root,dispatched);throw Error('controller crashed after acceptance');};
 await assert.rejects(()=>dispatch(approval,{stateRoot:state,launch}),/crashed/);const pending=await pendingOperations(root,state);assert.equal(pending[0].stage,'prepared');
 const result=await dispatch(approval,{stateRoot:state,launch});assert.equal(result.status,'done');assert.equal(creates,1);
}));
test('unconfirmed_process_exit_keeps_project_blocked',()=>fixture(async(root,state)=>{
 const integrity=(await loadUpstreamLock()).find(r=>r.integrationId==='openwiki')!.packageIntegrity!;const op=await prepareSoftwareInstall(root,'openwiki','0.7.3',integrity);if('pending' in op||'reused' in op)throw Error('fixture');
 const approval=await saveNativeOperations(root,join(state,'previews'),[op]);
 const {processIdentity}=await import('../src/installer/lock.js');const identity=await processIdentity(process.pid);await writeFile(state+'/'+signature(root)+'.operations.json',JSON.stringify({operations:[{root,authorizationRef:approval.preview.previewId,operation:op,parametersDigest:signature(op),stage:'dispatching',identity}]}),{mode:0o600});
 await assert.rejects(()=>assertNoUnknownWriters(root,state),/active|blocked/);const r=await dispatch(approval,{stateRoot:state});assert.equal(r.status,'unknown');
}));

test('an interrupted install retries from journal-owned staging and publishes a verified receipt',()=>fixture(async(root,state)=>{
 const pin=(await loadUpstreamLock()).find(r=>r.integrationId==='openwiki')!;
 const op=await prepareSoftwareInstall(root,'openwiki',pin.version,pin.packageIntegrity);
 if('pending' in op||'reused' in op)throw Error('fixture');
 const approval=await saveNativeOperations(root,join(state,'previews'),[op]);
 const options={stateRoot:state};
 let interruptedPath='';
 await assert.rejects(()=>dispatch(approval,{...options,launch:async dispatched=>{
  interruptedPath=join(root,dispatched.protection.target);
  await mkdir(join(interruptedPath,'node_modules'),{recursive:true});
  await writeFile(join(interruptedPath,'partial'),'interrupted npm');
  throw Error('controller crashed during installation');
 }}),/controller crashed during installation/);
 await assert.doesNotReject(()=>assertNoUnknownWriters(root,state));
 await assert.rejects(()=>lstat(join(root,op.protection.target)),{code:'ENOENT'});

 const result=await dispatch(approval,{...options,launch:async dispatched=>{
  assert.notEqual(dispatched.protection.target,op.protection.target);
  return completeFixtureInstall(root,dispatched);
 }});
 assert.equal(result.status,'done',result.message);
 assert.deepEqual(result.receipt,(await queryOperation(op)).receipt);
 await assert.rejects(()=>lstat(interruptedPath),{code:'ENOENT'});
 await assert.rejects(()=>lstat(join(root,op.protection.target,'partial')),{code:'ENOENT'});
}));

test('recovery preserves a substituted staging directory',()=>fixture(async(root,state)=>{
 const pin=(await loadUpstreamLock()).find(r=>r.integrationId==='openwiki')!;
 const op=await prepareSoftwareInstall(root,'openwiki',pin.version,pin.packageIntegrity);
 if('pending' in op||'reused' in op)throw Error('fixture');
 const approval=await saveNativeOperations(root,join(state,'previews'),[op]);
 const options={stateRoot:state};
 let staging='';
 await assert.rejects(()=>dispatch(approval,{...options,launch:async dispatched=>{
  staging=join(root,dispatched.protection.target);
  await mkdir(staging,{recursive:true});
  throw Error('interrupted staging');
 }}),/interrupted staging/);
 await rename(staging,staging+'.saved');
 await mkdir(staging);
 const customer=join(staging,'customer.txt');
 await writeFile(customer,'preserve');
 await assert.rejects(()=>assertNoUnknownWriters(root,state),/staging.*identity/i);
 await assert.rejects(()=>dispatch(approval,options),/staging.*identity/i);
 assert.equal(await readFile(customer,'utf8'),'preserve');
}));

test('an installation published before its terminal journal record is reused',()=>fixture(async(root,state)=>{
 const pin=(await loadUpstreamLock()).find(r=>r.integrationId==='openwiki')!;
 const op=await prepareSoftwareInstall(root,'openwiki',pin.version,pin.packageIntegrity);
 if('pending' in op||'reused' in op)throw Error('fixture');
 const approval=await saveNativeOperations(root,join(state,'previews'),[op]);
 const options={stateRoot:state};
 await assert.rejects(()=>dispatch(approval,{...options,launch:dispatched=>completeFixtureInstall(root,dispatched),save:async(path,content)=>{
  if(JSON.parse(content).operations[0].stage==='terminal')throw Error('controller lost terminal record');
  await saveDurable(path,content);
 }}),/controller lost terminal record/);
 assert.equal((await queryOperation(op)).status,'done');
 await assert.doesNotReject(()=>assertNoUnknownWriters(root,state));
 const resumed=await dispatch(approval,{...options,launch:async()=>{throw Error('published installation was dispatched twice');}});
 assert.equal(resumed.status,'done');
}));

test('damaged operation records block the writer gate and dispatch',()=>fixture(async(root,state)=>{
 const recipe=(await loadUpstreamLock()).find(r=>r.integrationId==='openwiki')!;
 const op=await prepareSoftwareInstall(root,'openwiki',recipe.version,recipe.packageIntegrity);
 if('pending' in op||'reused' in op)throw Error('fixture');
 const approval=await saveNativeOperations(root,join(state,'previews'),[op]);
 const record=state+'/'+signature(root)+'.operations.json';
 let dispatched=0;
 const missingWriter=JSON.stringify({operations:[{root,authorizationRef:approval.preview.previewId,operation:op,parametersDigest:signature(op),stage:'dispatching'}]});
 for(const invalid of ['{"operations":','{}','{"operations":[{}]}',missingWriter]){
  await writeFile(record,invalid,{mode:0o600});
  await assert.rejects(()=>assertNoUnknownWriters(root,state),/operation record.*reconciliation/i);
  await assert.rejects(()=>dispatch(approval,{stateRoot:state,launch:async()=>{
   dispatched++;return {status:'failed',message:'unexpected dispatch'};
  }}),/operation record.*reconciliation/i);
  assert.equal(await readFile(record,'utf8'),invalid);
 }
 assert.equal(dispatched,0);
}));
