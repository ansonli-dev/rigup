import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs,{mkdir,readdir,readFile,lstat,writeFile} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join} from 'node:path';
import {harnessPlan,project} from './helpers.js';
import {preview} from '../src/installer/preview.js';
import {apply} from '../src/installer/apply.js';
import {scanRepository} from '../src/analyzer/repository.js';
import {applyRecordPath,loadManifest} from '../src/installer/baseline.js';
import {atomicProjectWrite} from '../src/installer/manifest.js';
import {readRuntimeFile,writeRuntimeFile} from '../src/runtime-private-env.js';
import {windowsPowerShellExecutable} from '../src/integrations/tools/windows-process.mjs';

test('ordinary writes record the mode a filesystem can retain before rename and resume without a rewrite',{
 skip:process.platform==='win32',
},t=>project(root=>project(cacheRoot=>project(async stateRoot=>{
 const options={agents:[],backend:'host' as const};
 const generate=async()=>({
  root,fingerprint:(await scanRepository(root,options)).fingerprint,options,
  assets:[{logicalId:'managed',target:'managed.txt',content:'managed\n',mode:0o640,ownership:{kind:'file' as const},source:{kind:'configuration',ref:'fixture'}}],
  dispositions:[],operations:[],warnings:[],requirements:[],versions:{},
 });
 const original=fs.open;
 let stages=0;
 const useActualMode=t.mock.method(fs,'open',async(path,flags,mode)=>{
  if(typeof path!=='string'||!path.includes('managed.txt.rigup-'))return original(path,flags,mode);
  stages++;
  const handle=await original(path,flags,0o644);
  handle.chmod=async()=>{throw Object.assign(Error('mode metadata unsupported'),{code:'ENOTSUP'});};
  return handle;
 });
 syncBuiltinESMExports();
 t.after(()=>{useActualMode.mock.restore();syncBuiltinESMExports();});
 const approved=await preview(await generate(),[],{cacheRoot});
 assert.equal(approved.executable,true);
 await assert.rejects(apply(approved.previewId,{cacheRoot,stateRoot,hook:async point=>{
  if(point==='after-file')throw Error('power loss after rename');
 }}),/power loss after rename/);
 const actual=await lstat(join(root,'managed.txt'));
 const effective=actual.mode&0o777;
 assert.notEqual(effective,0o640);
 const {files}=JSON.parse(await readFile(applyRecordPath(root,stateRoot),'utf8'));
 assert.equal(files['managed.txt'].effectiveAfterMode,effective);
 assert.equal((await apply(approved.previewId,{cacheRoot,stateRoot,recover:true})).status,'complete');
 const manifest=await loadManifest(root);assert.ok(manifest);
 const next=await preview({...await generate(),dispositions:[{logicalId:'managed',action:'retain',reason:'unchanged'}]},[],{cacheRoot});
 assert.equal(next.executable,true);
 assert.deepEqual((await apply(next.previewId,{cacheRoot,stateRoot})).written,[]);
 assert.equal(stages,1);
 assert.equal(await readFile(join(root,'managed.txt'),'utf8'),'managed\n');
}))));

test('unsupported exclusive creation identifies the target and preserves user files',t=>project(async root=>{
 const original=fs.link;
 const injected=t.mock.method(fs,'link',async(source,target)=>{
  if(String(target).endsWith('user.json'))await writeFile(target,'user content',{flag:'wx'});
  throw Object.assign(Error('no hard links'),{code:'ENOTSUP'});
 });
 syncBuiltinESMExports();
 t.after(()=>{injected.mock.restore();assert.equal(fs.link,original);syncBuiltinESMExports();});
 for(const target of ['user.json','absent.json']){
  await assert.rejects(atomicProjectWrite(root,target,Buffer.from('managed'),0o644,true),
   error=>error instanceof Error&&error.message.includes(target));
 }
 assert.equal(await readFile(join(root,'user.json'),'utf8'),'user content');
 assert.deepEqual(await readdir(root),['user.json']);
}));

test('unavailable hard links leave an approved seed resumable',t=>project(root=>project(cacheRoot=>project(async stateRoot=>{
 const settings={agents:['codex' as const],backend:'host' as const,projectRules:true,projectConventions:{topics:[{id:'api-errors',title:'API errors',scope:['.']}]}};
 const approved=await preview(await harnessPlan(root,cacheRoot,settings),[],{cacheRoot,stateRoot});
 const target=approved.projectDocuments![0].target;
 const original=fs.link;
 const injected=t.mock.method(fs,'link',async(source,destination)=>{
  if(String(destination)===join(root,target))throw Object.assign(Error('no hard links'),{code:'ENOTSUP'});
  return original(source,destination);
 });
 syncBuiltinESMExports();
 try{
  await assert.rejects(apply(approved.previewId,{cacheRoot,stateRoot}),error=>
   error instanceof Error&&error.message.includes(target));
  await assert.rejects(readFile(join(root,target)),{code:'ENOENT'});
 }finally{injected.mock.restore();syncBuiltinESMExports();}
 assert.equal((await apply(approved.previewId,{cacheRoot,stateRoot,recover:true})).status,'complete');
 assert.equal((await loadManifest(root))?.seededProjectDocuments?.[0].target,target);
}))));

test('Windows locks down only the private credential file before publishing it',{
 skip:process.platform!=='win32',
},()=>project(async root=>{
 const directory=join(root,'.rigup'),path=join(directory,'.env');
 await mkdir(directory);
 await writeFile(join(directory,'.gitignore'),'/.env\n/.env.rigup-*.tmp\n');
 const exec=promisify(execFile);
 const icacls=join(process.env.SystemRoot!,'System32','icacls.exe');
 await exec(icacls,[directory,'/grant','*S-1-1-0:(OI)(CI)(RX)']);
 const acl=async(target:string)=>(await exec(windowsPowerShellExecutable(),['-NoProfile','-NonInteractive','-Command',
  '(Get-Acl -LiteralPath $env:RIGUP_ACL_TEST).GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]).IdentityReference.Value'],
 {timeout:15000,env:{...process.env,RIGUP_ACL_TEST:target}})).stdout;
 const before=await acl(directory);
 assert.match(before,/S-1-1-0/);
 await writeRuntimeFile(root,await readRuntimeFile(root),'SYNTHETIC_FIXTURE=held\n');
 assert.equal(await readFile(path,'utf8'),'SYNTHETIC_FIXTURE=held\n');
 assert.equal(await acl(directory),before);
 assert.doesNotMatch(await acl(path),/S-1-1-0/);
 assert.deepEqual((await readdir(directory)).sort(),['.env','.gitignore']);
}));
