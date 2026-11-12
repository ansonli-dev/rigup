import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {chmod,lstat,mkdir,mkdtemp,readFile,readdir,realpath,rm,statfs,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {apply} from '../dist/installer/apply.js';
import {applyRecordPath} from '../dist/installer/baseline.js';
import {assertSupportedFileModes} from '../dist/installer/filesystem-modes.js';
import {preview} from '../dist/installer/preview.js';
import {scanRepository} from '../dist/analyzer/repository.js';
import {readRuntimeFile,writeRuntimeFile} from '../dist/runtime-private-env.js';

// This is a real WSL2 integration probe. Ordinary Linux and injected modes cannot
// satisfy its environment checks. All values written below are synthetic.
assert.equal(process.platform,'linux');
const kernel=(await readFile('/proc/sys/kernel/osrelease','utf8')).trim();
assert.match(kernel,/microsoft.*WSL2/i);
assert.equal(process.getuid(),0,'the isolated distro needs root only to mount its test drive');
const windowsRoot=await realpath(process.argv[2]);
const drive=/^\/mnt\/([a-z])\/(.+)$/.exec(windowsRoot);
assert.ok(drive,'use wslpath for the dedicated Windows fixture directory');
assert.match(windowsRoot,/\/rigup-wsl-[a-f0-9]{32}\/fixtures$/,'only a unique runner-owned fixture directory may be used');
assert.deepEqual(await readdir(windowsRoot),[],'the fixture directory must start empty');
const output=process.argv[3];
assert.ok(output);
const control=await mkdtemp('/tmp/rigup-wsl2-');
assert.equal((await statfs(control)).type,0xef53,'control and native fixtures must use the WSL2 ext4 filesystem');
const mount=join(control,'drive');
await mkdir(mount);
const mountedRoot=join(mount,drive[2]);
const report={sourceCommit:process.env.RIGUP_SOURCE_COMMIT,kernel,node:process.version,platform:process.platform,arch:process.arch,modelRequests:0,cases:[],cleanup:false};
assert.match(report.sourceCommit??'',/^[a-f0-9]{40}$/,'record the exact tested source commit');
let mounted=false;
function mountDrive(metadata){
 if(mounted){execFileSync('umount',[mount]);mounted=false;}
 execFileSync('mount',['-t','drvfs',drive[1].toUpperCase()+':',mount,...(metadata?['-o','metadata']:[])]);
 mounted=true;
}
async function tree(root){
 const values=[];
 async function visit(path,relative){
  const info=await lstat(path);
  if(info.isDirectory()){
   values.push([relative,'directory']);
   for(const name of (await readdir(path)).sort())await visit(join(path,name),relative+'/'+name);
  }else{assert.ok(info.isFile());values.push([relative,createHash('sha256').update(await readFile(path)).digest('hex')]);}
 }
 await visit(root,'.');return values;
}
async function fixture(parent,name){
 const root=join(parent,name);await mkdir(root,{mode:0o700});await chmod(root,0o700);
 const cacheRoot=await mkdtemp(join(control,'cache-')),stateRoot=await mkdtemp(join(control,'state-'));
 const options={agents:[],backend:'host'};
 const plan={root,fingerprint:(await scanRepository(root,options)).fingerprint,options,
  assets:[['managed.txt','managed\n',0o644],['run.sh','#!/bin/sh\nexit 0\n',0o755]].map(([target,content,mode])=>({logicalId:target,target,content,mode,ownership:{kind:'file'},source:{kind:'configuration',ref:'wsl-fixture'}})),
  dispositions:[],operations:[],warnings:[],requirements:[],versions:{}};
 const approved=await preview(plan,[],{cacheRoot,stateRoot});assert.equal(approved.executable,true);
 return {root,cacheRoot,stateRoot,previewId:approved.previewId};
}
const guidance=/cannot retain requested mode.*observed.*Linux home.*metadata.*Preserve the interrupted installation journal/s;
async function successful(parent,name){
 const data=await fixture(parent,name);
 const before=await tree(data.root);
 await assertSupportedFileModes(data.root,[{target:'managed.txt',mode:0o644},{target:'run.sh',mode:0o755}]);
 assert.deepEqual(await tree(data.root),before,'preflight must remove its empty probes');
 const result=await apply(data.previewId,data);assert.equal(result.status,'complete');assert.equal(result.exitCode,0);
 for(const [path,mode] of [['managed.txt',0o644],['run.sh',0o755],['.rigup/manifest.json',0o600]])assert.equal((await lstat(join(data.root,path))).mode&0o777,mode);
 assert.equal(await readFile(join(data.root,'managed.txt'),'utf8'),'managed\n');
 assert.deepEqual((await apply(data.previewId,data)).written,[]);
 report.cases.push({name,status:'passed',apply:'complete',replayWrites:0,modes:['0644','0755','0600']});
}
async function runtime(parent,name,supported){
 const root=join(parent,name);await mkdir(join(root,'.rigup'),{recursive:true,mode:0o700});
 await chmod(root,0o700);await chmod(join(root,'.rigup'),0o700);
 await writeFile(join(root,'.rigup/.gitignore'),'.env\n.env.rigup-*\n',{mode:0o600});
 const before=await readRuntimeFile(root),bytes=await tree(root);
 const write=()=>writeRuntimeFile(root,before,'SYNTHETIC_VALUE=not-a-credential\n');
 if(supported){
  await write();const after=await readRuntimeFile(root);assert.equal(after.problem,undefined);
  assert.equal(after.entries.get('SYNTHETIC_VALUE')?.value,'not-a-credential');
  assert.equal((await lstat(join(root,'.rigup/.env'))).mode&0o777,0o600);
 }else{
  await assert.rejects(write);assert.deepEqual(await tree(root),bytes,'denied private writes must preserve all bytes');
  await assert.rejects(lstat(join(root,'.rigup/.env')),{code:'ENOENT'});
 }
 report.cases.push({name,status:'passed',privateInput:supported?'0600 read/write':'denied before private bytes'});
}
try{
 await successful(control,'linux-ext4');await runtime(control,'linux-ext4-private',true);
 mountDrive(false);
 report.withoutMetadata=execFileSync('findmnt',['-J','-T',mountedRoot,'-o','FSTYPE,OPTIONS'],{encoding:'utf8'}).trim();
 assert.doesNotMatch(report.withoutMetadata,/\bmetadata\b/);
 const unsupported=await fixture(mountedRoot,'without-metadata');
 const original=await tree(unsupported.root);let applyHooks=0;
 await assert.rejects(apply(unsupported.previewId,{...unsupported,hook:async()=>{applyHooks++;}}),guidance);
 assert.equal(applyHooks,0);assert.deepEqual(await tree(unsupported.root),original);
 await assert.rejects(readFile(applyRecordPath(unsupported.root,unsupported.stateRoot)),{code:'ENOENT'});
 report.cases.push({name:'drvfs-without-metadata',status:'passed',apply:'denied',projectUnchanged:true,preparedJournal:false,applyHooks});
 await runtime(mountedRoot,'without-metadata-private',false);
 mountDrive(true);
 report.withMetadata=execFileSync('findmnt',['-J','-T',mountedRoot,'-o','FSTYPE,OPTIONS'],{encoding:'utf8'}).trim();
 assert.match(report.withMetadata,/\bmetadata\b/);
 await successful(mountedRoot,'with-metadata');await runtime(mountedRoot,'with-metadata-private',true);
 const interrupted=await fixture(mountedRoot,'resume-same-path');
 await assert.rejects(apply(interrupted.previewId,{...interrupted,hook:async point=>{if(point==='after-file')throw Error('controlled interruption');}}),/controlled interruption/);
 const journalPath=applyRecordPath(interrupted.root,interrupted.stateRoot),journal=await readFile(journalPath),partial=await tree(interrupted.root);
 assert.equal(JSON.parse(journal).status,'prepared');
 mountDrive(false);
 await assert.rejects(apply(interrupted.previewId,{...interrupted,recover:true}),guidance);
 assert.deepEqual(await readFile(journalPath),journal);assert.deepEqual(await tree(interrupted.root),partial);
 mountDrive(true);
 const resumed=await apply(interrupted.previewId,{...interrupted,recover:true});assert.equal(resumed.status,'complete');assert.equal(resumed.exitCode,0);
 assert.equal(JSON.parse(await readFile(journalPath,'utf8')).status,'complete');
 report.cases.push({name:'drvfs-metadata-loss-and-recovery',status:'passed',deniedJournalUnchanged:true,deniedProjectUnchanged:true,resumed:'complete'});
}catch(error){report.error=String(error);process.exitCode=1;}
finally{
 try{
  if(mounted){
   // Only the unique Windows directory passed by our runner belongs to this probe.
   await rm(mountedRoot,{recursive:true,force:true});execFileSync('umount',[mount]);mounted=false;
  }
  await rm(control,{recursive:true,force:true});report.cleanup=true;
 }catch(error){report.cleanupError=String(error);process.exitCode=1;}
 await writeFile(output,JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report,null,2));
}
