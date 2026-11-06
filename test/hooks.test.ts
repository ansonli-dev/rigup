import {test} from 'node:test';
import assert from 'node:assert/strict';
import {project} from './helpers.js';
import {chmod,mkdir,readFile,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {prepareQuality} from '../src/integrations/tools/quality.js';
import {scanRepository} from '../src/analyzer/repository.js';

const exec=promisify(execFile);
const git=(root:string,args:string[])=>exec('git',['-C',root,...args]);
const options={agents:['codex' as const],backend:'host' as const,quality:{preCommit:['lint' as const]}};

test('the activated project hook owns staged verification and stays intact',()=>project(async root=>{
 await git(root,['init','-q']);
 await mkdir(root+'/.husky');await git(root,['config','core.hooksPath','.husky']);
 const hook='#!/bin/sh\n[ "$(git show :value.txt)" = good ]\n';
 await writeFile(root+'/.husky/pre-commit',hook);await chmod(root+'/.husky/pre-commit',0o755);
 await writeFile(root+'/package.json',JSON.stringify({scripts:{lint:'node check.mjs'}}));
 const prepared=await prepareQuality(await scanRepository(root,options),options);
 assert.deepEqual(prepared.assets,[]);assert.deepEqual(prepared.requirements,[]);
 await writeFile(root+'/value.txt','bad');await git(root,['add','--','value.txt']);
 await writeFile(root+'/value.txt','good');
 await assert.rejects(git(root,['hook','run','pre-commit']),{code:1});
 assert.equal(await readFile(root+'/.husky/pre-commit','utf8'),hook);
 assert.equal(await readFile(root+'/value.txt','utf8'),'good');
}));

test('a missing or obsolete generated hook requires native setup',()=>project(async root=>{
 await git(root,['init','-q']);
 await writeFile(root+'/package.json',JSON.stringify({scripts:{lint:'node check.mjs'}}));
 for(const legacy of [false,true]){
  if(legacy){
   await writeFile(root+'/.git/hooks/pre-commit','#!/bin/sh\nnode .rigup/scripts/check-snapshot.mjs pre-commit\n');
   await chmod(root+'/.git/hooks/pre-commit',0o755);
  }
  const prepared=await prepareQuality(await scanRepository(root,options),options);
  assert.deepEqual(prepared.assets,[]);
  assert.match(prepared.requirements[0].reason,/project-owned pre-commit hook/);
 }
}));
