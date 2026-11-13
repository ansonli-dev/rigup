import {test} from 'node:test';
import assert from 'node:assert/strict';
import {appendFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createWorkflowFixture} from './workflow-fixture-support.js';

test('workflow HTTP origin transfers real commits and retains the receive hook evidence',async()=>{
 const fixture=await createWorkflowFixture({gitTransport:'http'});
 try{
  const origin=(await fixture.git(['remote','get-url','origin'])).trim();
  assert.equal(origin,fixture.url+'/origin.git');
  const before=await fixture.head();
  await writeFile(join(fixture.root,'src/greet.js'),'export function greet(name) { const value=name.trim(); if(!value)throw new TypeError("Name required"); return "Hello, "+value; }\n// 非 ASCII pack content\n');
  await fixture.git(['add','src/greet.js']);await fixture.git(['commit','-qm','Exercise actual HTTP receive-pack']);
  const local=(await fixture.git(['rev-parse','HEAD'])).trim();
  await fixture.git(['push','-q','origin','main']);
  assert.notEqual(local,before);assert.equal(await fixture.head(),local);
  const pushes=fixture.events.filter(event=>event.kind==='push');
  assert.equal(pushes.at(-1)?.base,before);assert.equal(pushes.at(-1)?.head,local);
  assert.equal((await fixture.snapshot()).head,local);
 }finally{await fixture.close();}
});

test('workflow HTTP origin restricts routes and closes its server',async()=>{
 const fixture=await createWorkflowFixture({gitTransport:'http'});let closed=false;
 try{
  assert.equal((await fixture.git(['remote','get-url','origin'])).trim(),fixture.url+'/origin.git');
  const before=await fixture.head();
  for(const suffix of ['/other.git/info/refs?service=git-receive-pack','/origin.git/info/refs?service=unknown','/origin.git/HEAD','/origin.git/../home/no-global-config']){
   const response=await fetch(fixture.url+suffix,{signal:AbortSignal.timeout(2000)});
   assert.ok([401,404,405].includes(response.status),'foreign repositories, files and services must not reach Git');
  }
  assert.equal(await fixture.head(),before);
  await fixture.close();closed=true;
  await assert.rejects(fetch(fixture.url+'/origin.git/info/refs?service=git-receive-pack',{signal:AbortSignal.timeout(2000)}));
 }finally{if(!closed)await fixture.close();}
});

test('workflow HTTP failure retains the client error and non-timeout backend evidence',async()=>{
 const fixture=await createWorkflowFixture({gitTransport:'http'});
 try{
  await appendFile(join(fixture.remote,'config'),'\n[invalid fixture config\n');
  await assert.rejects(fixture.git(['push','origin','HEAD:main']),error=>{
   const message=(error as Error).message;
   assert.match(message,/returned error: 500|remote end hung up/);
   assert.match(message,/timedOut.*false/);
   assert.match(message,/bad config|bad configuration/i);
   assert.match(message,/exitCode.*0/);
   assert.match(message,/httpStatus.*500/);
   assert.match(message,/"code":128/);
   assert.ok(!message.includes(fixture.control),'scratch paths must be sanitized');
   return true;
  });
 }finally{await fixture.close();}
});
