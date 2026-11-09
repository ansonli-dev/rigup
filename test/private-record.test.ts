import assert from 'node:assert/strict';
import childProcess,{execFile,spawn} from 'node:child_process';
import {once} from 'node:events';
import fs,{access,mkdir,readFile,symlink,writeFile} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {basename,join} from 'node:path';
import {test,type TestContext} from 'node:test';
import {promisify} from 'node:util';
import {privateDirectory,saveCache} from '../src/generator/cache.js';
import {atomicProjectWrite} from '../src/installer/manifest.js';
import {assertSafeWindowsAncestors} from '../src/private-access.js';
import {readPrivateJson,saveDurable} from '../src/private-record.js';
import {project} from './helpers.js';

function usePlatform(t:TestContext,platform:NodeJS.Platform){
 const original=Object.getOwnPropertyDescriptor(process,'platform')!;
 Object.defineProperty(process,'platform',{value:platform});
 t.after(()=>{Object.defineProperty(process,'platform',original);});
}

function useAclWorker(t:TestContext,...responses:Record<string,unknown>[]){
 usePlatform(t,'win32');
 const systemRoot=process.env.SystemRoot;
 process.env.SystemRoot='C:\\Windows';
 const child=spawn(process.execPath,['--input-type=module','--eval',`
  import {createInterface} from 'node:readline';
  const responses=${JSON.stringify(responses)};
  for await(const line of createInterface({input:process.stdin})){
   const {id}=JSON.parse(line);
   const response=responses.length>1?responses.shift():responses[0];
   process.stdout.write(JSON.stringify({id,...response})+'\\n');
  }
 `],{stdio:['pipe','pipe','ignore']});
 const closed=once(child,'close');
 const replacement=t.mock.method(childProcess,'spawn',()=>child);
 syncBuiltinESMExports();
 t.after(async()=>{
  replacement.mock.restore();
  syncBuiltinESMExports();
  if(systemRoot===undefined)delete process.env.SystemRoot;
  else process.env.SystemRoot=systemRoot;
  child.ref();
  child.stdin.end();
  await closed;
 });
}

const deniedAncestor='C:\\private 测试';
const statePath=deniedAncestor+'\\run';
const checkAncestors=()=>assertSafeWindowsAncestors(statePath,'cache requires private permissions');

test('an ACL denial identifies the checked ancestor and untrusted SID',async t=>{
 useAclWorker(t,{status:'denied',reason:'untrusted-grant',path:deniedAncestor,principal:'S-1-1-0'},{status:'ok'});
 await assert.rejects(checkAncestors,error=>{
  assert.ok(error instanceof Error);
  assert.match(error.message,/cache requires private permissions: Windows ACL denied.*untrusted access grant/i);
  assert.ok(error.message.includes(deniedAncestor));
  assert.match(error.message,/S-1-1-0/);
  return true;
 });
});

test('the ACL check retries a sharing violation',async t=>{
 useAclWorker(t,{status:'busy'},{status:'ok'});
 await checkAncestors();
});

test('the ACL check stops retrying a persistent sharing violation',async t=>{
 useAclWorker(t,...Array.from({length:4},()=>({status:'busy'})),{status:'ok'});
 await assert.rejects(checkAncestors,/Windows ACL I\/O failed.*(?:sharing|lock)/i);
});

test('unclassified ACL I/O failure closes the gate immediately',async t=>{
 useAclWorker(t,{status:'io-error',detail:'private diagnostic'}, {status:'ok'});
 await assert.rejects(checkAncestors,error=>{
  assert.ok(error instanceof Error);
  assert.match(error.message,/Windows ACL I\/O failed/i);
  assert.doesNotMatch(error.message,/private diagnostic/);
  return true;
 });
});

test('an invalid ACL worker response closes the gate without exposing its content',async t=>{
 useAclWorker(t,{status:'private diagnostic'});
 await assert.rejects(checkAncestors,error=>{
  assert.ok(error instanceof Error);
  assert.match(error.message,/Windows ACL worker unavailable/i);
  assert.doesNotMatch(error.message,/private diagnostic/);
  return true;
 });
});

function interceptRename(t:TestContext,platform:NodeJS.Platform,rename:typeof fs.rename){
 usePlatform(t,platform);
 const replacement=t.mock.method(fs,'rename',rename);
 syncBuiltinESMExports();
 t.after(()=>{replacement.mock.restore();syncBuiltinESMExports();});
}

test('Windows atomic writers publish distinct replacements after transient rename failures',t=>project(async root=>{
 const durable=join(root,'durable.json'),cache=join(root,'cache.json'),manifest=join(root,'manifest.json');
 const originalRename=fs.rename;
 const pendingFailures=new Map<string,string>();
 interceptRename(t,'win32',async(source,target)=>{
  const code=pendingFailures.get(String(target));
  if(code){pendingFailures.delete(String(target));throw Object.assign(new Error('file temporarily busy'),{code});}
  await originalRename(source,target);
 });
 for(const [path,code,write] of [
  [durable,'EPERM',(content:string)=>saveDurable(durable,content)],
  [cache,'EACCES',(content:string)=>saveCache(cache,content)],
  [manifest,'EBUSY',(content:string)=>atomicProjectWrite(root,'manifest.json',Buffer.from(content))],
 ] as const){
  await write('first');
  pendingFailures.set(path,code);
  await write('second');
  assert.equal(await readFile(path,'utf8'),'second');
 }
 assert.equal(pendingFailures.size,0);
}));

test('project rename retry refuses a redirected parent and preserves unrelated files',t=>project(async root=>{
 const parent=join(root,'target');
 const relocated=join(root,'relocated');
 const substitute=join(root,'substitute');
 await mkdir(parent);
 await mkdir(substitute);
 await writeFile(join(parent,'manifest.json'),'first');
 const originalRename=fs.rename;
 let unrelatedTemporary='';
 interceptRename(t,'win32',async source=>{
  await originalRename(parent,relocated);
  await symlink(substitute,parent,'junction');
  unrelatedTemporary=join(substitute,basename(String(source)));
  await writeFile(unrelatedTemporary,'unrelated');
  throw Object.assign(new Error('file temporarily busy'),{code:'EBUSY'});
 });
 await assert.rejects(atomicProjectWrite(root,'target/manifest.json',Buffer.from('second')),/target symlink denied/);
 assert.equal(await readFile(unrelatedTemporary,'utf8'),'unrelated');
 assert.equal(await readFile(join(relocated,'manifest.json'),'utf8'),'first');
}));

for(const [platform,code,maxAttempts] of [
 ['win32','ENOENT',1],['linux','EPERM',1],['win32','EPERM',5],
] as const){
 test(`${platform} durable rename reports the original ${code} after ${maxAttempts} attempt(s)`,t=>project(async root=>{
  const path=join(root,'state.json');
  await saveDurable(path,'first');
  const originalError=Object.assign(new Error('rename failed'),{code});
  const originalRename=fs.rename;
  let attempts=0;
  interceptRename(t,platform,async(source,target)=>{
   if(++attempts<=maxAttempts)throw originalError;
   await originalRename(source,target);
  });
  await assert.rejects(saveDurable(path,'second'),error=>error===originalError);
  assert.equal(attempts,maxAttempts);
  assert.equal(await readFile(path,'utf8'),'first');
 }));
}

test('Windows private state rejects an NTFS grant to Everyone', {
 skip: process.platform !== 'win32' && 'requires NTFS access control',
}, () => project(root => project(async cache => {
 const icacls = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe');
 const state = await privateDirectory(join(cache, 'new state 测试', 'nested'), root);
 const record = join(state, 'record.json');
 await writeFile(record, '{"fixture":true}', {mode: 0o600});
 assert.deepEqual(await readPrivateJson(record), {fixture:true});

 await promisify(execFile)(icacls, [record, '/grant', '*S-1-1-0:(R)']);
 await assert.rejects(readPrivateJson(record),error=>{
  assert.ok(error instanceof Error);
  assert.match(error.message,/not private: Windows ACL denied.*S-1-1-0/i);
  assert.ok(error.message.includes(record));
  return true;
 });

 await promisify(execFile)(icacls, [state, '/grant', '*S-1-1-0:(RX)']);
 await assert.rejects(privateDirectory(state, root), /private permissions/);

 const ancestor = join(cache, 'replaceable parent');
 await mkdir(ancestor);
 await promisify(execFile)(icacls, [ancestor, '/grant', '*S-1-1-0:(WA)']);
 const nested = join(ancestor, 'must not create');
 await assert.rejects(privateDirectory(nested, root),error=>{
  assert.ok(error instanceof Error);
  assert.match(error.message,/private permissions: Windows ACL denied.*S-1-1-0/i);
  assert.ok(error.message.includes(ancestor));
  return true;
 });
 await assert.rejects(access(nested), {code:'ENOENT'});
 await assert.rejects(privateDirectory(join(cache,'ambiguous '),root), /unsafe Windows path/);
})));
