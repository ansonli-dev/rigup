import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {delimiter,join} from 'node:path';
import {project} from './helpers.js';

test('runner environment sets both home variables and keeps native Git Bash ahead of WSL bash',()=>project(async root=>{
 const helper=await import('./gitlab-runner-support.js').catch(()=>undefined);assert.ok(helper,'native runner setup helper is required');
 const git=join(root,'Git'),home=join(root,'home');await mkdir(join(git,'bin'),{recursive:true});await mkdir(join(git,'usr/bin'),{recursive:true});await mkdir(join(git,'cmd'),{recursive:true});
 await writeFile(join(git,'cmd/git.exe'),'fixture');await writeFile(join(git,'usr/bin/bash.exe'),'fixture');
 const bash=join(git,'bin/bash.exe');await writeFile(bash,'#!/bin/sh\necho "GNU bash fixture"\n',{mode:0o700});
 const environment={PATH:'wsl-bash-path',RIGUP_GIT_BASH:bash,SystemRoot:'windows-root'};
 const selected=await helper.runnerEnvironment(home,environment,'win32',async file=>file===bash?'GNU bash, version fixture':'');
 assert.equal(selected.HOME,home);assert.equal(selected.USERPROFILE,home);assert.equal(selected.SystemRoot,'windows-root');
 const paths=selected.PATH!.split(delimiter);assert.ok(paths.indexOf(join(git,'bin'))<paths.indexOf('wsl-bash-path'));assert.ok(paths.indexOf(join(git,'usr/bin'))<paths.indexOf('wsl-bash-path'));
 await assert.rejects(helper.runnerEnvironment(home,environment,'win32',async()=> 'WSL launcher'),/Git for Windows|Git Bash/);
}));
test('failed traces are captured and redacted even when one job trace is unavailable',async()=>{
 const helper=await import('./gitlab-runner-support.js').catch(()=>undefined);assert.ok(helper,'failed-job evidence helper is required');
 const calls:string[]=[];
 const api=async(_method:string,path:string)=>{
  calls.push(path);
  if(path.endsWith('/jobs'))return [{id:1,name:'failed',status:'failed'},{id:2,name:'other',status:'failed'}];
  if(path.endsWith('/1/trace'))return 'API synthetic-private-api runner glrt-secret123 job CI_JOB_TOKEN=job-secret Authorization: Bearer bearer-secret';
  throw Error('trace missing synthetic-private-api');
 };
 const evidence=await helper.failedJobEvidence(api,'/projects/1',[42],['synthetic-private-api']);
 assert.ok(calls.includes('/projects/1/jobs/1/trace'));assert.ok(calls.includes('/projects/1/jobs/2/trace'));
 assert.equal(evidence.length,2);assert.match(evidence[0].trace,/redacted/);assert.doesNotMatch(JSON.stringify(evidence),/synthetic-private-api|glrt-secret123|job-secret|bearer-secret/);
 assert.equal(evidence[1].trace,'Trace unavailable');
});
