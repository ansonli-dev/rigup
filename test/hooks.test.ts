import {test} from 'node:test';import assert from 'node:assert/strict';
import {project} from './helpers.js';import {writeFile,readFile,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {runSnapshot} from '../templates/scripts/check-snapshot.mjs';
const exec=promisify(execFile);const git=(root:string,args:string[])=>exec('git',['-C',root,...args]);
async function repo(fn:(root:string)=>Promise<void>){await project(async root=>{await git(root,['init','-q']);await git(root,['config','user.name','Fixture']);await git(root,['config','user.email','fixture@example.org']);await fn(root);});}
const command={executable:process.execPath,args:['check.mjs'],cwd:'.',envRefs:[]};
test('precommit_checks_index_not_worktree',()=>repo(async root=>{
 await writeFile(root+'/check.mjs',"import {readFileSync} from 'node:fs';process.exit(readFileSync('value.txt','utf8').includes('bad')?7:0)");await writeFile(root+'/value.txt','bad staged');await git(root,['add','.']);await writeFile(root+'/value.txt','good worktree');const before=(await git(root,['diff','--cached','--binary'])).stdout;
 const r=await runSnapshot({root,mode:'pre-commit',commands:[command]});assert.equal(r.exitCode,7);assert.equal(r.snapshots[0].commands[0].exitCode,7);assert.equal(await readFile(root+'/value.txt','utf8'),'good worktree');assert.equal((await git(root,['diff','--cached','--binary'])).stdout,before);
}));
test('prepush_checks_pushed_commits_including_deleted_and_added_files',()=>repo(async root=>{
 await writeFile(root+'/check.mjs',"import {readFileSync,existsSync} from 'node:fs';process.exit(existsSync('bad.txt')?9:0)");await writeFile(root+'/old.txt','old');await git(root,['add','.']);await git(root,['commit','-qm','base']);const base=(await git(root,['rev-parse','HEAD'])).stdout.trim();
 await writeFile(root+'/bad.txt','bad');await rm(root+'/old.txt');await git(root,['add','-A']);await git(root,['commit','-qm','bad middle']);await rm(root+'/bad.txt');await writeFile(root+'/added.txt','new');await git(root,['add','-A']);await git(root,['commit','-qm','good tip']);const tip=(await git(root,['rev-parse','HEAD'])).stdout.trim();const before=(await git(root,['status','--porcelain'])).stdout;
 const r=await runSnapshot({root,mode:'pre-push',commands:[command],input:`refs/heads/main ${tip} refs/heads/main ${base}\nrefs/heads/deleted ${'0'.repeat(40)} refs/heads/deleted ${base}\n`});assert.equal(r.exitCode,9);assert.equal(r.snapshots.length,2);assert.equal(r.snapshots[0].commands[0].exitCode,9);assert.equal(r.snapshots[1].commands[0].exitCode,0);assert.equal((await git(root,['status','--porcelain'])).stdout,before);
}));
import {prepareQuality} from '../src/integrations/tools/quality.js';import {scanRepository} from '../src/analyzer/repository.js';import {preview} from '../src/installer/preview.js';
test('existing_hook_is_not_overwritten_or_implicitly_chained',()=>repo(async root=>project(async cache=>{
 await writeFile(root+'/package.json',JSON.stringify({scripts:{lint:'node -e "process.exit(0)"'}}));await writeFile(root+'/.git/hooks/pre-commit','#!/bin/sh\necho customer\n');const options={agents:['codex' as const],backend:'host' as const,quality:{preCommit:['lint' as const]}};const profile=await scanRepository(root,options);const prepared=await prepareQuality(profile,options);const p=await preview({root,fingerprint:profile.fingerprint,options,...prepared,dispositions:[],versions:{}},[],{cacheRoot:cache});assert.equal(p.executable,false);assert.match(await readFile(root+'/.git/hooks/pre-commit','utf8'),/customer/);
})));
