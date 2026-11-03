import {test} from 'node:test';import assert from 'node:assert/strict';
import {loadUpstreamLock} from '../src/integrations/registry.js';
import {project} from './helpers.js';import {acquireLock} from '../src/installer/lock.js';
import {executeOperation} from '../src/installer/operations.js';import {prepareSoftwareInstall} from '../src/integrations/tools/software.js';
import {mkdir,writeFile,readFile,symlink,chmod} from 'node:fs/promises';
async function fixture(fn:(root:string,state:string)=>Promise<void>){await project(async root=>project(async state=>fn(root,state)));}
test('same_target_lock_prevents_second_apply',()=>fixture(async(root,state)=>{
 const first=await acquireLock(root,{stateRoot:state});try{await assert.rejects(()=>acquireLock(root,{stateRoot:state}),/locked|occupied/);}finally{await first.release();}const next=await acquireLock(root,{stateRoot:state});await next.release();
}));
test('pending_record_is_durable_before_dispatch',()=>fixture(async(root,state)=>{
 const op=await prepareSoftwareInstall(root,'openwiki','0.7.3',(await loadUpstreamLock()).find(r=>r.integrationId==='openwiki')!.packageIntegrity);if('pending' in op||'reused' in op)throw Error('fixture');let dispatched=0;
 await assert.rejects(()=>executeOperation(op,{stateRoot:state,authorizationRef:'fixture-approved',save:async()=>{throw Error('state unavailable');},launch:async()=>{dispatched++;return {status:'done',message:'fake'};}}),/state unavailable/);assert.equal(dispatched,0);
}));
test('unsupported_remote_operation_is_not_dispatched_or_retried',()=>fixture(async(root,state)=>{
 const op=await prepareSoftwareInstall(root,'openwiki','0.7.3',(await loadUpstreamLock()).find(r=>r.integrationId==='openwiki')!.packageIntegrity);if('pending' in op||'reused' in op)throw Error('fixture');const r=await executeOperation({...op,integrationId:'unknown-remote'},{stateRoot:state});assert.equal(r.status,'pending');
}));
import {pendingOperations,assertNoUnknownWriters} from '../src/installer/operations.js';
import {signature} from '../src/generator/cache.js';
test('crash_after_acceptance_reconciles_without_recreate_even_if_cache_is_lost',()=>fixture(async(root,state)=>{
 const integrity=(await loadUpstreamLock()).find(r=>r.integrationId==='openwiki')!.packageIntegrity!;const op=await prepareSoftwareInstall(root,'openwiki','0.7.3',integrity);if('pending' in op||'reused' in op)throw Error('fixture');let creates=0;
 const launch=async()=>{creates++;const prefix=root+'/.rigup/tools/openwiki';await mkdir(prefix+'/node_modules/openwiki',{recursive:true});await writeFile(prefix+'/node_modules/openwiki/package.json',JSON.stringify({name:'openwiki',version:'0.7.3',bin:{openwiki:'cli.js'}}));await writeFile(prefix+'/node_modules/openwiki/cli.js','#!/usr/bin/env node\n');await chmod(prefix+'/node_modules/openwiki/cli.js',0o755);await mkdir(prefix+'/node_modules/.bin');await symlink('../openwiki/cli.js',prefix+'/node_modules/.bin/openwiki');await writeFile(prefix+'/package-lock.json',JSON.stringify({packages:{'':{dependencies:{openwiki:'0.7.3'}},'node_modules/openwiki':{version:'0.7.3',integrity}}}));throw Error('controller crashed after acceptance');};
 await assert.rejects(()=>executeOperation(op,{stateRoot:state,authorizationRef:'fixture-approved',launch}),/crashed/);const pending=await pendingOperations(root,state);assert.equal(pending[0].stage,'dispatching');
 const result=await executeOperation(op,{stateRoot:state,authorizationRef:'fixture-approved',launch});assert.equal(result.status,'done');assert.equal(creates,1);
}));
test('unconfirmed_process_exit_keeps_project_blocked',()=>fixture(async(root,state)=>{
 const integrity=(await loadUpstreamLock()).find(r=>r.integrationId==='openwiki')!.packageIntegrity!;const op=await prepareSoftwareInstall(root,'openwiki','0.7.3',integrity);if('pending' in op||'reused' in op)throw Error('fixture');
 const {processIdentity}=await import('../src/installer/lock.js');const identity=await processIdentity(process.pid);await writeFile(state+'/'+signature(root)+'.operations.json',JSON.stringify({operations:[{operation:op,parametersDigest:signature(op),stage:'dispatching',identity}]}),{mode:0o600});
 await assert.rejects(()=>assertNoUnknownWriters(root,state),/active|blocked/);const r=await executeOperation(op,{stateRoot:state,authorizationRef:'fixture-approved'});assert.equal(r.status,'unknown');
}));
