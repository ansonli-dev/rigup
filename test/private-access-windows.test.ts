import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {access,lstat,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,win32} from 'node:path';
import {test} from 'node:test';
import {promisify} from 'node:util';
import {assertPrivateAccess,assertSafeWindowsAncestors,createWindowsPrivateDirectory} from '../src/private-access.js';

const native={skip:process.platform!=='win32'&&'requires native Windows ACLs'};
const exec=promisify(execFile);

async function deepFixture(run:(parent:string)=>Promise<void>){
 const root=await mkdtemp(join(tmpdir(),'rigup-private-acl-'));
 try{
  let parent=root;
  while(parent.length<280)parent=join(parent,'nested-'+String(parent.length)+'-'+'x'.repeat(60));
  await mkdir(parent,{recursive:true});
  await run(parent);
 }finally{await rm(root,{recursive:true,force:true});}
}

async function grant(path:string,rights:string){
 const icacls=join(process.env.SystemRoot??'C:\\Windows','System32','icacls.exe');
 await exec(icacls,[win32.toNamespacedPath(path),'/grant','*S-1-1-0:('+rights+')'],{timeout:15000});
}

function deniedAt(path:string){
 return (error:unknown)=>{
  assert.ok(error instanceof Error);
  assert.match(error.message,/Windows ACL denied untrusted access grant.*S-1-1-0/);
  assert.ok(error.message.includes(path));
  assert.ok(!error.message.includes('\\\\?\\'),'internal extended paths must not enter public denial messages');
  return true;
 };
}

test('Windows creates and verifies private directories and files beyond legacy path limits',native,()=>deepFixture(async parent=>{
 const directory=join(parent,'private'),record=join(directory,'record.json');
 await createWindowsPrivateDirectory(directory,'private directory required');
 await assertPrivateAccess(directory,await lstat(directory),'private directory required');
 await writeFile(record,'{"synthetic":true}\n');
 await assertPrivateAccess(record,await lstat(record),'private record required');
 await assertSafeWindowsAncestors(record,'safe ancestors required');
 assert.equal(await readFile(record,'utf8'),'{"synthetic":true}\n');
}));

test('Windows deep private files still reject public read grants with the original path',native,()=>deepFixture(async parent=>{
 const directory=join(parent,'private'),record=join(directory,'record.json');
 await createWindowsPrivateDirectory(directory,'private directory required');
 await writeFile(record,'synthetic');
 await grant(record,'R');
 await assert.rejects(assertPrivateAccess(record,await lstat(record),'private record required'),deniedAt(record));
 assert.equal(await readFile(record,'utf8'),'synthetic');
}));

test('Windows deep ancestor denials prevent creation and report the original ancestor path',native,()=>deepFixture(async parent=>{
 await grant(parent,'WA');
 const target=join(parent,'must-not-create');
 await assert.rejects(createWindowsPrivateDirectory(target,'private directory required'),deniedAt(parent));
 await assert.rejects(access(target),{code:'ENOENT'});
}));

test('Windows private access rejects namespace and ambiguous paths before launching the ACL worker',async()=>{
 for(const path of ['\\\\?\\C:\\private','\\\\server\\share\\private','C:\\private\\file:stream','C:\\private\\trailing.','C:\\private\\NUL','C:\\private\\question?','C:\\private\\control\0']){
  await assert.rejects(createWindowsPrivateDirectory(path,'private directory required'),/unsafe Windows path/);
 }
});
