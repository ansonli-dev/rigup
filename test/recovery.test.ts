import {test} from 'node:test';import assert from 'node:assert/strict';
import {loadUpstreamLock} from '../src/integrations/registry.js';
import {project} from './helpers.js';import {acquireLock} from '../src/installer/lock.js';
import {executeOperation,pendingOperations,assertNoUnknownWriters} from '../src/installer/operations.js';import {prepareSoftwareInstall} from '../src/integrations/tools/software.js';
import {writeFile,readFile,unlink} from 'node:fs/promises';
import {writeNativeToolFixture} from './native-tool-fixture.js';
async function fixture(fn:(root:string,state:string)=>Promise<void>){await project(async root=>project(async state=>fn(root,state)));}
test('same_target_lock_prevents_second_apply',()=>fixture(async(root,state)=>{
 const first=await acquireLock(root,{stateRoot:state});try{await assert.rejects(()=>acquireLock(root,{stateRoot:state}),/locked|occupied/);await assert.rejects(()=>acquireLock(root,{stateRoot:state,recover:true}),/locked|occupied/);}finally{await first.release();}const next=await acquireLock(root,{stateRoot:state});await next.release();
}));
test('a malformed process identity leaves the existing lock in place',()=>fixture(async(root,state)=>{
 const lock=await acquireLock(root,{stateRoot:state});
 const path=state+'/'+signature(lock.root)+'.lock';
 const record=JSON.stringify({root:lock.root,id:lock.id,identity:{pid:process.pid,started:null}});
 await writeFile(path,record);
 await assert.rejects(()=>acquireLock(root,{stateRoot:state,recover:true}),/process identity cannot be confirmed/);
 assert.equal(await readFile(path,'utf8'),record);
 await lock.release();
}));
test('a concurrent lock recovery cannot replace the stale lock while its guard is held',()=>fixture(async(root,state)=>{
 const path=state+'/'+signature(root)+'.lock';
 const stale=JSON.stringify({root,id:'stale',identity:{pid:process.pid,started:process.platform==='win32'?'win32:111111111111111111':'previous process'}});
 await writeFile(path,stale,{mode:0o600});
 await writeFile(path+'.recovery','other controller',{mode:0o600});
 await assert.rejects(()=>acquireLock(root,{stateRoot:state,recover:true}),/recovery.*in progress/);
 assert.equal(await readFile(path,'utf8'),stale);
 await unlink(path+'.recovery');
 const next=await acquireLock(root,{stateRoot:state,recover:true});
 await next.release();
}));
test('pending_record_is_durable_before_dispatch',()=>fixture(async(root,state)=>{
 const op=await prepareSoftwareInstall(root,'openwiki','0.7.3',(await loadUpstreamLock()).find(r=>r.integrationId==='openwiki')!.packageIntegrity);if('pending' in op||'reused' in op)throw Error('fixture');let dispatched=0;
 await assert.rejects(()=>executeOperation(op,{stateRoot:state,authorizationRef:'fixture-approved',save:async()=>{throw Error('state unavailable');},launch:async()=>{dispatched++;return {status:'done',message:'fake'};}}),/state unavailable/);assert.equal(dispatched,0);
}));
test('cancellation while recording dispatch leaves an undispatched operation resumable',()=>fixture(async(root,state)=>{
 const recipe=(await loadUpstreamLock()).find(r=>r.integrationId==='openwiki')!;
 const op=await prepareSoftwareInstall(root,'openwiki',recipe.version,recipe.packageIntegrity);
 if('pending' in op||'reused' in op)throw Error('fixture');
 const controller=new AbortController();
 const {saveDurable}=await import('../src/private-record.js');
 const result=await executeOperation(op,{stateRoot:state,authorizationRef:'fixture-approved',signal:controller.signal,save:async(path,content)=>{
  await saveDurable(path,content);
  if(JSON.parse(content).operations[0].stage==='dispatching')controller.abort();
 },launch:async()=>{throw Error('cancelled operation was dispatched');}});
 assert.equal(result.status,'pending');
 assert.equal((await pendingOperations(root,state))[0].stage,'prepared');
 await assertNoUnknownWriters(root,state);
}));
test('unsupported_remote_operation_is_not_dispatched_or_retried',()=>fixture(async(root,state)=>{
 const op=await prepareSoftwareInstall(root,'openwiki','0.7.3',(await loadUpstreamLock()).find(r=>r.integrationId==='openwiki')!.packageIntegrity);if('pending' in op||'reused' in op)throw Error('fixture');const r=await executeOperation({...op,integrationId:'unknown-remote'},{stateRoot:state});assert.equal(r.status,'pending');
}));
import {signature} from '../src/generator/cache.js';
test('crash_after_acceptance_reconciles_without_recreate_even_if_cache_is_lost',()=>fixture(async(root,state)=>{
 const integrity=(await loadUpstreamLock()).find(r=>r.integrationId==='openwiki')!.packageIntegrity!;const op=await prepareSoftwareInstall(root,'openwiki','0.7.3',integrity);if('pending' in op||'reused' in op)throw Error('fixture');let creates=0;
 const launch=async()=>{creates++;const {prefix}=await writeNativeToolFixture(root,'openwiki','0.7.3');await writeFile(prefix+'/package-lock.json',JSON.stringify({packages:{'':{dependencies:{openwiki:'0.7.3'}},'node_modules/openwiki':{version:'0.7.3',integrity}}}));throw Error('controller crashed after acceptance');};
 await assert.rejects(()=>executeOperation(op,{stateRoot:state,authorizationRef:'fixture-approved',launch}),/crashed/);const pending=await pendingOperations(root,state);assert.equal(pending[0].stage,'dispatching');
 const result=await executeOperation(op,{stateRoot:state,authorizationRef:'fixture-approved',launch});assert.equal(result.status,'done');assert.equal(creates,1);
}));
test('unconfirmed_process_exit_keeps_project_blocked',()=>fixture(async(root,state)=>{
 const integrity=(await loadUpstreamLock()).find(r=>r.integrationId==='openwiki')!.packageIntegrity!;const op=await prepareSoftwareInstall(root,'openwiki','0.7.3',integrity);if('pending' in op||'reused' in op)throw Error('fixture');
 const {processIdentity}=await import('../src/installer/lock.js');const identity=await processIdentity(process.pid);await writeFile(state+'/'+signature(root)+'.operations.json',JSON.stringify({operations:[{operation:op,parametersDigest:signature(op),stage:'dispatching',identity}]}),{mode:0o600});
 await assert.rejects(()=>assertNoUnknownWriters(root,state),/active|blocked/);const r=await executeOperation(op,{stateRoot:state,authorizationRef:'fixture-approved'});assert.equal(r.status,'unknown');
}));

test('damaged operation records block the writer gate and dispatch',()=>fixture(async(root,state)=>{
 const recipe=(await loadUpstreamLock()).find(r=>r.integrationId==='openwiki')!;
 const op=await prepareSoftwareInstall(root,'openwiki',recipe.version,recipe.packageIntegrity);
 if('pending' in op||'reused' in op)throw Error('fixture');
 const record=state+'/'+signature(root)+'.operations.json';
 let dispatched=0;
 for(const invalid of ['{"operations":','{}','{"operations":[{}]}']){
  await writeFile(record,invalid,{mode:0o600});
  await assert.rejects(()=>assertNoUnknownWriters(root,state),/operation record.*reconciliation/i);
  await assert.rejects(()=>executeOperation(op,{stateRoot:state,authorizationRef:'fixture-approved',launch:async()=>{
   dispatched++;return {status:'failed',message:'unexpected dispatch'};
  }}),/operation record.*reconciliation/i);
  assert.equal(await readFile(record,'utf8'),invalid);
 }
 assert.equal(dispatched,0);
}));
