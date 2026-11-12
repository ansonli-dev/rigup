import {test} from 'node:test';
import assert from 'node:assert/strict';
import {copyFile,mkdir,stat,writeFile} from 'node:fs/promises';
import {delimiter,join} from 'node:path';
import {project} from './helpers.js';
import {nativeWorkflowProbe,observedRun} from './live-workflow-support.js';

test('an injected native turn uses the prepared fixture but cannot replace the posterior oracle',()=>project(async root=>{
 const bin=join(root,'bin');await mkdir(bin);const home=join(root,'home');await mkdir(home);
 // This native version-only host and JS package entry are unit fixtures, with no model request or native acceptance claim.
 const modules=join(root,'installed tools 中文','node_modules'),packageRoot=join(modules,'@fission-ai','openspec'),entry=join(packageRoot,'bin','openspec.js');
 await mkdir(join(packageRoot,'bin'),{recursive:true});await mkdir(join(modules,'.bin'));
 await writeFile(join(packageRoot,'package.json'),JSON.stringify({name:'@fission-ai/openspec',version:'1.16.0',type:'commonjs',bin:{openspec:'./bin/openspec.js'}}));
 const source=`const fs=require('node:fs'),path=require('node:path');
 if(process.argv.includes('--version'))console.log('1.16.0');
 else {const root=process.argv.includes('init')?process.argv.at(-1):process.cwd();
 if(process.argv.includes('init')){fs.mkdirSync(path.join(root,'openspec'),{recursive:true});fs.writeFileSync(path.join(root,'openspec/config.yaml'),'schema: spec-driven\\n');for(const name of ['openspec-propose','openspec-apply-change','openspec-archive-change']){const dir=path.join(root,'.opencode/skills',name);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'SKILL.md'),'---\\nname: '+name+'\\ndescription: Unit fixture\\n---\\n');}}
 console.log(JSON.stringify({root:{path:root,source:'nearest'}}));}`;
 await writeFile(entry,source,{mode:0o600});await copyFile(process.execPath,join(bin,process.platform==='win32'?'opencode.exe':'opencode'));
 const updates={PATH:bin+delimiter+process.env.PATH,RIGUP_OPENSPEC_BIN:entry,RIGUP_LIVE_WORKFLOW_OPENCODE_HOME:home,RIGUP_LIVE_WORKFLOW_OPENCODE_ENV:'PATH,APPDATA,LOCALAPPDATA,TEMP,TMP,TMPDIR',APPDATA:join(root,'ambient-roaming'),LOCALAPPDATA:join(root,'ambient-local'),TEMP:join(root,'ambient-temp'),TMP:join(root,'ambient-tmp'),TMPDIR:join(root,'ambient-tmpdir'),RIGUP_LIVE_KEEP_FIXTURES:'0'},prior=Object.fromEntries(Object.keys(updates).map(key=>[key,process.env[key]]));
 await Promise.all(['APPDATA','LOCALAPPDATA','TEMP','TMP','TMPDIR'].map(name=>mkdir(updates[name as keyof typeof updates],{recursive:true})));
 Object.assign(process.env,updates);let called=0;
 try{
  const result=await nativeWorkflowProbe('opencode','compatibility-delivery',{turnRunner:async request=>{
   called++;assert.equal(request.host,'opencode');assert.deepEqual(Object.keys(request.fixture).sort(),['control','remote','root']);
   assert.equal(Object.isFrozen(request.fixture),true);assert.equal(Object.isFrozen(request.budget),true,'the native driver cannot change the declared acceptance budget');
   assert.ok(request.fixture.root.includes('workspace with space'));assert.equal(request.env.HOME,home);assert.match(request.prompt,/change-deliver/);assert.ok(request.budget.maxWallMs>0);assert.equal(request.stem,'transport');
   const selectedPath=request.env.PATH?.split(delimiter)??[];
   assert.equal(selectedPath[process.platform==='win32'?1:0],join(modules,'.bin'),'agent commands keep the installed OpenSpec launcher directory on PATH');
   if(process.platform==='win32'){
    assert.equal(selectedPath[0],bin,'the selected native host executable stays ahead of npm .cmd launchers');
    assert.equal(request.env.SystemDrive,process.env.SystemDrive,'MXC needs the host system drive');
    assert.equal(request.env.PATHEXT,process.env.PATHEXT,'PowerShell needs the host executable suffixes');
   }
   const storage={APPDATA:join(home,'AppData','Roaming'),LOCALAPPDATA:join(home,'AppData','Local'),TEMP:join(home,'AppData','Local','Temp'),TMP:join(home,'AppData','Local','Temp'),TMPDIR:join(home,'AppData','Local','Temp')};
   for(const [name,path]of Object.entries(storage)){assert.equal(request.env[name],path,'native storage cannot inherit ambient user paths even through the declared env allowlist');assert.equal((await stat(path)).isDirectory(),true,'native sandbox prerequisites must exist before launch');}
   return {command:{executable:'unit-native-driver',args:[],cwd:request.fixture.root},transport:{code:0,timedOut:false,stdout:'',stderr:''},privateEvidence:join(request.fixture.control,'unit-driver.json'),observation:observedRun('codex',[{type:'turn.started'},{type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}].map(value=>JSON.stringify(value)).join('\n'),'Delivery status: complete')};
  }});
  assert.equal(called,1,'the optional runner must actually receive the fully prepared fixture: '+result.reason);
  assert.equal(result.status,'failed','an injected runner claiming completion cannot bypass skill/native/fix/MR postconditions');
  assert.match(result.reason,/Actual SKILL\/GOAL/);assert.equal(result.command.executable,'unit-native-driver');
  assert.equal(result.openspecVersion,'1.16.0');assert.equal(result.hostVersion,process.version,'the host version fixture is an actual native process');
  assert.deepEqual(result.openspecCommand,{executable:process.execPath,args:[entry]},'the JS entry runs directly through native Node, without a command interpreter');
  await writeFile(entry,source.replace('1.16.0','1.15.0'));
  const wrongVersion=await nativeWorkflowProbe('opencode','ready',{turnRunner:async()=>{throw Error('The model turn must not start for an unverified OpenSpec version');}});
  assert.equal(wrongVersion.status,'failed');assert.match(wrongVersion.reason,/requires pinned OpenSpec 1\.16\.0/);
  await writeFile(entry,source);await writeFile(join(packageRoot,'package.json'),JSON.stringify({name:'unverified-package',version:'1.16.0',bin:{openspec:'./bin/openspec.js'}}));
  const wrongPackage=await nativeWorkflowProbe('opencode','ready',{turnRunner:async()=>{throw Error('The model turn must not start for an unverified JS entry');}});
  assert.equal(wrongPackage.status,'failed');assert.match(wrongPackage.reason,/verified OpenSpec 1\.16\.0 package entry/);
 }finally{for(const[key,value]of Object.entries(prior)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
}));
