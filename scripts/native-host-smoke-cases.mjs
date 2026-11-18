import assert from 'node:assert/strict';
import {spawnSync,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstat,mkdir,mkdtemp,readFile,realpath,rm,stat,symlink,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {stripVTControlCharacters} from 'node:util';
import {parse} from 'jsonc-parser';

const id='superpowers@claude-plugins-official';
const ompId='@loneexile/omp-superpowers';
const market='claude-plugins-official';
const windows=process.platform==='win32';
const exists=path=>stat(path).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
const content=async path=>JSON.parse(await readFile(path,'utf8'));
const approvalText=run=>stripVTControlCharacters(run.prompts.join('\n')).replace(/[\r\n]/g,'');
const approvedClaude=run=>{
 const match=/\(Superpowers(?: ([0-9][A-Za-z0-9.+-]*))? at ([0-9a-f]{40})(?=\s|\))/.exec(approvalText(run));
 assert.ok(match,'The Claude catalog SHA must be displayed before approval');
 return {version:match[1],sha:match[2]};
};
const approvedOmp=run=>{
 const match=/\(@loneexile\/omp-superpowers@([0-9][A-Za-z0-9.+-]*) https:\/\/registry\.npmjs\.org\/@loneexile\/omp-superpowers\/-\/omp-superpowers-\1\.tgz (sha512-[A-Za-z0-9+/]{86}==)\)/.exec(approvalText(run));
 assert.ok(match,'The OMP package version and integrity must be displayed before approval');
 return {version:match[1],integrity:match[2]};
};

async function directorySymlinkCapability(stage){
 const probe=await mkdtemp(join(stage,'symlink-'));
 try{
  const target=join(probe,'target'),link=join(probe,'link');
  await mkdir(target);
  try{await symlink(target,link);}
  catch(error){
   if(windows&&error.code==='EPERM')return {allowed:false,error:error.code};
   throw error;
  }
  assert.equal(await realpath(link),await realpath(target));
  return {allowed:true};
 }finally{await rm(probe,{recursive:true,force:true});}
}

export async function smokeNativeHosts({pty,stage,toolEnv,entry,result}){
 result.directorySymlinks=await directorySymlinkCapability(stage);
 const ompMode=result.directorySymlinks.allowed?'link':'install';
 const dist=dirname(entry);
 const {scanNativeEntries}=await import(pathToFileURL(join(dist,'analyzer/repository.js')));
 const {prepareClaudeScratch,claudeGitEnv}=await import(pathToFileURL(join(dist,'integrations/host-setup/claude.js')));
 const run=(args,env,mode='')=>new Promise((resolve,reject)=>{
  const child=pty.spawn(process.execPath,args,{cols:240,rows:40,cwd:stage,env:{...env,TERM:'dumb'},useConpty:true});
  const language=args.lastIndexOf('--language');
  const approval=language!==-1&&args[language+1]==='zh-CN'?'2. 批准':'2. Approve';
  let output='',previous=0;
  const prompts=[];
  let sent=Promise.resolve();
  const timer=setTimeout(()=>{child.kill();reject(new Error('Native terminal timed out: '+output.slice(-3000)));},240_000);
  child.onData(chunk=>{
   output+=chunk;
   const next=output.indexOf(approval,previous);
   if(next===-1)return;
   prompts.push(output.slice(previous,next));
   previous=next+approval.length;
   // The prompt text can arrive before the child switches stdin to raw mode.
   sent=sent.then(()=>delay(150)).then(async()=>{
    if(mode==='cancel')child.write('1\r');
    else if(mode==='eof')child.write('\x04');
    else if(mode==='approve')child.write('2\r');
    else if(typeof mode==='function'){await mode();child.write('2\r');}
   });
  });
  child.onExit(({exitCode})=>{clearTimeout(timer);sent.then(()=>resolve({exitCode,output,prompts}),reject);});
 });
 const assertExit=(actual,code)=>assert.equal(actual.exitCode,code,actual.output.slice(-5000));
 const caseAt=async name=>{
  const home=join(stage,name+' home'),root=join(stage,name+' project'),temp=join(stage,name+' temp');
  const roaming=join(home,'roaming'),local=join(home,'local');
  for(const dir of [home,root,temp,roaming,local])await mkdir(dir,{mode:0o700});
  const env={...toolEnv,HOME:home,CLAUDE_CONFIG_DIR:join(home,'Claude config'),TERM:'dumb',LC_ALL:'C',
   ...(windows?{USERPROFILE:home,APPDATA:roaming,LOCALAPPDATA:local,TEMP:temp,TMP:temp}:{TMPDIR:temp})};
  const state=join(home,'.local/state/rigup');
  const cfg=(hosts,...flags)=>[entry,'init',root,'--agents',hosts,'--sdd','superpowers','--prepare-native',...flags];
  const direct=(hosts,...flags)=>{
   const child=spawnSync(process.execPath,cfg(hosts,...flags),{cwd:stage,env,encoding:'utf8',timeout:45_000});
   return {exitCode:child.status,output:child.stdout+child.stderr,text:child.stdout};
  };
  const interactive=(hosts,mode,...flags)=>run(cfg(hosts,...flags),env,mode);
  const checks=async hosts=>(await scanNativeEntries(root,{agents:hosts,backend:'host',sdd:'superpowers'},{home,env})).skillSources;
  const passiveAbsent=async()=>{
   for(const path of [env.CLAUDE_CONFIG_DIR,join(root,'.claude'),join(home,'.omp'),state])
    assert.equal(await exists(path),false,'Read-only or canceled path wrote '+path);
  };
  const claudeReceipt=async approved=>{
   const config=await content(join(root,'.claude/settings.json'));
   const receipt=(await content(join(env.CLAUDE_CONFIG_DIR,'plugins/installed_plugins.json'))).plugins[id];
   assert.equal(config.enabledPlugins[id],true);
   assert.equal(config.extraKnownMarketplaces[market].source.repo,'anthropics/claude-plugins-official');
   assert.equal(receipt.length,1);
   assert.equal(receipt[0].gitCommitSha,approved.sha);
   assert.ok(receipt[0].version);
   if(approved.version)assert.equal(receipt[0].version,approved.version);
   assert.equal(receipt[0].scope,'project');assert.equal(await realpath(receipt[0].projectPath),root);
   assert.ok((await checks(['claude'])).claude.filter(s=>s.packageName==='superpowers').length>=4);
   return receipt[0];
  };
  const ompReceipt=async ({version,integrity},base=join(home,'.omp/plugins'))=>{
   const lock=await content(join(base,'omp-plugins.lock.json')),item=lock.plugins[ompId];
   assert.deepEqual({enabled:item.enabled,version:item.version},{enabled:true,version});
   const installed=join(base,'node_modules',ompId);
   if(ompMode==='link'){
    const store=join(state,'native-packages','omp-superpowers-'+version,'package');
    assert.equal(await realpath(installed),store);
    const data=await readFile(join(dirname(store),'source.tgz'));
    assert.equal('sha512-'+createHash('sha512').update(data).digest('base64'),integrity);
    assert.equal((await readFile(join(dirname(store),'complete'),'utf8')).trim(),integrity);
   }else{
    const info=await lstat(installed);
    assert.ok(info.isDirectory()&&!info.isSymbolicLink());
    const manifest=await content(join(installed,'package.json'));
    assert.equal(manifest.name,ompId);assert.equal(manifest.version,version);
    const errors=[];
    const bun=parse(await readFile(join(base,'bun.lock'),'utf8'),errors,{allowTrailingComma:true});
    assert.deepEqual(errors,[]);
    assert.equal(bun.packages[ompId][0],ompId+'@'+version);
    assert.equal(bun.packages[ompId][3],integrity);
    assert.equal(await exists(join(state,'native-packages')),false);
   }
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
  assert.deepEqual(plan.hosts[0].steps.map(item=>item.id),['marketplace']);
  assert.deepEqual(plan.hosts[1].steps.map(item=>item.id),[ompMode]);
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
 assertExit(redirected,3);assert.equal(redirected.prompts.length,0);
 for(const mode of ['cancel','eof']){
  const chosen=await first.interactive('claude,omp',mode);
  assertExit(chosen,130);assert.equal(chosen.prompts.length,1);
 }
 const chinese=await first.interactive('claude','cancel','--language','zh-CN');
 assertExit(chinese,130);assert.equal(chinese.prompts.length,1);
 assert.match(stripVTControlCharacters(chinese.output),/批准准备原生 Superpowers 吗？/);
 await first.passiveAbsent();
 result.cases.push({name:'read-only, piped, real stdout redirection, bilingual cancellation and EOF',status:'passed'});

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
 assertExit(native,0);assert.equal(native.prompts.length,2);
 assert.doesNotMatch(native.prompts[0],/\(Superpowers(?: [0-9][A-Za-z0-9.+-]*)? at /);
 assert.match(native.output,/omp[:：].*Claude project plugin/i);
 const firstTarget=approvedClaude(native);
 const firstReceipt=await first.claudeReceipt(firstTarget);
 assert.equal(await exists(join(first.home,'.omp/plugins/omp-plugins.lock.json')),false);
 assert.equal(await exists(join(first.state,'native-packages')),false);
 assertExit(first.direct('claude,omp'),0);
 assert.deepEqual(await first.claudeReceipt(firstTarget),firstReceipt);
 assert.equal(await readFile(local,'utf8'),ordinarySettings);
 for(const name of ['mvnw.cmd','gradlew.bat'])assert.equal(await readFile(join(first.root,name),'utf8'),wrapper);
 result.cases.push({name:'Claude project registration and install, conditional OMP import and no-op',status:'passed',
  claude:{projectScope:true,gitCommitSha:firstReceipt.gitCommitSha,version:firstReceipt.version},ompUserWrite:false});

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
  const runResult=await run(first.cfg('claude').map(arg=>arg===first.root?target:arg),first.env,'approve');
  assertExit(runResult,0);assert.equal(runResult.prompts.length,1);
  const approved=approvedClaude(runResult);
  const settings=await content(join(target,'.claude/settings.json'));
  assert.equal(settings.enabledPlugins[id],true);
  assert.equal(settings.extraKnownMarketplaces[market].source.repo,'anthropics/claude-plugins-official');
  const records=(await content(registry)).plugins[id];
  const resolved=await Promise.all(records.map(async item=>({item,path:await realpath(item.projectPath)})));
  const receipt=resolved.find(entry=>entry.path===target)?.item;
  assert.equal(receipt?.installPath,firstReceipt.installPath);
  assert.equal(receipt?.gitCommitSha,approved.sha);
  if(approved.version)assert.equal(receipt?.version,approved.version);
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
 const prepared=await second.interactive('omp','approve','--verbose');assertExit(prepared,0);
 const ompTarget=approvedOmp(prepared);
 const lock=await second.ompReceipt(ompTarget);
 assertExit(second.direct('omp'),0);
 const both=await second.interactive('claude,omp','approve');assertExit(both,0);
 assert.equal(both.prompts.length,2);
 const secondReceipt=await second.claudeReceipt(approvedClaude(both));
 assert.deepEqual(await second.ompReceipt(ompTarget),lock);
 assert.ok((await second.checks(['omp'])).omp.every(source=>source.packageName===ompId));
 assertExit(second.direct('claude,omp'),0);
 result.cases.push({name:'Verified OMP preparation, real Claude install, native OMP source precedence and no-op',status:'passed',
  omp:{...ompTarget,enabled:true,linked:ompMode==='link',mode:ompMode},claudeCommit:secondReceipt.gitCommitSha});

 const profile=await caseAt('OMP profile');
 const data=join(profile.home,'XDG data'),named=join(profile.home,'.omp/profiles/work');
 await mkdir(join(data,'omp/profiles/work'),{recursive:true});
 Object.assign(profile.env,{OMP_PROFILE:'work',PI_CODING_AGENT_DIR:join(profile.home,'unused agent'),XDG_DATA_HOME:data});
 const namedResult=await profile.interactive('omp','approve','--verbose');assertExit(namedResult,0);
 await profile.ompReceipt(approvedOmp(namedResult),join(windows?named:join(data,'omp/profiles/work'),'plugins'));
 assert.equal(await exists(profile.env.PI_CODING_AGENT_DIR),false);
 assertExit(profile.direct('omp'),0);
 result.cases.push({name:'named OMP profile overrides custom agent folder and uses applicable XDG data',status:'passed'});
 result.modelCalls=0;
}
