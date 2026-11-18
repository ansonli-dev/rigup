import assert from 'node:assert/strict';
import {spawnSync,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,readFile,realpath,stat,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

const id='superpowers@claude-plugins-official';
const ompId='@loneexile/omp-superpowers';
const market='claude-plugins-official';
const sha='22f0b463e7a5e579904dd6211a520321035526f7';
const integrity='sha512-e0iw1xbuH8F678WCuMT+ZN4b08WfCNEf3kranIqdFva7Hbkuy1v6mgrbP7miVd6r9qzS9/e/ZaQPiXYwQw8BZQ==';
const windows=process.platform==='win32';
const exists=path=>stat(path).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
const content=async path=>JSON.parse(await readFile(path,'utf8'));

export async function smokeNativeHosts({pty,stage,toolEnv,entry,result}){
 const dist=dirname(entry);
 const {scanNativeEntries}=await import(pathToFileURL(join(dist,'analyzer/repository.js')));
 const {prepareClaudeScratch,claudeGitEnv}=await import(pathToFileURL(join(dist,'integrations/host-setup/claude.js')));
 const run=(args,env,mode='')=>new Promise((resolve,reject)=>{
  const child=pty.spawn(process.execPath,args,{cols:140,rows:40,cwd:stage,env:{...env,TERM:'dumb'},useConpty:true});
  let output='',approval=false;
  let sent=Promise.resolve();
  const timer=setTimeout(()=>{child.kill();reject(new Error('Native terminal timed out: '+output.slice(-3000)));},240_000);
  child.onData(chunk=>{
   output+=chunk;
   if(!approval&&output.includes('2. Approve')){
    approval=true;
    // The prompt text can arrive before the child switches stdin to raw mode.
    sent=delay(150).then(async()=>{
     if(mode==='cancel')child.write('1\r');
     else if(mode==='eof')child.write('\x04');
     else if(mode==='approve')child.write('2\r');
     else if(typeof mode==='function'){await mode();child.write('2\r');}
    });
   }
  });
  child.onExit(({exitCode})=>{clearTimeout(timer);sent.then(()=>resolve({exitCode,output,approval}),reject);});
 });
 const assertExit=(actual,code)=>assert.equal(actual.exitCode,code,actual.output.slice(-5000));
 const caseAt=async name=>{
  const home=join(stage,name+' home'),root=join(stage,name+' project'),temp=join(stage,name+' temp');
  const roaming=join(home,'roaming'),local=join(home,'local');
  for(const dir of [home,root,temp,roaming,local])await mkdir(dir,{mode:0o700});
  const env={...toolEnv,HOME:home,CLAUDE_CONFIG_DIR:join(home,'Claude config'),TERM:'dumb',
   ...(windows?{USERPROFILE:home,APPDATA:roaming,LOCALAPPDATA:local,TEMP:temp,TMP:temp}:{TMPDIR:temp})};
  const state=join(home,'.local/state/rigup');
  const cfg=(hosts,...flags)=>[entry,'init',root,'--agents',hosts,'--sdd','superpowers','--prepare-native',...flags];
  const direct=(hosts,...flags)=>{
   const child=spawnSync(process.execPath,cfg(hosts,...flags),{cwd:stage,env,encoding:'utf8',timeout:45_000});
   return {exitCode:child.status,output:child.stdout+child.stderr,text:child.stdout};
  };
  const interactive=(hosts,mode)=>run(cfg(hosts),env,mode);
  const checks=async hosts=>(await scanNativeEntries(root,{agents:hosts,backend:'host',sdd:'superpowers'},{home,env})).skillSources;
  const passiveAbsent=async()=>{
   for(const path of [env.CLAUDE_CONFIG_DIR,join(root,'.claude'),join(home,'.omp'),state])
    assert.equal(await exists(path),false,'Read-only or canceled path wrote '+path);
  };
  const claudeReceipt=async()=>{
   const config=await content(join(root,'.claude/settings.json'));
   const receipt=(await content(join(env.CLAUDE_CONFIG_DIR,'plugins/installed_plugins.json'))).plugins[id];
   assert.equal(config.enabledPlugins[id],true);
   assert.equal(config.extraKnownMarketplaces[market].source.repo,'anthropics/claude-plugins-official');
   assert.equal(receipt.length,1);
   assert.equal(receipt[0].gitCommitSha,sha);assert.equal(receipt[0].version,'7.0.2');
   assert.equal(receipt[0].scope,'project');assert.equal(await realpath(receipt[0].projectPath),root);
   assert.ok((await checks(['claude'])).claude.filter(s=>s.packageName==='superpowers').length>=4);
   return receipt[0];
  };
  const ompReceipt=async (base=join(home,'.omp/plugins'))=>{
   const lock=await content(join(base,'omp-plugins.lock.json')),item=lock.plugins[ompId];
   assert.deepEqual({enabled:item.enabled,version:item.version},{enabled:true,version:'7.0.2-omp.3'});
   const link=await realpath(join(base,'node_modules',ompId));
   const store=join(state,'native-packages/omp-superpowers-7.0.2-omp.3/package');
   assert.equal(link,store);
   const data=await readFile(join(dirname(store),'source.tgz'));
   assert.equal('sha512-'+createHash('sha512').update(data).digest('base64'),integrity);
   assert.ok((await checks(['omp'])).omp.length>=4);
   return lock;
  };
  return {home,root,env,state,cfg,direct,interactive,checks,passiveAbsent,claudeReceipt,ompReceipt};
 };
 result.cases=[];
 const first=await caseAt('Claude first');
 for(const flags of [['--review','--json'],['--dry-run','--json']]){
  const preview=first.direct('claude,omp',...flags);assertExit(preview,0);
  const plan=JSON.parse(preview.text).nativePreparation;
  assert.deepEqual(plan.hosts.map(item=>item.status),['action','action']);
  if(windows)assert.match(plan.hosts[0].steps[0].command,/bin\\claude\.exe/i);
 }
 assertExit(first.direct('claude,omp','--json'),3);
 assertExit(first.direct('claude,omp'),3);
 const redirected=await run(['-e',String.raw`
  if(!process.stdin.isTTY||!process.stdout.isTTY)process.exit(125);
  const {spawnSync}=require('node:child_process');
  const r=spawnSync(process.execPath,process.argv.slice(1),{stdio:['inherit','pipe','pipe'],encoding:'utf8'});
  process.stdout.write(r.stdout+r.stderr);process.exitCode=r.status??126;
 `,'--',...first.cfg('claude,omp')],first.env);
 assertExit(redirected,3);assert.equal(redirected.approval,false);
 for(const mode of ['cancel','eof']){
  const chosen=await first.interactive('claude,omp',mode);
  assertExit(chosen,130);assert.equal(chosen.approval,true);
 }
 await first.passiveAbsent();
 result.cases.push({name:'read-only, piped, real stdout redirection, cancellation and EOF',status:'passed'});

 const local=join(first.root,'.claude/settings.local.json');
 const drift=await first.interactive('claude',async()=>{
  await mkdir(dirname(local));
  await writeFile(local,JSON.stringify({enabledPlugins:{[id]:false}}));
 });
 assertExit(drift,3);
 assert.equal(await exists(first.env.CLAUDE_CONFIG_DIR),false);
 const ordinarySettings=JSON.stringify({env:{RIGUP_NATIVE_SMOKE:'development'},hooks:{}});
 await writeFile(local,ordinarySettings);
 const wrapper='@echo off\r\nexit /b 97\r\n';
 for(const name of ['mvnw.cmd','gradlew.bat'])await writeFile(join(first.root,name),wrapper);
 result.cases.push({name:'target setting changed after approval; no native writes',status:'passed'});

 const native=await first.interactive('claude,omp','approve');
 assertExit(native,0);assert.equal(native.approval,true);
 assert.match(native.output,/omp: recognized via the Claude project plugin/);
 const firstReceipt=await first.claudeReceipt();
 assert.equal(await exists(join(first.home,'.omp/plugins/omp-plugins.lock.json')),false);
 assert.equal(await exists(join(first.state,'native-packages')),false);
 assertExit(first.direct('claude,omp'),0);
 assert.deepEqual(await first.claudeReceipt(),firstReceipt);
 assert.equal(await readFile(local,'utf8'),ordinarySettings);
 for(const name of ['mvnw.cmd','gradlew.bat'])assert.equal(await readFile(join(first.root,name),'utf8'),wrapper);
 result.cases.push({name:'Claude project registration and install, conditional OMP import and no-op',status:'passed',
  claude:{projectScope:true,gitCommitSha:sha,version:'7.0.2'},ompUserWrite:false});

 const parentSettings=await readFile(join(first.root,'.claude/settings.json'),'utf8');
 const git=(...args)=>execFileSync('git',['-C',first.root,'-c','core.hooksPath=','-c','init.templateDir=',...args],{env:first.env,stdio:'pipe'});
 git('init','-q');
 git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','--no-gpg-sign','-qm','fixture');
 git('config','--local','credential.helper','');
 git('config','--local','lfs.repositoryformatversion','0');
 const linkedRoot=join(stage,'linked worktree'),nestedRoot=join(first.root,'nested package');
 git('worktree','add','--detach',linkedRoot);
 await mkdir(nestedRoot);
 const registry=join(first.env.CLAUDE_CONFIG_DIR,'plugins/installed_plugins.json');
 for(const target of [linkedRoot,nestedRoot]){
  assertExit(await run(first.cfg('claude').map(arg=>arg===first.root?target:arg),first.env,'approve'),0);
  const settings=await content(join(target,'.claude/settings.json'));
  assert.equal(settings.enabledPlugins[id],true);
  assert.equal(settings.extraKnownMarketplaces[market].source.repo,'anthropics/claude-plugins-official');
  const records=(await content(registry)).plugins[id];
  const receipt=records.find(item=>item.projectPath===target);
  assert.equal(receipt?.installPath,firstReceipt.installPath);
  assert.equal(receipt?.gitCommitSha,sha);
  assert.equal(receipt?.scope,'project');
 }
 assert.equal(await readFile(join(first.root,'.claude/settings.json'),'utf8'),parentSettings);
 assert.equal((await content(registry)).plugins[id].length,3);
 result.cases.push({name:'worktree and monorepo scopes reuse verified Claude cache',status:'passed',projects:3});

 const scratch=join(stage,'git transport scratch');
 await mkdir(scratch,{mode:0o700});
 await prepareClaudeScratch(scratch);
 const refused=spawnSync('git',['ls-remote','https://github.com/anthropics/claude-plugins-official.git'],{
  env:{...first.env,...claudeGitEnv(scratch,true)},cwd:scratch,encoding:'utf8',timeout:20_000,
 });
 assert.notEqual(refused.status,0);assert.match(refused.stderr,/transport 'file' not allowed/);
 result.cases.push({name:'install Git environment denies official marketplace refresh',status:'passed'});

 const second=await caseAt('OMP first');
 const linked=await second.interactive('omp','approve');assertExit(linked,0);
 const lock=await second.ompReceipt();
 assertExit(second.direct('omp'),0);
 const both=await second.interactive('claude,omp','approve');assertExit(both,0);
 await second.claudeReceipt();
 assert.deepEqual(await second.ompReceipt(),lock);
 assert.ok((await second.checks(['omp'])).omp.every(source=>source.packageName===ompId));
 assertExit(second.direct('claude,omp'),0);
 result.cases.push({name:'OMP verified link, real Claude install, native OMP source precedence and no-op',status:'passed',
  omp:{version:'7.0.2-omp.3',integrity,enabled:true,linked:true},claudeCommit:sha});

 const profile=await caseAt('OMP profile');
 const data=join(profile.home,'XDG data'),named=join(profile.home,'.omp/profiles/work');
 await mkdir(join(data,'omp/profiles/work'),{recursive:true});
 Object.assign(profile.env,{OMP_PROFILE:'work',PI_CODING_AGENT_DIR:join(profile.home,'unused agent'),XDG_DATA_HOME:data});
 assertExit(await profile.interactive('omp','approve'),0);
 await profile.ompReceipt(join(windows?named:join(data,'omp/profiles/work'),'plugins'));
 assert.equal(await exists(profile.env.PI_CODING_AGENT_DIR),false);
 assertExit(profile.direct('omp'),0);
 result.cases.push({name:'named OMP profile overrides custom agent folder and uses applicable XDG data',status:'passed'});
 result.modelCalls=0;
}
