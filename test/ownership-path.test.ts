import assert from 'node:assert/strict';
import fs,{lstat,readFile,readdir,symlink,writeFile} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {join} from 'node:path';
import {test} from 'node:test';
import {runCli} from '../src/cli.js';
import {loadManifest} from '../src/installer/baseline.js';
import {doctor} from '../src/installer/doctor.js';
import {atomicProjectWrite} from '../src/installer/manifest.js';
import {project} from './helpers.js';

const originalManifest='{"schemaVersion":1,"installId":"linked-project","assets":[]}';
const linkDiagnostic=/\.rigup.*(?:junction|reparse point|symbolic link).*preserve.*regular directory.*retry/i;

async function linkedRigup(run:(root:string,outside:string)=>Promise<void>){
 await project(async root=>project(async outside=>{
  await writeFile(join(outside,'manifest.json'),originalManifest);
  await symlink(outside,join(root,'.rigup'),process.platform==='win32'?'junction':'dir');
  await run(root,outside);
 }));
}

test('a linked project metadata directory blocks reads, writes and direct doctor checks',()=>linkedRigup(async(root,outside)=>{
 await assert.rejects(()=>loadManifest(root),linkDiagnostic);
 await assert.rejects(()=>atomicProjectWrite(root,'.rigup/manifest.json',Buffer.from('replacement')),linkDiagnostic);
 const report=await doctor(root);
 assert.equal(report.exitCode,1);
 assert.match(report.diagnostics[0].reason,linkDiagnostic);
 assert.ok((await lstat(join(root,'.rigup'))).isSymbolicLink());
 assert.deepEqual(await readdir(outside),['manifest.json']);
 assert.equal(await readFile(join(outside,'manifest.json'),'utf8'),originalManifest);
}));

test('a linked project metadata directory gets actionable CLI errors',()=>linkedRigup(async root=>{
 for(const command of ['init','doctor']){
  let output='';
  const code=await runCli([command,'--json'],{cwd:root,isTTY:false,write:text=>output+=text});
  assert.equal(code,1);
  assert.match(JSON.parse(output).error,linkDiagnostic);
 }
}));

test('ordinary permission failures retain their identity at the manifest boundary',t=>project(async root=>{
 const original=fs.lstat;
 const denied=Object.assign(Error('permission denied'),{code:'EACCES'});
 const mock=t.mock.method(fs,'lstat',async (...args:Parameters<typeof fs.lstat>)=>{
  if(args[0]===join(root,'.rigup'))throw denied;
  return original(...args);
 });
 syncBuiltinESMExports();
 try{
  await assert.rejects(()=>loadManifest(root),error=>error===denied);
  const report=await doctor(root);
  assert.equal(report.exitCode,1);
  assert.doesNotMatch(report.diagnostics[0].reason,linkDiagnostic);
 }finally{mock.mock.restore();syncBuiltinESMExports();}
}));
