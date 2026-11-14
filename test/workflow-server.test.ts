import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {access,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {listenWorkflowServer,closeWorkflowServer} from './workflow-server-support.js';

for(const blocked of [5060,6000,10080])test('workflow listener redraws fetch-blocked port '+blocked,async t=>{
 const server=createServer((_,res)=>res.end('reachable'));
 t.after(()=>{server.closeAllConnections();server.close();});
 const address=server.address.bind(server);let draws=0;
 t.mock.method(server,'address',()=>{
  const actual=address();
  return actual&&typeof actual!=='string'&&draws++===0?{...actual,port:blocked}:actual;
 });
 const url=await listenWorkflowServer(server);
 assert.equal(await (await fetch(url)).text(),'reachable');
 assert.equal(server.listenerCount('error'),0,'completed listen attempts must release their error handlers');
});

test('workflow listener rejects blocked-port exhaustion and releases the last listener',async t=>{
 const server=createServer();
 t.after(()=>server.close());
 const address=server.address.bind(server);let draws=0;
 t.mock.method(server,'address',()=>{
  assert.ok(++draws<=20,'port selection must have a finite attempt bound');
  const actual=address();return actual&&typeof actual!=='string'?{...actual,port:10080}:actual;
 });
 await assert.rejects(listenWorkflowServer(server),/fetch-compatible loopback port/);
 assert.equal(server.listening,false);
 assert.equal(server.listenerCount('error'),0);
});

test('workflow listener propagates bind errors without retry or retained listeners',async t=>{
 const occupied=createServer(),server=createServer();
 t.after(()=>{occupied.close();server.close();});
 const url=await listenWorkflowServer(occupied),port=Number(new URL(url).port);
 const listen=server.listen.bind(server);let attempts=0;
 t.mock.method(server,'listen',(_port:unknown,host:string,ready:()=>void)=>{attempts++;return listen(port,host,ready);});
 await assert.rejects(listenWorkflowServer(server),{code:'EADDRINUSE'});
 assert.equal(attempts,1);
 assert.equal(server.listening,false);
 assert.equal(server.listenerCount('error'),0);
});

for(const keep of [false,true])test('workflow cleanup closes the listener after rejected backend shutdown; keep='+keep,async t=>{
 const control=await mkdtemp(join(tmpdir(),'rigup-close-')),root=join(control,'fixture');
 await mkdir(root);
 const server=createServer((_,res)=>res.end('alive'));
 t.after(async()=>{server.closeAllConnections();server.close();await rm(control,{recursive:true,force:true});});
 const url=await listenWorkflowServer(server),failure=Error('backend shutdown unconfirmed');
 await assert.rejects(closeWorkflowServer(server,async()=>{throw failure;},async()=>{if(!keep)await rm(root,{recursive:true,force:true});}),error=>error===failure);
 assert.equal(server.listening,false,'backend failure must not retain a test-process handle');
 await assert.rejects(fetch(url,{signal:AbortSignal.timeout(2000)}));
 if(keep)await access(root);else await assert.rejects(access(root),{code:'ENOENT'});
});

test('workflow cleanup removes incomplete setup even when the backend rejects',async()=>{
 const server=createServer(),failure=Error('backend shutdown failed');let removed=false;
 await assert.rejects(closeWorkflowServer(server,async()=>{throw failure;},async()=>{removed=true;}),error=>error===failure);
 assert.equal(removed,true);
 assert.equal(server.listening,false);
});

test('workflow cleanup retains both backend and removal failures',async t=>{
 const server=createServer();t.after(()=>server.close());
 await listenWorkflowServer(server);
 const backend=Error('backend shutdown failed'),removal=Error('fixture removal failed');
 await assert.rejects(closeWorkflowServer(server,async()=>{throw backend;},async()=>{throw removal;}),error=>{
  assert.ok(error instanceof AggregateError);assert.deepEqual(error.errors,[backend,removal]);return true;
 });
 assert.equal(server.listening,false);
});
