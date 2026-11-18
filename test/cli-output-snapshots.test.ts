import assert from 'node:assert/strict';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {delimiter, join} from 'node:path';
import {test} from 'node:test';
import {runCli} from '../src/cli.js';
import {project, testEnvironment} from './helpers.js';

test('Chinese init, update, and doctor match reviewed console transcripts',t=>project(root=>project(async control=>{
 const bin=join(control,'bin');
 await mkdir(bin);
 // Doctor checks that the selected executable exists without launching it.
 await writeFile(join(bin,process.platform==='win32'?'codex.exe':'codex'),'fixture',{mode:0o755});
 testEnvironment(t,{PATH:bin+delimiter+process.env.PATH,NO_COLOR:'1'});
 const services={stateRoot:join(control,'state'),cacheRoot:join(control,'cache')};
 const run=async (args:string[])=>{
  let stdout='',stderr='';
  const code=await runCli(args,{cwd:root,isTTY:false,write:text=>stdout+=text,writeError:text=>stderr+=text,services});
  return {code,stdout,stderr};
 };
 const init=await run(['init','--agents','codex','--sdd','none','--tools','none','--defer-research','--review','--language','zh-CN']);
 assert.equal(init.code,3,init.stdout);
 const previewId=init.stdout.match(/--apply ([a-f0-9]{64})/)?.[1];
 assert.ok(previewId,init.stdout);
 const apply=await run(['update','--apply',previewId,'--sessions-ended','--json']);
 assert.equal(apply.code,0,apply.stdout+apply.stderr);
 const update=await run(['update']);
 const doctor=await run(['doctor']);
 assert.equal(update.code,3,update.stdout);
 assert.equal(doctor.code,3,doctor.stdout);
 for(const [name,result] of Object.entries({init,update,doctor})){
  assert.equal(result.stderr,'');
  const actual=result.stdout.replaceAll(root,'<PROJECT>').replaceAll(previewId,'<PREVIEW_ID>').replaceAll('\r\n','\n');
  const expected=await readFile(new URL('./fixtures/cli-output/'+name+'.zh-CN.txt',import.meta.url),'utf8');
  assert.equal(actual,expected.replaceAll('\r\n','\n'),name);
 }
})));
