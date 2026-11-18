import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import fs,{access,mkdir,readFile,readdir,symlink,writeFile} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {basename,join} from 'node:path';
import {test,type TestContext} from 'node:test';
import {promisify} from 'node:util';
import {privateDirectory,saveCache} from '../src/generator/cache.js';
import {readFileState} from '../src/installer/file-state.js';
import {atomicProjectWrite} from '../src/installer/manifest.js';
import {readPrivateJson,saveDurable} from '../src/private-record.js';
import {project} from './helpers.js';

function usePlatform(t:TestContext,platform:NodeJS.Platform){
 const original=Object.getOwnPropertyDescriptor(process,'platform')!;
 Object.defineProperty(process,'platform',{value:platform});
 t.after(()=>{Object.defineProperty(process,'platform',original);});
}

test('private cache follows a directory alias outside the project and refuses its in-project destination',()=>project(root=>project(async cache=>{
 const external=join(cache,'real'),alias=join(cache,'alias'),projectAlias=join(cache,'project alias');
 await mkdir(external);
 await symlink(external,alias,process.platform==='win32'?'junction':'dir');
 await symlink(root,projectAlias,process.platform==='win32'?'junction':'dir');
 assert.equal(await privateDirectory(join(alias,'cache'),root),join(external,'cache'));
 await assert.rejects(privateDirectory(join(projectAlias,'must-not-create'),root),/outside project/);
 await assert.rejects(access(join(root,'must-not-create')),{code:'ENOENT'});
})));

test('malformed private records report their path without the file contents',()=>project(async cache=>{
 const path=join(cache,'review.json');
 assert.equal(await readPrivateJson(path),undefined);
 await writeFile(path,'invalid secret fixture',{mode:0o600});
 await assert.rejects(readPrivateJson(path),error=>{
  assert.ok(error instanceof SyntaxError);
  assert.ok(error.message.includes(path));
  assert.doesNotMatch(error.message,/secret fixture/);
  return true;
 });
}));

function interceptRename(t:TestContext,platform:NodeJS.Platform,rename:typeof fs.rename){
 usePlatform(t,platform);
 const replacement=t.mock.method(fs,'rename',rename);
 syncBuiltinESMExports();
 t.after(()=>{replacement.mock.restore();syncBuiltinESMExports();});
}

// These portable race tests spoof Windows retry behavior, so request the mode
// Windows actually exposes. Native NTFS tests separately cover private ACLs.
const renameFixtureMode=0o666;

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
  [manifest,'EBUSY',(content:string)=>atomicProjectWrite(root,'manifest.json',Buffer.from(content),renameFixtureMode)],
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
 await assert.rejects(atomicProjectWrite(root,'target/manifest.json',Buffer.from('second'),renameFixtureMode),/target symlink denied/);
 assert.equal(await readFile(unrelatedTemporary,'utf8'),'unrelated');
 assert.equal(await readFile(join(relocated,'manifest.json'),'utf8'),'first');
}));

test('a transient project rename does not overwrite a destination edited before retry',t=>project(async root=>{
 const destination=join(root,'manifest.json');
 await writeFile(destination,'approved content');
 const approved=await readFileState(root,'manifest.json');
 const originalRename=fs.rename;
 let blocked=false;
 interceptRename(t,'win32',async(source,target)=>{
  if(!blocked){
   blocked=true;
   await writeFile(destination,'intervening edit');
   throw Object.assign(Error('file temporarily busy'),{code:'EPERM'});
  }
  await originalRename(source,target);
 });
 await assert.rejects(atomicProjectWrite(root,'manifest.json',Buffer.from('replacement'),renameFixtureMode,false,async()=>{
  const current=await readFileState(root,'manifest.json');
  if(current.digest!==approved.digest||current.mode!==approved.mode)throw Error('destination changed since approval');
 }),/destination changed since approval/);
 assert.equal(await readFile(destination,'utf8'),'intervening edit');
 assert.deepEqual(await readdir(root),['manifest.json']);
}));

test('project rename retry and cleanup preserve a replaced regular parent directory',t=>project(async root=>{
 const parent=join(root,'target'),relocated=join(root,'relocated');
 const destination=join(parent,'manifest.json');
 await mkdir(parent);
 await writeFile(destination,'approved content');
 const originalRename=fs.rename;
 let unrelatedTemporary='';
 interceptRename(t,'win32',async(source,target)=>{
  if(!unrelatedTemporary){
   await originalRename(parent,relocated);
   await mkdir(parent);
   await writeFile(destination,'replacement directory content');
   unrelatedTemporary=join(parent,basename(String(source)));
   await writeFile(unrelatedTemporary,'unrelated');
   throw Object.assign(Error('file temporarily busy'),{code:'EPERM'});
  }
  await originalRename(source,target);
 });
 await assert.rejects(atomicProjectWrite(root,'target/manifest.json',Buffer.from('replacement'),renameFixtureMode),/target parent changed/);
 assert.equal(await readFile(destination,'utf8'),'replacement directory content');
 assert.equal(await readFile(unrelatedTemporary,'utf8'),'unrelated');
 assert.equal(await readFile(join(relocated,'manifest.json'),'utf8'),'approved content');
}));

test('an exclusive project write checks approved state before creating the link',()=>project(async root=>{
 await assert.rejects(atomicProjectWrite(root,'new.json',Buffer.from('replacement'),0o644,true,async()=>{
  throw Error('approval no longer current');
 }),/approval no longer current/);
 assert.deepEqual(await readdir(root),[]);
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

test('private record I/O works in a normal Windows folder with inherited permissions',{
 skip:process.platform!=='win32',
},()=>project(root=>project(async cache=>{
 const icacls=join(process.env.SystemRoot??'C:\\Windows','System32','icacls.exe');
 const parent=join(cache,'shared parent'),state=join(parent,'existing cache');
 await mkdir(parent);
 await promisify(execFile)(icacls,[parent,'/grant','*S-1-1-0:(OI)(CI)(RX)']);
 await mkdir(state);
 assert.equal(await privateDirectory(state,root),state);
 const record=join(state,'preview.json');
 await saveDurable(record,'{"test":true}');
 assert.deepEqual(await readPrivateJson(record),{test:true});
})));
