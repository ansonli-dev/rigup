import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,symlink,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {parse} from 'yaml';
import {setTimeout as wait} from 'node:timers/promises';
import {scanRepository} from '../src/analyzer/repository.js';
import {renderFixed} from '../src/generator/render.js';
import {prepareIntegrations} from '../src/integrations/registry.js';
import {prepareQuality} from '../src/integrations/tools/quality.js';
import {executeCheck} from '../src/integrations/tools/project-check.mjs';
import {project,setNativeEntries} from './helpers.js';

const options={agents:['codex' as const],backend:'host' as const,sdd:'openspec' as const};

test('a prepared workflow refers to native checks and emits no verification runtime',()=>project(async root=>{
 await mkdir(join(root,'src'));
 await writeFile(join(root,'package.json'),JSON.stringify({scripts:{'deps:validate':'node check.mjs'}}));
 await writeFile(join(root,'src','domain.ts'),"import './controller';\n");
 await writeFile(join(root,'src','controller.ts'),'export const controller = true;\n');
 await writeFile(join(root,'check.mjs'),"import {readFileSync} from 'node:fs';if(readFileSync('src/domain.ts','utf8').includes('import')){console.error('error no-domain-to-api-deps: src/domain.ts → src/controller.ts');process.exitCode=7;}\n");
 const profile=await scanRepository(root,options);
 setNativeEntries(profile,{codex:['openspec-propose','openspec-apply-change','openspec-archive-change']});
 const assets=await renderFixed(profile,options,await prepareIntegrations(profile,options),[],[]);
 for(const name of ['change-prepare','change-deliver']){
  const context=assets.find(asset=>asset.target.endsWith(name+'/references/project.md'))!.content;
  assert.match(context,/npm run deps:validate/);
  assert.equal(context.match(/npm run deps:validate/g)?.length,1);
  assert.doesNotMatch(context,/check-worktree|check-results|rigup:receipt|acceptance-digest|npm:\.:/);
 }
 assert.ok(assets.every(asset=>!asset.target.startsWith('.rigup/scripts/')));
 const command=()=>executeCheck({executable:'npm',args:['run','deps:validate'],cwd:'.',envRefs:[]},root);
 const failed=await command();
 assert.equal(failed.exitCode,7);
 assert.deepEqual(failed.diagnostic,{rule:'no-domain-to-api-deps',path:'src/domain.ts',relatedPath:'src/controller.ts'});
 await writeFile(join(root,'src','domain.ts'),'export const domain = true;\n');
 assert.equal((await command()).exitCode,0);
}));

test('check uses exit zero while a descendant still holds the output pipes',()=>project(async root=>{
 const path=join(root,'descendant.pid');
 await writeFile(join(root,'check.mjs'),"import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';\n"+
  "const child=spawn(process.execPath,['-e','setTimeout(()=>{},12000)'],{detached:true,stdio:'inherit'});"+
  "writeFileSync(process.argv[2],String(child.pid));child.unref();\n");
 try{
  const result=await executeCheck({executable:process.execPath,args:['check.mjs',path],cwd:'.',envRefs:[]},root,{timeoutMs:5000});
  assert.equal(result.status,'passed',JSON.stringify(result));
  assert.equal(result.exitCode,0);
  assert.ok(result.durationMs<5000);
 }finally{
  const pid=Number(await readFile(path,'utf8').catch(()=>0));
  if(pid>0)try{process.kill(pid,'SIGKILL');}catch{}
 }
}));

test('cancelling a check stops the actual process',()=>project(async root=>{
 const path=join(root,'check.pid'), controller=new AbortController();
 await writeFile(join(root,'check.mjs'),"import {writeFileSync} from 'node:fs';writeFileSync(process.argv[2],String(process.pid));setInterval(()=>{},10_000);\n");
 const running=executeCheck({executable:process.execPath,args:['check.mjs',path],cwd:'.',envRefs:[]},root,{signal:controller.signal,timeoutMs:7000});
 try{
  let pid=0;
  const deadline=Date.now()+5000;
  while(!pid&&Date.now()<deadline){
   pid=Number(await readFile(path,'utf8').catch(()=>0));
   if(!pid)await wait(25);
  }
  assert.ok(pid>0);
  controller.abort();
  const result=await running;
  assert.equal(result.exitCode,130,JSON.stringify(result));
  assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
 }finally{controller.abort();await running;}
}));

test('checks preserve declared argv and env without injecting service settings',()=>project(async root=>{
 const key='RIGUP_CHECK_FIXTURE_VALUE';
 const command={executable:process.execPath,args:['probe.mjs','\${'+key+'}','--literal'],cwd:'.',envRefs:[key],
  tools:['pm2'],testDatabase:true};
 await writeFile(join(root,'probe.mjs'),"import assert from 'node:assert/strict';\n"+
  "assert.deepEqual(process.argv.slice(2),['check value','--literal']);"+
  "assert.equal(process.env.PM2_HOME,'explicit-pm2-home');assert.equal(process.env.NODE_ENV,'development');\n");
 const result=await executeCheck(command,root,{env:{...process.env,[key]:'check value',PM2_HOME:'explicit-pm2-home',NODE_ENV:'development'}});
 assert.equal(result.exitCode,0,JSON.stringify(result));
 assert.equal(result.status,'passed');
 assert.equal(result.command.args[1],'\${'+key+'}');
}));

test('optional checks reject a junction or symlink outside the project',()=>project(async root=>project(async outside=>{
 await symlink(outside,join(root,'alias'),process.platform==='win32'?'junction':'dir');
 await assert.rejects(
  executeCheck({executable:process.execPath,args:['-e','process.exit(0)'],cwd:'alias',envRefs:[]},root),
  /escapes the selected project/
 );
})));

test('native CI reuses explicitly selected npm scripts and deduplicates generic selection',()=>project(async root=>{
 await writeFile(join(root,'package.json'),JSON.stringify({dependencies:{pg:'1.0.0'},scripts:{test:'jest --config jest-e2e.json','verify:contracts':'node verify-contracts.mjs'}}));
 const configured={...options,quality:{gitlab:{checks:['test' as const,{cwd:'.',script:'test'},{cwd:'.',script:'verify:contracts'}]}}};
 const prepared=await prepareQuality(await scanRepository(root,configured),configured);
 assert.deepEqual(prepared.requirements,[]);
 const job=parse(prepared.assets.find(asset=>asset.target==='.rigup/gitlab-ci.yml')!.content)['rigup:checks'];
 assert.equal(job.script.length,3);
 assert.match(job.script[1],/npm.*run.*test/);
 assert.match(job.script[2],/npm.*run.*verify:contracts/);
 assert.ok(prepared.assets.every(asset=>!asset.target.startsWith('.rigup/scripts/')));
}));
