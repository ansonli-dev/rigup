import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {test} from 'node:test';
import {runCli, type CliIO} from '../src/cli.js';
import {project, testEnvironment} from './helpers.js';

const selections=['--agents','codex','--sdd','none','--tools','none'];

function fixture(run:(root:string,invoke:(args:string[],overrides?:Partial<CliIO>)=>Promise<{code:number;stdout:string;stderr:string}>)=>Promise<void>){
 return project(root=>project(async control=>{
  const services={stateRoot:join(control,'state'),cacheRoot:join(control,'cache')};
  await run(root,async (args,overrides)=>{
   let stdout='',stderr='';
   const code=await runCli(args,{cwd:root,isTTY:false,write:text=>stdout+=text,writeError:text=>stderr+=text,services,...overrides});
   return {code,stdout,stderr};
  });
 }));
}

test('plain previews group changes and reserve private IDs, logs, and paths for verbose output',()=>fixture(async(root,run)=>{
 const args=['init',...selections,'--dry-run','--language','en'];
 const plain=await run(args);
 assert.equal(plain.code,0,plain.stdout);
 assert.match(plain.stdout,/Agent configuration: Create 1 file/);
 assert.match(plain.stdout,/Project guidance: Create 1 file/);
 assert.match(plain.stdout,/--verbose/);
 assert.doesNotMatch(plain.stdout,/[a-f0-9]{64}|^Details: |AGENTS\.md/m);
 assert.deepEqual(await readdir(root),[]);
 const verbose=await run([...args,'--verbose']);
 assert.match(verbose.stdout,/^Preview [a-f0-9]{64}$/m);
 const details=verbose.stdout.match(/^Details: (.+)$/m)?.[1];
 assert.ok(details,verbose.stdout);
 assert.match(await readFile(details,'utf8'),/AGENTS\.md/);
}));

test('doctor prioritizes attention and a next step while verbose retains routine checks',()=>fixture(async(_root,run)=>{
 const init=await run(['init',...selections,'--defer-research','--review','--json']);
 assert.equal(init.code,3,init.stdout);
 const apply=await run(['update','--apply',JSON.parse(init.stdout).previewId,'--sessions-ended','--json']);
 assert.equal(apply.code,0,apply.stdout);
 const plain=await run(['doctor','--language','en']);
 assert.equal(plain.code,3,plain.stdout);
 assert.match(plain.stdout,/^Diagnostics: \d+ ready, \d+ need attention$/m);
 assert.match(plain.stdout,/^Next: rigup update --review$/m);
 assert.doesNotMatch(plain.stdout,/Manifest schema readable|Owned content present/);
 const verbose=await run(['doctor','--language','en','--verbose']);
 assert.match(verbose.stdout,/Manifest schema readable/);
 assert.match(verbose.stdout,/Owned content present/);
}));

test('the bilingual language choice precedes the wizard header and localizes reached phases',t=>fixture(async(_root,run)=>{
 testEnvironment(t,{LC_ALL:'zh_CN.UTF-8'});
 const {code,stdout}=await run(['init',...selections,'--defer-research','--review'],{
  isTTY:true,ask:async question=>{
   assert.match(question.message,/语言 \/ Language/);
   return ['en'];
  },
 });
 assert.equal(code,3,stdout);
 assert.match(stdout,/^init: .+\nDetect…/);
 assert.match(stdout,/Stages reached: Detect → Generate → Prepare preview/);
 assert.doesNotMatch(stdout,/\p{Script=Han}/u);
}));

for(const {flag,value,expected,error} of [
 {flag:'--agent',value:'codex',expected:/--agent.*--agents/,error:'Unknown option'},
 {flag:'--sdd',value:'foo',expected:/superpowers, openspec, spec-kit, none/,error:'sdd: unsupported selection'},
])test(flag+' gives actionable usage help without an installation report',()=>fixture(async(root,run)=>{
 const result=await run(['init',flag,value,'--language','zh-CN','--json']);
 assert.equal(result.code,2,result.stdout);
 assert.equal(JSON.parse(result.stdout).error,error);
 assert.match(result.stderr,expected);
 assert.doesNotMatch(result.stderr,/结果:|尚未安装/);
 assert.deepEqual(await readdir(root),[]);
}));
