import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readdir,readFile,lstat} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join} from 'node:path';
import {project} from './helpers.js';
import {preview} from '../src/installer/preview.js';
import {apply} from '../src/installer/apply.js';
import {scanRepository} from '../src/analyzer/repository.js';
import {applyRecordPath} from '../src/installer/baseline.js';
import {atomicProjectWrite} from '../src/installer/manifest.js';
import {assertPrivateAccess} from '../src/private-access.js';
import {windowsPowerShellExecutable} from '../src/integrations/tools/windows-process.mjs';

test('mode preflight covers existing target parents and leaves only the original tree',()=>project(async root=>{
 const module=await import('../src/installer/filesystem-modes.js').catch(()=>undefined);
 assert.ok(module,'filesystem mode preflight is required');
 await mkdir(join(root,'separate'));const before=await readdir(root),inside=await readdir(join(root,'separate'));
 await module.assertSupportedFileModes(root,[{target:'new/file',mode:0o644},{target:'separate/file',mode:0o755}]);
 assert.deepEqual(await readdir(root),before);assert.deepEqual(await readdir(join(root,'separate')),inside);
 const checked:{parent:string;mode:number}[]=[];
 await module.assertSupportedFileModes(root,[{target:'new/file',mode:0o644},{target:'separate/file',mode:0o755}],async(parent,mode)=>{checked.push({parent,mode});return process.platform==='win32'?0o666:mode;});
 assert.ok(checked.some(item=>item.parent===root&&item.mode===0o600));
 assert.ok(checked.some(item=>item.parent===join(root,'separate')&&item.mode===0o755));
}));
test('unsupported permissions give requested and observed modes with actionable mount guidance',()=>project(async root=>{
 const module=await import('../src/installer/filesystem-modes.js').catch(()=>undefined);
 assert.ok(module,'filesystem mode preflight is required');
 await assert.rejects(module.assertSupportedFileModes(root,[{target:'next',mode:0o644}],async()=>0o777),error=>{
  const message=String(error);assert.match(message,/0644|0600/);assert.match(message,/0777/);assert.ok(message.includes(root));assert.match(message,/metadata/);assert.match(message,/Linux home/);return true;
 });
}));
async function fixture(run:(root:string,cacheRoot:string,stateRoot:string,id:string)=>Promise<void>){
 await project(root=>project(cacheRoot=>project(async stateRoot=>{
  const options={agents:[],backend:'host' as const};
  const plan={root,fingerprint:(await scanRepository(root,options)).fingerprint,options,assets:[{logicalId:'test-file',target:'managed.txt',content:'managed\n',ownership:{kind:'file' as const},source:{kind:'configuration',ref:'fixture'}}],dispositions:[],operations:[],warnings:[],requirements:[],versions:{}};
  const approved=await preview(plan,[],{cacheRoot});await run(root,cacheRoot,stateRoot,approved.previewId);
 })));
}
test('apply rejects a failing mode preflight before files or a prepared transaction are written',()=>fixture(async(root,cacheRoot,stateRoot,id)=>{
 let invoked=false;
 await assert.rejects(apply(id,{cacheRoot,stateRoot,fileModes:async()=>{invoked=true;throw Error('unsupported mount');}}),/unsupported mount/);
 assert.equal(invoked,true);assert.deepEqual(await readdir(root),[]);
 await assert.rejects(readFile(applyRecordPath(root,stateRoot)),{code:'ENOENT'});
}));
test('unsupported interrupted apply preserves its existing file and journal bytes',()=>fixture(async(root,cacheRoot,stateRoot,id)=>{
 await assert.rejects(apply(id,{cacheRoot,stateRoot,hook:async point=>{if(point==='after-file')throw Error('power loss');}}),/power loss/);
 const path=applyRecordPath(root,stateRoot),journal=await readFile(path),bytes=await readFile(join(root,'managed.txt'));
 await assert.rejects(apply(id,{cacheRoot,stateRoot,recover:true,fileModes:async()=>{throw Error('unsupported mount');}}),/unsupported mount/);
 assert.deepEqual(await readFile(path),journal);assert.deepEqual(await readFile(join(root,'managed.txt')),bytes);
 assert.equal((await apply(id,{cacheRoot,stateRoot,recover:true})).status,'complete');
}));
test('Windows private project records exclude inherited public read permissions from creation',{skip:process.platform!=='win32'},()=>project(async root=>{
 const script="$ErrorActionPreference='Stop';$acl=[IO.Directory]::GetAccessControl($env:RIGUP_ACL_FIXTURE);$sid=[Security.Principal.SecurityIdentifier]::new('S-1-5-32-545');$rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow');$acl.AddAccessRule($rule);[IO.Directory]::SetAccessControl($env:RIGUP_ACL_FIXTURE,$acl)";
 await promisify(execFile)(windowsPowerShellExecutable(),['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{env:{...process.env,RIGUP_ACL_FIXTURE:root},timeout:15000});
 await atomicProjectWrite(root,'.rigup/private.json',Buffer.from('{"private":"synthetic"}\n'),0o600,true);
 const path=join(root,'.rigup/private.json');await assertPrivateAccess(path,await lstat(path),'private record is readable by another principal');
 assert.equal(await readFile(path,'utf8'),'{"private":"synthetic"}\n');
 assert.deepEqual(await readdir(join(root,'.rigup')),['private.json']);
}));
