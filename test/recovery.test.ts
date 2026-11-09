import {test} from 'node:test';import assert from 'node:assert/strict';
import {loadUpstreamLock} from '../src/integrations/registry.js';
import {project} from './helpers.js';import {acquireLock} from '../src/installer/lock.js';
import {executeOperation,pendingOperations,assertNoUnknownWriters,queryOperation} from '../src/installer/operations.js';import {prepareSoftwareInstall} from '../src/integrations/tools/software.js';
import {mkdir,rename,writeFile,readFile,unlink,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {writeNativeToolFixture} from './native-tool-fixture.js';
import {saveDurable} from '../src/private-record.js';
import type {SetupOperation} from '../src/types.js';
async function fixture(fn:(root:string,state:string)=>Promise<void>){await project(async root=>project(async state=>fn(root,state)));}
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
test('cancellation after reserving staging leaves an undispatched operation resumable',()=>fixture(async(root,state)=>{
 const recipe=(await loadUpstreamLock()).find(r=>r.integrationId==='openwiki')!;
 const op=await prepareSoftwareInstall(root,'openwiki',recipe.version,recipe.packageIntegrity);
 if('pending' in op||'reused' in op)throw Error('fixture');
 const controller=new AbortController();
 const result=await executeOperation(op,{stateRoot:state,authorizationRef:'fixture-approved',signal:controller.signal,save:async(path,content)=>{
  await saveDurable(path,content);
  if(JSON.parse(content).operations[0].installStage?.identity)controller.abort();
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
 const launch=async(dispatched:SetupOperation)=>{creates++;await completeFixtureInstall(root,dispatched);throw Error('controller crashed after acceptance');};
 await assert.rejects(()=>executeOperation(op,{stateRoot:state,authorizationRef:'fixture-approved',launch}),/crashed/);const pending=await pendingOperations(root,state);assert.equal(pending[0].stage,'prepared');
 const result=await executeOperation(op,{stateRoot:state,authorizationRef:'fixture-approved',launch});assert.equal(result.status,'done');assert.equal(creates,1);
}));
test('unconfirmed_process_exit_keeps_project_blocked',()=>fixture(async(root,state)=>{
 const integrity=(await loadUpstreamLock()).find(r=>r.integrationId==='openwiki')!.packageIntegrity!;const op=await prepareSoftwareInstall(root,'openwiki','0.7.3',integrity);if('pending' in op||'reused' in op)throw Error('fixture');
 const {processIdentity}=await import('../src/installer/lock.js');const identity=await processIdentity(process.pid);await writeFile(state+'/'+signature(root)+'.operations.json',JSON.stringify({operations:[{root,authorizationRef:'fixture-approved',operation:op,parametersDigest:signature(op),stage:'dispatching',identity}]}),{mode:0o600});
 await assert.rejects(()=>assertNoUnknownWriters(root,state),/active|blocked/);const r=await executeOperation(op,{stateRoot:state,authorizationRef:'fixture-approved'});assert.equal(r.status,'unknown');
}));

test('an interrupted install retries from journal-owned staging and publishes a verified receipt',()=>fixture(async(root,state)=>{
 const pin=(await loadUpstreamLock()).find(r=>r.integrationId==='openwiki')!;
 const op=await prepareSoftwareInstall(root,'openwiki',pin.version,pin.packageIntegrity);
 if('pending' in op||'reused' in op)throw Error('fixture');
 const options={stateRoot:state,authorizationRef:'fixture-approved'};
 let interruptedPath='';
 await assert.rejects(()=>executeOperation(op,{...options,launch:async dispatched=>{
  interruptedPath=join(root,dispatched.protection.target);
  await mkdir(join(interruptedPath,'node_modules'),{recursive:true});
  await writeFile(join(interruptedPath,'partial'),'interrupted npm');
  throw Error('controller crashed during installation');
 }}),/controller crashed during installation/);
 await assert.doesNotReject(()=>assertNoUnknownWriters(root,state));
 await assert.rejects(()=>lstat(join(root,op.protection.target)),{code:'ENOENT'});

 const result=await executeOperation(op,{...options,launch:async dispatched=>{
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
 const options={stateRoot:state,authorizationRef:'fixture-approved'};
 let staging='';
 await assert.rejects(()=>executeOperation(op,{...options,launch:async dispatched=>{
  staging=join(root,dispatched.protection.target);
  await mkdir(staging,{recursive:true});
  throw Error('interrupted staging');
 }}),/interrupted staging/);
 await rename(staging,staging+'.saved');
 await mkdir(staging);
 const customer=join(staging,'customer.txt');
 await writeFile(customer,'preserve');
 await assert.rejects(()=>assertNoUnknownWriters(root,state),/staging.*identity/i);
 await assert.rejects(()=>executeOperation(op,options),/staging.*identity/i);
 assert.equal(await readFile(customer,'utf8'),'preserve');
}));

test('an installation published before its terminal journal record is reused',()=>fixture(async(root,state)=>{
 const pin=(await loadUpstreamLock()).find(r=>r.integrationId==='openwiki')!;
 const op=await prepareSoftwareInstall(root,'openwiki',pin.version,pin.packageIntegrity);
 if('pending' in op||'reused' in op)throw Error('fixture');
 const options={stateRoot:state,authorizationRef:'fixture-approved'};
 await assert.rejects(()=>executeOperation(op,{...options,launch:dispatched=>completeFixtureInstall(root,dispatched),save:async(path,content)=>{
  if(JSON.parse(content).operations[0].stage==='terminal')throw Error('controller lost terminal record');
  await saveDurable(path,content);
 }}),/controller lost terminal record/);
 assert.equal((await queryOperation(op)).status,'done');
 await assert.doesNotReject(()=>assertNoUnknownWriters(root,state));
 const resumed=await executeOperation(op,{...options,launch:async()=>{throw Error('published installation was dispatched twice');}});
 assert.equal(resumed.status,'done');
}));

test('damaged operation records block the writer gate and dispatch',()=>fixture(async(root,state)=>{
 const recipe=(await loadUpstreamLock()).find(r=>r.integrationId==='openwiki')!;
 const op=await prepareSoftwareInstall(root,'openwiki',recipe.version,recipe.packageIntegrity);
 if('pending' in op||'reused' in op)throw Error('fixture');
 const record=state+'/'+signature(root)+'.operations.json';
 let dispatched=0;
 const missingWriter=JSON.stringify({operations:[{root,authorizationRef:'fixture-approved',operation:op,parametersDigest:signature(op),stage:'dispatching'}]});
 for(const invalid of ['{"operations":','{}','{"operations":[{}]}',missingWriter]){
  await writeFile(record,invalid,{mode:0o600});
  await assert.rejects(()=>assertNoUnknownWriters(root,state),/operation record.*reconciliation/i);
  await assert.rejects(()=>executeOperation(op,{stateRoot:state,authorizationRef:'fixture-approved',launch:async()=>{
   dispatched++;return {status:'failed',message:'unexpected dispatch'};
  }}),/operation record.*reconciliation/i);
  assert.equal(await readFile(record,'utf8'),invalid);
 }
 assert.equal(dispatched,0);
}));
