import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir,readFile,realpath,stat,writeFile} from 'node:fs/promises';
import {delimiter,dirname,join} from 'node:path';
import {test} from 'node:test';
import {resolveWindowsExecutable} from '../src/integrations/tools/windows-process.mjs';
import {runCli,type CliIO} from '../src/cli.js';
import {project} from './helpers.js';

const id='superpowers@claude-plugins-official',market='claude-plugins-official';
const commit='22f0b463e7a5e579904dd6211a520321035526f7';
const put=async(path:string,value:unknown)=>{
 await mkdir(dirname(path),{recursive:true});
 await writeFile(path,typeof value==='string'?value:JSON.stringify(value));
};
const args=(root:string,hosts='claude')=>['init',root,'--agents',hosts,'--sdd','superpowers','--prepare-native'];
const missing=(path:string)=>assert.rejects(stat(path),{code:'ENOENT'});

function cli(root:string,home:string){
 const stateRoot=join(home,'state'),questions:Parameters<NonNullable<CliIO['ask']>>[0][]=[],reports:Record<string,unknown>[]=[];
 const output:string[]=[];
 const path=[join(home,'bin'),...(process.platform==='win32'?[dirname(resolveWindowsExecutable('git',root,process.env))]:[process.env.PATH??''])].join(delimiter);
 const io:CliIO={cwd:root,isTTY:true,outputIsTTY:true,write:t=>output.push(t),writeError:t=>output.push(t),services:{
  stateRoot,report:r=>reports.push(r),nativeSetup:{
   home,env:{...process.env,HOME:home,USERPROFILE:home,CLAUDE_CONFIG_DIR:join(home,'.claude'),
    PI_CODING_AGENT_DIR:undefined,XDG_CONFIG_HOME:undefined,RIGUP_CONSUMER_PATH:path,PATH:path,
   },
  },
 },ask:async q=>{questions.push(q);return ['Approve'];}};
 return {io,stateRoot,questions,reports,output};
}

test('passive and redirected native preparation never prompts, dispatches, or creates state',()=>project(root=>project(async home=>{
 const {io,stateRoot,questions,reports}=cli(root,home);
 for(const flags of [['--review','--json'],['--dry-run'],['--json']]){
  assert.equal(await runCli([...args(root),...flags],io),flags.includes('--json')&&flags.length===1?3:0);
  assert.ok(reports.at(-1)?.nativePreparation);
 }
 for(const tty of [{isTTY:false,outputIsTTY:true},{isTTY:true,outputIsTTY:false},{isTTY:true,outputIsTTY:undefined}]){
  assert.equal(await runCli(args(root),{...io,...tty}),3);
 }
 assert.equal(questions.length,0);
 await missing(stateRoot);
 await missing(join(root,'.claude'));
})));

test('standalone native preparation rejects lifecycle overrides and does not bypass project review policy',()=>project(root=>project(async home=>{
 const {io,stateRoot,questions}=cli(root,home);
 for(const flag of ['--configure','--resume','--apply','--prepare-openspec','--sessions-ended','--defer-research']){
  assert.equal(await runCli([...args(root),flag,...(flag==='--apply'?['preview']:[])],io),2);
 }
 assert.equal(await runCli(args(root).map(x=>x==='init'?'update':x),io),2);
 assert.equal(await runCli(args(root).map(x=>x==='superpowers'?'openspec':x),io),2);
 await put(join(root,'.rigup/config.yaml'),'executionPolicy:\n  mode: review\n');
 assert.equal(await runCli(args(root),io),3);
 assert.equal(questions.length,0);
 await missing(stateRoot);
})));

async function fakeClaude(io:CliIO,root:string,home:string,steps:string[],failInstall=false){
 const pkg=join(home,'.claude/plugins/cache',market,'superpowers','7.0.2');
 const config=join(root,'.claude/settings.json');
 const marketSource={source:'github',repo:'anthropics/claude-plugins-official'};
 const catalog=join(home,'.claude/plugins/marketplaces',market);
 const installDir=join(home,'bin');
 await mkdir(installDir);
 if(process.platform==='win32'){
  const {copyFile}=await import('node:fs/promises');
  await copyFile(process.execPath,join(installDir,'claude.exe'));
 }else{
  const {copyFile,chmod}=await import('node:fs/promises');
  await copyFile(process.execPath,join(installDir,'claude'));
  await chmod(join(installDir,'claude'),0o700);
 }
 io.services!.nativeSetup!.launch=async command=>{
  if(command.args.includes('--version'))return {code:0,output:'2.1.273 (Claude Code)\n'};
  const install=command.args.includes('install');
  steps.push(install?'install':'marketplace');
  if(!install){
   await put(config,{extraKnownMarketplaces:{[market]:{source:marketSource}}});
   await put(join(home,'.claude/plugins/known_marketplaces.json'),{[market]:{source:marketSource,installLocation:catalog}});
   await put(join(catalog,'.claude-plugin/marketplace.json'),{name:market,plugins:[{name:'superpowers',source:{source:'url',url:'https://github.com/obra/superpowers.git',sha:commit}}]});
  }else if(!failInstall){
   await put(config,{extraKnownMarketplaces:{[market]:{source:marketSource}},enabledPlugins:{[id]:true}});
   await put(join(home,'.claude/plugins/installed_plugins.json'),{version:2,plugins:{[id]:[{scope:'project',projectPath:root,installPath:pkg,version:'7.0.2',gitCommitSha:commit}]}});
   await put(join(pkg,'.claude-plugin/plugin.json'),{name:'superpowers'});
   for(const name of ['brainstorming','writing-plans','executing-plans','verification-before-completion'])
    await put(join(pkg,'skills',name,'SKILL.md'),'---\nname: '+name+'\ndescription: fixture\n---\n');
  }
  return {code:install&&failInstall?19:0,output:'SUPPRESSED_HOST_OUTPUT'};
 };
}

test('native approval requires explicit consent and allows an unrelated settings change after preview',()=>project(root=>project(async home=>{
 const {io,stateRoot,output}=cli(root,home),steps:string[]=[];
 await fakeClaude(io,root,home,steps);
 for(const response of [null,['Cancel'],['Approve','Cancel'],[]] as const){
  io.ask=async q=>{
   assert.deepEqual(q.choices.slice(0,2),['Cancel','Approve']);
   assert.equal(q.defaults,undefined);
   return response===null?null:[...response];
  };
  assert.equal(await runCli(args(root),io),130);
 }
 await missing(stateRoot);
 io.ask=async()=>{
  await put(join(root,'.claude/settings.local.json'),{hooks:{}});
  return ['Approve'];
 };
 assert.equal(await runCli(args(root),io),0,output.join(''));
 assert.deepEqual(steps,['marketplace','install']);
 assert.equal(await readFile(join(root,'.claude/settings.local.json'),'utf8'),'{"hooks":{}}');
 assert.doesNotMatch(output.join(''),/SUPPRESSED_HOST_OUTPUT/);
})));

for(const change of ['disabled plugin','review policy','Claude destination'])test('native approval stops for a changed '+change,()=>project(root=>project(async home=>{
 const {io,output}=cli(root,home),steps:string[]=[];
 await fakeClaude(io,root,home,steps);
 const changed=join(home,'new-claude-config');
 io.ask=async()=>{
  if(change==='disabled plugin')await put(join(root,'.claude/settings.local.json'),{enabledPlugins:{[id]:false}});
  if(change==='review policy')await put(join(root,'.rigup/config.yaml'),'executionPolicy:\n  mode: review\n');
  if(change==='Claude destination')io.services!.nativeSetup!.env!.CLAUDE_CONFIG_DIR=changed;
  return ['Approve'];
 };
 assert.equal(await runCli(args(root),io),3,output.join(''));
 assert.deepEqual(steps,[]);
 await missing(join(home,'.claude'));
 await missing(changed);
})));

test('native preparation verifies a completed step before retry, and recognizes a Claude import without an OMP write',()=>project(root=>project(async home=>{
 const {io,output}=cli(root,home),steps:string[]=[];
 await fakeClaude(io,root,home,steps,true);
 assert.equal(await runCli(args(root),io),1);
 assert.deepEqual(steps,['marketplace','install']);
 const {rm}=await import('node:fs/promises');
 await rm(join(home,'bin'),{recursive:true});
 await fakeClaude(io,root,home,steps);
 await put(join(home,'.env'),'PI_CONFIG_DIR=rerouted\n');
 io.services!.nativeSetup!.fetch=async()=>assert.fail('Claude import needs no OMP download');
 assert.equal(await runCli(args(root,'claude,omp'),io),0,output.join(''));
 assert.deepEqual(steps,['marketplace','install','install']);
 assert.match(output.join(''),/omp:.*recognized.*Claude/i);
 assert.doesNotMatch(output.join(''),/SUPPRESSED_HOST_OUTPUT/);
 await missing(join(home,'.omp'));
 assert.equal(await runCli(args(root,'claude,omp'),io),0);
 assert.equal(steps.length,3);
})));

test('Claude project scope follows the selected worktree and monorepo subdirectory',()=>project(parent=>project(other=>project(async home=>{
 const linked=join(other,'linked worktree'),nested=join(parent,'nested package');
 const {io,output}=cli(parent,home);
 const git=(...args:string[])=>execFileSync('git',['-C',parent,'-c','core.hooksPath=','-c','init.templateDir=',...args],{stdio:'pipe'});
 git('init','-q');
 git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','--no-gpg-sign','-qm','fixture');
 git('worktree','add','--detach',linked);
 await mkdir(nested);
 const steps:string[]=[];
 await fakeClaude(io,parent,home,steps);
 const original=io.services!.nativeSetup!.launch!;
 const settings=(root:string)=>join(root,'.claude/settings.json');
 const parentSettings=await runCli(args(parent),io);
 assert.equal(parentSettings,0,output.join(''));
 const parentText=await readFile(settings(parent),'utf8');
 const registry=join(home,'.claude/plugins/installed_plugins.json');
 io.services!.nativeSetup!.launch=async (command,cwd)=>{
  if(command.args.includes('--version'))return original(command,cwd);
  assert.ok([linked,nested].includes(cwd),cwd);
  assert.deepEqual(command.args.slice(-2),['--scope','project']);
  steps.push(cwd);
  const source={source:'github',repo:'anthropics/claude-plugins-official'};
  if(command.args.includes('marketplace'))await put(settings(cwd),{extraKnownMarketplaces:{[market]:{source}}});
  else{
   const declaration=JSON.parse(await readFile(settings(cwd),'utf8'));
   await put(settings(cwd),{...declaration,enabledPlugins:{[id]:true}});
   const installed=JSON.parse(await readFile(registry,'utf8'));
   installed.plugins[id].push({...installed.plugins[id][0],projectPath:cwd});
   await put(registry,installed);
  }
  return {code:0};
 };
 for(const target of [linked,nested]){
  assert.equal(await runCli(args(target),{...io,cwd:target}),0,output.join(''));
  assert.equal(JSON.parse(await readFile(settings(target),'utf8')).extraKnownMarketplaces[market].source.repo,'anthropics/claude-plugins-official');
 }
 const records=JSON.parse(await readFile(registry,'utf8')).plugins[id];
 assert.deepEqual(await Promise.all(records.map((item:{projectPath:string})=>realpath(item.projectPath))),[parent,linked,nested]);
 assert.equal(new Set(records.map((item:{installPath:string})=>item.installPath)).size,1);
 assert.equal(await readFile(settings(parent),'utf8'),parentText);
 assert.deepEqual(steps,['marketplace','install',linked,linked,nested,nested]);
}))));

test('first guided init can return from native consent and then prepares a fresh executable preview',()=>project(root=>project(async home=>{
 const {io,stateRoot,reports,output}=cli(root,home),steps:string[]=[];
 await fakeClaude(io,root,home,steps);
 // The ordinary lifecycle scans the actual host environment when it builds
 // its new preview, so make it the same as the isolated native test home.
 const overrides=io.services!.nativeSetup!.env!;
 const keys=['HOME','USERPROFILE','CLAUDE_CONFIG_DIR'];
 const before=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
 try{
  for(const key of keys)process.env[key]=overrides[key]!;
  let nativePrompts=0,sddPrompts=0,previewPrompt=false;
  io.ask=async q=>{
   if(q.choices.includes('superpowers')){sddPrompts++;return ['superpowers'];}
   if(q.choices.includes('Approve')){
    nativePrompts++;
    if(nativePrompts===1)return 'back';
    assert.deepEqual(steps,[]);
    await missing(join(root,'.claude'));
    return ['Approve'];
   }
   if(q.choices.includes('Save preview, apply later')){previewPrompt=true;return ['Save preview, apply later'];}
   assert.fail('Unexpected question: '+q.message);
  };
  const code=await runCli(['init',root,'--agents','claude','--tools','none'],io);
  assert.equal(code,3,output.join(''));
  assert.equal(sddPrompts,2);assert.equal(nativePrompts,2);assert.equal(previewPrompt,true);
  assert.deepEqual(steps,['marketplace','install']);
  assert.ok(reports.some(r=>r.phase==='preview'&&r.executable===true));
 }finally{for(const key of keys){const value=before[key];if(value===undefined)delete process.env[key];else process.env[key]=value;}}
})));

test('guided review stays read-only and an active host can approve native setup',()=>project(root=>project(async home=>{
 const {io,reports,output}=cli(root,home),steps:string[]=[];
 await fakeClaude(io,root,home,steps);
 let asked=0;io.ask=async()=>{asked++;return ['Approve'];};
 const review=await runCli(['init',root,'--agents','claude','--sdd','superpowers','--tools','none','--review'],io);
 assert.equal(review,3,output.join(''));
 assert.ok(reports.some(r=>r.phase==='preview'&&r.executable===false));
 const originalCwd=process.cwd(),original=process.env.CLAUDECODE;
 try{
  process.chdir(root);process.env.CLAUDECODE='1';
  assert.equal(await runCli(args(root),io),0,output.join(''));
  assert.match(output.join(''),/reload.*host session/i);
 }finally{process.chdir(originalCwd);if(original===undefined)delete process.env.CLAUDECODE;else process.env.CLAUDECODE=original;}
 assert.equal(asked,1);
 assert.deepEqual(steps,['marketplace','install']);
})));

test('mixed native preparation finishes only the approved eligible host, leaving another pending',()=>project(root=>project(async home=>{
 const {io,output}=cli(root,home),steps:string[]=[];
 await fakeClaude(io,root,home,steps);
 assert.equal(await runCli(args(root,'codex,claude'),io),3);
 assert.deepEqual(steps,['marketplace','install']);
 assert.match(output.join(''),/codex: missing native entry/);
})));
