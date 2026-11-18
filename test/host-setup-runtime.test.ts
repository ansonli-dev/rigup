import assert from 'node:assert/strict';
import {constants as fs} from 'node:fs';
import {chmod,copyFile,link,mkdir,readFile,symlink,writeFile} from 'node:fs/promises';
import {delimiter,dirname,join} from 'node:path';
import {planNativePreparation} from '../src/integrations/host-setup/index.js';
import {ompCommand} from '../src/integrations/host-setup/omp.js';
import {test} from 'node:test';
import * as operation from '../src/installer/operations.js';
import {acquireLock,processIdentity} from '../src/installer/lock.js';
import {project} from './helpers.js';

const windows=process.platform==='win32';
const load=()=>import('../src/integrations/host-setup/runtime.js').catch(()=>undefined);
const config=(home:string,path:string)=>({home,env:{
 ...process.env,HOME:home,USERPROFILE:home,CLAUDE_CONFIG_DIR:join(home,'.claude'),
 PATH:path,...(windows?{Path:path}:{}),ANTHROPIC_API_KEY:'secret',NODE_OPTIONS:'--no-warnings',
 XDG_CONFIG_HOME:undefined,PI_CODING_AGENT_DIR:undefined,PI_PROFILE:undefined,OMP_PROFILE:undefined,
}});

test('native resolution uses the consumer PATH in order and preserves common launchers and environment',()=>project(root=>project(async home=>{
 const runtime=await load();assert.ok(runtime,'Native runtime is missing');
 const bin=join(home,'tools with spaces'),redirect=join(home,'redirect'),local=join(root,'fake-bin');
 await Promise.all([bin,local].map(path=>mkdir(path)));
 await symlink(local,redirect,windows?'junction':'dir');
 let target:string;
 if(windows){
  const pkg=join(bin,'node_modules','@anthropic-ai','claude-code');
  target=join(pkg,'bin','claude.exe');
  await mkdir(dirname(target),{recursive:true});
  await writeFile(join(pkg,'package.json'),JSON.stringify({name:'@anthropic-ai/claude-code',bin:{claude:'bin/claude.exe'}}));
  await writeFile(join(bin,'claude.cmd'),'this must never be interpreted\r\n');
  await copyFile(process.execPath,target,fs.COPYFILE_EXCL);
 }else{
  target=join(bin,'claude');
  await copyFile(process.execPath,target,fs.COPYFILE_EXCL);
  await link(target,join(bin,'npm native payload'));
  await chmod(target,0o700);
 }
 const path=[redirect,bin].join(delimiter);
 const input=config(home,local);
 const value=await runtime.inspectHostRuntime(root,'claude',{...input,env:{...input.env,RIGUP_CONSUMER_PATH:path}});
 assert.equal(value.program.file,target);
 assert.deepEqual(value.program.args,[]);
 assert.equal(value.env.PATH,path);
 assert.equal(Object.keys(value.env).filter(key=>key.toUpperCase()==='PATH').length,1);
 assert.equal(value.env.ANTHROPIC_API_KEY,'secret');
 assert.equal(value.env.NODE_OPTIONS,'--no-warnings');
})));

test('an actual OMP launcher works with Maven and Gradle wrappers in the project',()=>project(root=>project(async home=>{
 const runtime=await load();assert.ok(runtime);
 const bin=join(home,'tools with spaces'),stateRoot=join(home,'state');
 const installPath=join(home,'plugin with spaces');
 await mkdir(bin);
 const wrappers=['mvnw.cmd','gradlew.bat'];
 for(const name of wrappers)await writeFile(join(root,name),'inactive wrapper fixture');
 const script=join(bin,'omp-fixture.cjs');
 await writeFile(script,'console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}));\n');
 const entry=join(bin,windows?'omp.cmd':'omp');
 await writeFile(entry,windows
  ? '@echo off\r\n"'+process.execPath+'" "%~dp0omp-fixture.cjs" %*\r\n'
  : '#!/bin/sh\nexec "$RIGUP_TEST_NODE" "$RIGUP_TEST_ENTRY" "$@"\n',{mode:0o755});
 const input={...config(home,bin),stateRoot};
 Object.assign(input.env,{RIGUP_TEST_NODE:process.execPath,RIGUP_TEST_ENTRY:script});
 const plan=await planNativePreparation(root,['omp'],input);
 assert.equal(plan.entries[0].status,'action',plan.entries[0].reason);
 const resolved=await runtime.inspectHostRuntime(root,'omp',input);
 await runtime.withHostWriter({root,stateRoot},'omp',async runner=>{
  const verify=async (command:import('../src/integrations/host-setup/runtime.js').HostCommand,args:string[])=>{
   let stdout='';
   const outcome=await runner.run(command,root,25_000,async()=>undefined,chunk=>{stdout+=chunk.toString();});
   assert.equal(outcome.code,0,JSON.stringify(outcome));
   assert.deepEqual(JSON.parse(stdout),{cwd:root,args});
  };
  await verify({executable:resolved.program.file,args:[...resolved.program.args,'--version'],env:resolved.env},['--version']);
  await verify(ompCommand(resolved,installPath,home),['plugin','link',installPath,'--json']);
 });
 for(const name of wrappers)assert.equal(await readFile(join(root,name),'utf8'),'inactive wrapper fixture');
})));

test('runtime accepts nested targets but rejects a config override resolving inside the project',()=>project(root=>project(async home=>{
 const runtime=await load();assert.ok(runtime,'Native runtime is missing');
 const nested=join(root,'subdir'),redirect=join(home,'redirect');
 await mkdir(nested);
 await mkdir(join(root,'.git'));
 await symlink(root,redirect,windows?'junction':'dir');
 const bin=join(home,'bin');
 await mkdir(bin);
 await copyFile(process.execPath,join(bin,windows?'claude.exe':'claude'));
 if(!windows)await chmod(join(bin,'claude'),0o755);
 const input=config(home,bin);
 assert.equal((await runtime.inspectHostRuntime(nested,'claude',input)).root,nested);
 await assert.rejects(runtime.inspectHostRuntime(root,'claude',{...input,env:{...input.env,CLAUDE_CONFIG_DIR:join(redirect,'not-yet','config')}}),/CLAUDE_CONFIG_DIR/);
})));

test('ordinary project writes see the exact same durable host writer as the native host lock',()=>project(root=>project(other=>project(async state=>{
 const runtime=await load();assert.ok(runtime,'Native runtime is missing');
 if(!windows)await chmod(state,0o700);
 let current;
 try{
  await runtime.withHostWriter({root,stateRoot:state},'claude',async runner=>{
   current=runner;
   await assert.rejects(runtime.withHostWriter({root:other,stateRoot:state},'claude',async()=>{}),/locked|occupied/);
   await runner.run({executable:process.execPath,args:['-e','process.exit(0)'],env:{}},root,5000,async()=>{
    await assert.rejects(operation.assertNoUnknownWriters(root,state),/writing process still active/);
    await operation.assertNoUnknownWriters(other,state);
    return undefined;
   });
  });
  assert.ok(current);
  await operation.assertNoUnknownWriters(root,state);
 }finally{await readFile(join(state,'native-claude.writer.json')).then(()=>assert.fail('clean exit left a writer record'),error=>assert.equal(error.code,'ENOENT'));}
}))));

test('an abandoned controller cannot hide a still-active native writer after lock recovery',()=>project(root=>project(async state=>{
 if(!windows)await chmod(state,0o700);
 try{
  // A separate private record is independent of the controller's lock file.
  await writeFile(join(state,'native-claude.writer.json'),JSON.stringify({host:'claude',root,identity:await processIdentity(process.pid)}),{mode:0o600});
  const lock=await acquireLock(root,{stateRoot:state,recover:true});
  try{await assert.rejects(operation.assertNoUnknownWriters(root,state),/writing process still active/);}
  finally{await lock.release();}
 }finally{/* project() removes the disposable state */}
})));

test('protected launch does not run inherited Node startup hooks or dispatch on a denied guard',{skip:windows},()=>project(root=>project(async state=>{
 const runtime=await load();assert.ok(runtime,'Native runtime is missing');
 await chmod(state,0o700);
 const hook=join(root,'start.cjs'),canary=join(root,'unexpected');
 await writeFile(hook,'require("node:fs").writeFileSync('+JSON.stringify(canary)+',"ran")');
 const before=process.env.NODE_OPTIONS;
 try{
  process.env.NODE_OPTIONS='--require='+hook;
  const result=await runtime.withHostWriter({root,stateRoot:state},'omp',runner=>runner.run(
   {executable:process.execPath,args:['-e','process.exit(9)'],env:{}},root,5000,async()=> 'settings changed'));
  assert.equal(result.blocked,'settings changed');
  await assert.rejects(readFile(canary),{code:'ENOENT'});
 }finally{if(before===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=before;}
})));

test('Windows native resolution uses USERPROFILE when Git Bash HOME differs',{skip:!windows},()=>project(root=>project(async home=>{
 const runtime=await load();assert.ok(runtime);
 const bin=join(home,'bin'),exe=join(bin,'claude.exe'),bashHome=join(home,'bash');
 await mkdir(bin);await mkdir(bashHome);await copyFile(process.execPath,exe);
 const input=config(home,bin);
 const value=await runtime.inspectHostRuntime(root,'claude',{env:{...input.env,HOME:bashHome}});
 assert.equal(value.home,home);
 assert.equal(value.env.HOME,home);
 assert.equal(value.env.USERPROFILE,home);
 assert.equal(value.program.file,exe);
})));

test('POSIX native timeout stops a child that ignores SIGTERM after its host exits',{skip:windows},()=>project(root=>project(async state=>{
 const runtime=await load();assert.ok(runtime);
 await chmod(state,0o700);
 const pidFile=join(root,'child.pid');
 const childScript='process.on("SIGTERM",()=>{});require("node:fs").writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},10_000)';
 const hostScript='process.on("SIGTERM",()=>process.exit(7));require("node:child_process").spawn(process.execPath,["-e",'+JSON.stringify(childScript)+',process.argv[1]],{stdio:"ignore"});setInterval(()=>{},10_000)';
 const result=await runtime.withHostWriter({root,stateRoot:state},'omp',runner=>runner.run(
  {executable:process.execPath,args:['-e',hostScript,pidFile],env:{}},root,1200,async()=>undefined));
 assert.equal(result.cancelled,true);
 const pid=Number(await readFile(pidFile,'utf8'));
 assert.ok(Number.isInteger(pid)&&pid>0);
 assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
 await operation.assertNoUnknownWriters(root,state);
})));

test('native resource lock recovery recognizes a live writer across time zones',{skip:windows},()=>project(root=>project(other=>project(async state=>{
 await chmod(state,0o700);
 const previous=process.env.TZ;
 try{
  process.env.TZ='UTC';
  const first=await acquireLock(root,{stateRoot:state,resource:'test-native',recover:true,trustedProcess:true});
  try{
   process.env.TZ='Asia/Shanghai';
   await assert.rejects(acquireLock(other,{stateRoot:state,resource:'test-native',recover:true,trustedProcess:true}),/occupied/);
  }finally{await first.release();}
 }finally{if(previous===undefined)delete process.env.TZ;else process.env.TZ=previous;}
}))));

test('a differently spelled existing project ancestor cannot accept a config override',()=>project(base=>project(async home=>{
 const runtime=await load();assert.ok(runtime);
 const root=join(base,'Project'),alias=join(base,'project');
 await mkdir(root);
 const lookup=await readFile(join(alias,'missing')).catch(error=>error.code);
 assert.equal(lookup,'ENOENT');
 const {stat}=await import('node:fs/promises');
 if(!await stat(alias).catch(()=>undefined))return; // The host uses case-sensitive lookup.
 const input=config(home,'');
 await assert.rejects(runtime.inspectHostRuntime(root,'claude',{...input,env:{...input.env,CLAUDE_CONFIG_DIR:join(alias,'future-config')}}),/CLAUDE_CONFIG_DIR/);
})));
