import {test} from 'node:test';
import assert from 'node:assert/strict';
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

test('Windows deferred dispatch waits for authorization and preserves arguments and stdin',{skip},()=>project(async root=>{
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
  assert.deepEqual(await child.completed,{code:0,unavailable:false,interrupted:false});
  assert.deepEqual(JSON.parse(await readFile(output,'utf8')),[literal,literal,literal]);
  assert.equal(stdout,literal);assert.equal(stderr,'fixture stderr');
 }finally{child.stop();await child.completed;}
}));

test('Windows cancellation stops a detached grandchild before reporting completion',{skip},()=>project(async root=>{
 const {startWindowsProcess}=await import('../src/integrations/tools/windows-process.mjs');
 const path=join(root,'writer.pid');
 const child=startWindowsProcess({executable:process.execPath,args:['-e',writer,path],cwd:root,captureOutput:false});
 try{
  child.start();
  const pid=await writerPid(path);
  child.stop();
  const result=await child.completed;
  assert.equal(result.interrupted,true);
  assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
 }finally{child.stop();await child.completed;}
}));

test('Windows observes the exit code of a root that leaves a descendant',{skip},()=>project(async root=>{
 const {startWindowsProcess}=await import('../src/integrations/tools/windows-process.mjs');
 const path=join(root,'writer.pid');
 const command=launchGrandchild+"setInterval(()=>{if(require('node:fs').existsSync(process.argv[1]))process.exit(0);},25);";
 const child=startWindowsProcess({executable:process.execPath,args:['-e',command,path],cwd:root,captureOutput:false});
 try{
  child.start();
  const pid=await writerPid(path);
  try{assert.deepEqual(await child.completed,{code:0,unavailable:false,interrupted:false});}
  finally{try{process.kill(pid,'SIGKILL');}catch{}}
 }finally{child.stop();await child.completed;}
}));

test('Windows permits a slow root exit after its descendant has exited',{skip},()=>project(async root=>{
 const {startWindowsProcess}=await import('../src/integrations/tools/windows-process.mjs');
 const command=`const child=require('node:child_process').spawn(process.execPath,['-e','process.exit(0)'],{stdio:'ignore',windowsHide:true});child.once('exit',()=>setTimeout(()=>process.exit(0),1500));`;
 const child=startWindowsProcess({executable:process.execPath,args:['-e',command],cwd:root,captureOutput:false});
 try{
  child.start();
  assert.deepEqual(await child.completed,{code:0,unavailable:false,interrupted:false});
 }finally{child.stop();await child.completed;}
}));
