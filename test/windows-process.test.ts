import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {access,readFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {project} from './helpers.js';
import {fixtureError} from './fixture-diagnostics.js';

const skip=process.platform!=='win32';
const grandchild=`require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000);`;
const launchGrandchild=`const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)},process.argv[1]],{detached:true,stdio:'ignore',windowsHide:true});child.unref();`;
const writer=launchGrandchild+'setInterval(()=>{},1000);';

async function readyFile(path:string,phase:string,ended:()=>unknown=()=>undefined,isReady:(value:string)=>boolean=Boolean):Promise<string>{
 const started=performance.now(),deadline=started+25_000;
 do{
  const value=await readFile(path,'utf8').catch(error=>{if(error.code==='ENOENT')return undefined;throw Error('Windows fixture '+phase+' readiness read failed: '+fixtureError(error,[dirname(path)]));});
  if(value&&isReady(value))return value;
  const result=ended();if(result!==undefined)throw Error('Windows fixture '+phase+' exited before readiness: '+fixtureError(result,[dirname(path)]));
  await delay(50);
 }while(performance.now()<deadline);
 throw Error('Windows fixture '+phase+' did not start within 25000 ms (elapsed '+Math.round(performance.now()-started)+' ms)');
}
async function writerPid(path:string,ended?:()=>unknown):Promise<number>{return Number(await readyFile(path,'descendant',ended,value=>/^\d+$/.test(value)));}

test('Windows job dispatch waits for authorization and preserves arguments and stdin',{skip},()=>project(async root=>{
 const {startWindowsProcess}=await import('../src/integrations/tools/windows-process.mjs');
 const output=join(root,'gated result.txt');
 const command=`let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{require('node:fs').writeFileSync(process.argv[1],JSON.stringify([process.argv[2],input,process.env.RIGUP_TEST_LITERAL]));process.stdout.write(input);process.stderr.write('fixture stderr');});`;
 const literal='空 & % "quote" \\';
 const child=startWindowsProcess({executable:process.execPath,args:['-e',command,output,literal],cwd:root,env:{...process.env,RIGUP_TEST_LITERAL:literal}});
 let stdout='',stderr='';
 child.stdout?.setEncoding('utf8').on('data',chunk=>{stdout+=chunk;});
 child.stderr?.setEncoding('utf8').on('data',chunk=>{stderr+=chunk;});
 try{
  assert.ok(child.pid);
  await assert.rejects(access(output),{code:'ENOENT'});
  child.start(literal);
  assert.deepEqual(await child.completed,{code:0,unavailable:false,remaining:false,interrupted:false});
  assert.deepEqual(JSON.parse(await readFile(output,'utf8')),[literal,literal,literal]);
  assert.equal(stdout,literal);assert.equal(stderr,'fixture stderr');
 }finally{child.stop();await child.completed;}
}));

test('Windows job cancellation stops a detached grandchild before reporting completion',{skip},()=>project(async root=>{
 const {startWindowsProcess,windowsJobActive}=await import('../src/integrations/tools/windows-process.mjs');
 const path=join(root,'writer.pid');
 const child=startWindowsProcess({executable:process.execPath,args:['-e',writer,path],cwd:root,captureOutput:false});
 try{
  child.start();
  const pid=await writerPid(path);
  assert.equal(await windowsJobActive(child.job),true);
  child.stop();
  const result=await child.completed;
  assert.equal(result.interrupted,true);
  assert.equal(await windowsJobActive(child.job),false);
  assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
 }finally{child.stop();await child.completed;}
}));

test('Windows job reports a lone descendant left by a normally exited root',{skip},()=>project(async root=>{
 const {startWindowsProcess}=await import('../src/integrations/tools/windows-process.mjs');
 const path=join(root,'writer.pid');
 const command=launchGrandchild+"setInterval(()=>{if(require('node:fs').existsSync(process.argv[1]))process.exit(0);},25);";
 const child=startWindowsProcess({executable:process.execPath,args:['-e',command,path],cwd:root,captureOutput:false});
 try{
  child.start();
  const pid=await writerPid(path);
  assert.deepEqual(await child.completed,{code:1,unavailable:false,remaining:true,interrupted:false});
  assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
 }finally{child.stop();await child.completed;}
}));

test('Windows job permits a slow root exit after its descendant has exited',{skip},()=>project(async root=>{
 const {startWindowsProcess}=await import('../src/integrations/tools/windows-process.mjs');
 const command=`const child=require('node:child_process').spawn(process.execPath,['-e','process.exit(0)'],{stdio:'ignore',windowsHide:true});child.once('exit',()=>setTimeout(()=>process.exit(0),1500));`;
 const child=startWindowsProcess({executable:process.execPath,args:['-e',command],cwd:root,captureOutput:false});
 try{
  child.start();
  assert.deepEqual(await child.completed,{code:0,unavailable:false,remaining:false,interrupted:false});
 }finally{child.stop();await child.completed;}
}));

test('Windows job loses its writer when the controller exits abruptly',{skip},()=>project(async root=>{
 const {windowsJobActive}=await import('../src/integrations/tools/windows-process.mjs');
 const file=join(root,'writer.pid'),jobFile=join(root,'job.json');
 const modulePath=new URL('../src/integrations/tools/windows-process.mjs',import.meta.url).href;
 const program=`import {startWindowsProcess} from ${JSON.stringify(modulePath)};import {writeFileSync} from 'node:fs';const child=startWindowsProcess(${JSON.stringify({executable:process.execPath,args:['-e',writer,file],cwd:root,captureOutput:false})});writeFileSync(${JSON.stringify(jobFile)},JSON.stringify(child.job));child.start();process.stderr.write(JSON.stringify(await child.completed));`;
 const controller=spawn(process.execPath,['--input-type=module','-e',program],{cwd:root,stdio:['ignore','ignore','pipe'],windowsHide:true});
 let stderr='',controllerResult:unknown;controller.stderr.on('data',chunk=>{stderr+=chunk.toString().slice(0,2000-stderr.length);});
 controller.once('error',error=>{controllerResult=fixtureError(error,[root]);});controller.once('exit',(code,signal)=>{controllerResult={code,signal,stderr};});
 const exited=once(controller,'exit');
 try{
  // Controller startup is a separate phase from its supervised writer startup.
  const job=JSON.parse(await readyFile(jobFile,'controller',()=>controllerResult,value=>/^"[a-f0-9-]{36}"$/.test(value)));
  const pid=await writerPid(file,()=>controllerResult);
  controller.kill('SIGKILL');
  await exited;
  const deadline=Date.now()+15_000;
  while(await windowsJobActive(job)){
   assert.ok(Date.now()<deadline,'Windows job remained active after controller exit');
   await delay(50);
  }
  assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
 }finally{controller.kill('SIGKILL');await exited;}
}));
