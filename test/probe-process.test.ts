import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {writeFileSync} from 'node:fs';
import {delimiter,join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {project} from './helpers.js';
import {nativeCodexProbe} from './live-support.js';
import {LiveProcessCleanupError,runLiveCommand} from './live-process-support.js';

test('live stdout observation happens while the real child is still running',{timeout:20_000},()=>project(async cwd=>{
 const release=join(cwd,'output-observed'),chunks:string[]=[];
 const program=`const fs=require('node:fs');console.log('actual child output');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);console.log('observation released child');}},20);`;
 const result=await runLiveCommand(process.execPath,['-e',program],{cwd,timeoutMs:process.platform==='win32'?12_000:2000,onStdout(chunk:string){chunks.push(chunk);writeFileSync(release,'observed before child exit');}});
 assert.equal(result.timedOut,false,'the child can exit only after its output was delivered to the observer');
 assert.equal(result.code,0);assert.match(chunks.join(''),/actual child output/);assert.match(result.stdout,/observation released child/);
}));

test('a failing stdout observer stops its child and rejects the live command',{timeout:20_000},()=>project(async cwd=>{
 const pidPath=join(cwd,'observer-child.pid');
 const program='require("node:fs").writeFileSync('+JSON.stringify(pidPath)+',String(process.pid));console.log("observe me");setInterval(()=>{},1000);';
 await assert.rejects(runLiveCommand(process.execPath,['-e',program],{cwd,timeoutMs:process.platform==='win32'?12_000:2000,onStdout(){throw Error('Observer failure');}}),/Observer failure/);
 assert.equal(running(Number(await readFile(pidPath,'utf8'))),false);
}));

const grandchild=`
 const {existsSync}=require('node:fs');
 process.on('SIGTERM',()=>{});
 const release=process.argv[1];
 setInterval(()=>{if(existsSync(release))process.exit(0);},25);
 setTimeout(()=>process.exit(0),20000);
 process.send(process.pid);
`;

function running(pid:number):boolean{
 try{process.kill(pid,0);return true;}
 catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return false;throw error;}
}

function fixtureTree(pidsPath:string,release:string,onReady=''){
 return `
 const {spawn}=require('node:child_process');
 const {existsSync,writeFileSync}=require('node:fs');
 const release=${JSON.stringify(release)};
 const child=spawn(process.execPath,['-e',${JSON.stringify(grandchild)},release],{stdio:['ignore','inherit','inherit','ipc']});
 process.on('SIGTERM',()=>{});
 setInterval(()=>{if(existsSync(release))process.exit(0);},25);
 setTimeout(()=>process.exit(0),25000);
 child.once('message',pid=>{
  writeFileSync(${JSON.stringify(pidsPath)},JSON.stringify([process.pid,pid]));
  ${onReady}
 });`;
}

async function assertStopped(pidsPath:string){
 const pids:number[]=JSON.parse(await readFile(pidsPath,'utf8'));
 assert.equal(pids.length,2);
 assert.deepEqual(pids.filter(running),[],'the probe must verify both processes have exited before returning');
}

async function releaseFixture(release:string,pidsPath:string){
 await writeFile(release,'');
 const pids:number[]=JSON.parse(await readFile(pidsPath,'utf8').catch(()=> '[]'));
 const deadline=Date.now()+3000;
 while(pids.some(running)&&Date.now()<deadline)await delay(25);
}

test('interactive Codex probe waits for its process and descendant to stop',{timeout:40_000},()=>project(async control=>{
 const root=join(control,'live fixture 空'),bin=join(control,'bin');
 const pidsPath=join(control,'pids.json'),release=join(control,'release');
 await mkdir(root);await mkdir(bin);
 const program=`if(process.argv.includes('--version')){console.log('codex fixture');process.exit(0);}`+fixtureTree(pidsPath,release,`
  const results={
   'skills/list':{data:[{skills:[{name:'rigup-live-canary'}]}]},
   'thread/start':{thread:{id:'thread'}},
   'mcpServerStatus/list':{data:[{name:'rigup-live-canary'}]},
   'mcpServer/tool/call':{content:[{text:'rigup-native-canary-20261104'}]},
  };
  require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
   const request=JSON.parse(line);
   if(request.id)console.log(JSON.stringify({id:request.id,result:results[request.method]??{}}));
  });`);
 if(process.platform==='win32'){
  const pkg=join(bin,'node_modules','@openai','codex');
  await mkdir(join(pkg,'bin'),{recursive:true});
  await writeFile(join(pkg,'package.json'),JSON.stringify({name:'@openai/codex',version:'0.166.0',bin:{codex:'bin/codex.js'}}));
  await writeFile(join(pkg,'bin','codex.js'),program);
  await writeFile(join(bin,'codex.cmd'),'@echo off\r\nexit /b 91\r\n');
 }else await writeFile(join(bin,'codex'),'#!'+process.execPath+'\n'+program,{mode:0o755});
 const prior=process.env.PATH;
 process.env.PATH=[bin,prior].filter(Boolean).join(delimiter);
 try{
  const report=await nativeCodexProbe({root,control,startedAt:new Date().toISOString(),source:'fixture',server:'fixture',
   installed:{status:'complete',exitCode:0,previewId:'fixture',written:[],operations:[],checks:[],warnings:[]}});
  assert.equal(report.status,'passed',JSON.stringify(report));
  await assertStopped(pidsPath);
 }finally{
  if(prior===undefined)delete process.env.PATH;else process.env.PATH=prior;
  await releaseFixture(release,pidsPath);
 }
}));

test('one-shot live timeout stops the process tree before returning',{timeout:40_000},()=>project(async cwd=>{
 const pidsPath=join(cwd,'pids.json'),release=join(cwd,'release');
 try{
  const timeoutMs=process.platform==='win32'?12_000:2000;
  const outcome=await runLiveCommand(process.execPath,['-e',fixtureTree(pidsPath,release)],{cwd,timeoutMs});
  assert.equal(outcome.timedOut,true);
  assert.equal(outcome.code,null);
  await assertStopped(pidsPath);
 }finally{await releaseFixture(release,pidsPath);}
}));

test('a zero-exit live command with a lingering descendant reports cleanup failure',{timeout:40_000},()=>project(async cwd=>{
 const pidsPath=join(cwd,'pids.json'),release=join(cwd,'release');
 try{
  const linger=grandchild.replace('process.send(process.pid);','');
  const program=`
   const {spawn}=require('node:child_process');
   const {writeFileSync}=require('node:fs');
   const child=spawn(process.execPath,['-e',${JSON.stringify(linger)},${JSON.stringify(release)}],{
    detached:process.platform==='win32',stdio:'ignore'
   });
   writeFileSync(${JSON.stringify(pidsPath)},JSON.stringify([process.pid,child.pid]));
   child.unref();
   process.exit(0);
  `;
  await assert.rejects(runLiveCommand(process.execPath,['-e',program],{cwd,timeoutMs:15_000}),LiveProcessCleanupError);
  await assertStopped(pidsPath);
 }finally{await releaseFixture(release,pidsPath);}
}));
