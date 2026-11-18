import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {chmod,copyFile,mkdir,readFile,readdir,realpath,rm,stat,symlink,writeFile} from 'node:fs/promises';
import {delimiter,dirname,join} from 'node:path';
import {test} from 'node:test';
import {resolveWindowsExecutable} from '../src/integrations/tools/windows-process.mjs';
import {runCli,type CliIO} from '../src/cli.js';
import {scanNativeEntries} from '../src/analyzer/repository.js';
import {prepareIntegrations} from '../src/integrations/registry.js';
import {quoteShell} from '../src/shell-command.js';
import {describeNativePreparation,nativePreparationProblem,planNativePreparation,type NativeProgress} from '../src/integrations/host-setup/index.js';
import {latestUrl,ompArchive,ompId,ompRegistryFixture,requiredSkills} from './host-setup-fixtures.js';
import {project,testEnvironment} from './helpers.js';

const id='superpowers@claude-plugins-official',market='claude-plugins-official';
const commit='22f0b463e7a5e579904dd6211a520321035526f7';
const marketSource={source:'github',repo:'anthropics/claude-plugins-official'};
const catalog=(home:string)=>join(home,'.claude/plugins/marketplaces',market);
const catalogFile=(home:string)=>join(catalog(home),'.claude-plugin/marketplace.json');
const catalogEntry=(sha=commit,version?:string)=>({name:market,plugins:[{
 name:'superpowers',version,source:{source:'url',url:'https://github.com/obra/superpowers.git',sha},
}]});
const put=async(path:string,value:unknown)=>{
 await mkdir(dirname(path),{recursive:true});
 await writeFile(path,typeof value==='string'?value:JSON.stringify(value));
};
const args=(root:string,hosts='claude')=>['init',root,'--agents',hosts,'--sdd','superpowers','--prepare-native'];
const missing=(path:string)=>assert.rejects(stat(path),{code:'ENOENT'});

function approvalLines(output:string[],host:string,from=0){
 const lines=output.slice(from).join('').trimEnd().split('\n');
 const start=lines.findIndex(line=>new RegExp('^'+host+'[:：]','i').test(line));
 assert.ok(start!==-1,lines.join('\n'));
 const end=lines.findIndex((line,index)=>index>start&&!/^  /.test(line));
 return lines.slice(start,end===-1?undefined:end);
}

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

const finalPreparation=(reports:Record<string,unknown>[])=>reports.at(-1)?.nativePreparation as
 ReturnType<typeof describeNativePreparation>&{progress:NativeProgress[]};

async function launcher(home:string,host:string){
 const file=join(home,'bin',host+(process.platform==='win32'?'.exe':''));
 await mkdir(dirname(file),{recursive:true});
 await copyFile(process.execPath,file);
 if(process.platform!=='win32')await chmod(file,0o700);
 return file;
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

async function fakeClaude(io:CliIO,root:string,home:string,steps:string[],
 {failInstall=false,catalogVersion,installedVersion='7.0.2',sha=commit,installedSha=sha,cliVersion='2.1.273 (Claude Code)'}:{
  failInstall?:boolean;catalogVersion?:string;installedVersion?:string;sha?:string;installedSha?:string;cliVersion?:string;
 }={}){
 const pkg=join(home,'.claude/plugins/cache',market,'superpowers',installedVersion);
 const config=join(root,'.claude/settings.json');
 await launcher(home,'claude');
 io.services!.nativeSetup!.launch=async command=>{
  if(command.args.includes('--version'))return {code:0,output:cliVersion+'\n'};
  const install=command.args.includes('install');
  steps.push(install?'install':'marketplace');
  if(!install){
   await put(config,{extraKnownMarketplaces:{[market]:{source:marketSource}}});
   await put(join(home,'.claude/plugins/known_marketplaces.json'),{[market]:{source:marketSource,installLocation:catalog(home)}});
   await put(catalogFile(home),catalogEntry(sha,catalogVersion));
  }else if(!failInstall){
   await put(config,{extraKnownMarketplaces:{[market]:{source:marketSource}},enabledPlugins:{[id]:true}});
   await put(join(home,'.claude/plugins/installed_plugins.json'),{version:2,plugins:{[id]:[{scope:'project',projectPath:root,installPath:pkg,version:installedVersion,gitCommitSha:installedSha}]}});
   await put(join(pkg,'.claude-plugin/plugin.json'),{name:'superpowers'});
   for(const name of requiredSkills)
    await put(join(pkg,'skills',name,'SKILL.md'),'---\nname: '+name+'\ndescription: fixture\n---\n');
  }
  return {code:install&&failInstall?19:0,output:'SUPPRESSED_HOST_OUTPUT',stderr:install&&failInstall?
   'fatal: Authentication failed for https://fixture-user:FIXTURE_PASSWORD@invalid.example/private-repo':undefined};
 };
}

async function fakeOmp(io:CliIO,home:string,{probe={code:0,output:'omp/99.0.0'},offline=false,badArchive=false,afterLink=async()=>{}}:{
 probe?:{code:number;output:string;stderr?:string};offline?:boolean;badArchive?:boolean;afterLink?:()=>Promise<void>;
}={}){
 const service=io.services!.nativeSetup!,hostLaunch=service.launch,file=await launcher(home,'omp');
 service.symlinks??=async()=>true;
 const archive=ompArchive(),requests:string[]=[],commands:string[][]=[];
 const base=join(home,'.omp','plugins'),target=join(base,'node_modules',ompId),lock=join(base,'omp-plugins.lock.json');
 service.fetch=async url=>{
  requests.push(String(url));
  if(offline)throw Error('private response detail');
  if(url===latestUrl)return archive.metadata();
  if(url===archive.pin.tarball)return new Response(badArchive?'tampered':new Uint8Array(archive.bytes));
  throw Error('unexpected request');
 };
 service.launch=async (command,cwd)=>{
  if(command.executable!==file&&hostLaunch)return hostLaunch(command,cwd);
  commands.push(command.args);
  if(command.args.includes('--version'))return probe;
  assert.deepEqual(command.args.slice(0,2),['plugin','link']);
  await mkdir(dirname(target),{recursive:true});
  await symlink(command.args[2],target,process.platform==='win32'?'junction':'dir');
  await put(lock,{plugins:{[ompId]:{enabled:true,version:archive.pin.version}},settings:{}});
  await afterLink();
  return {code:0,output:'SUPPRESSED_HOST_OUTPUT'};
 };
 return {archive,requests,commands,base,target,lock};
}

test('native approval transcript names who can run in a partially blocked guided init',()=>project(root=>project(async home=>{
 const {io,output,reports}=cli(root,home),steps:string[]=[];
 await fakeClaude(io,root,home,steps);
 delete io.services!.nativeSetup!.env!.CLAUDE_CONFIG_DIR;
 const {commands}=await fakeOmp(io,home,{offline:true});
 await put(join(home,'.omp','agent','config.yml'),'disabledProviders: [claude-plugins]\n');
 let prompts=0;
 io.ask=async question=>{
  if(prompts++===0){
   assert.match(question.message,/Claude.*only.*OMP/i);
   assert.deepEqual(question.choices,['Cancel','Approve']);
   assert.equal(question.defaults,undefined);
   const claude=approvalLines(output,'claude');
   assert.equal(claude.length,3);
   assert.ok(claude[2].includes(join('~','.claude')));
   assert.match(claude[2],/only \.claude\.json/);
   const omp=approvalLines(output,'omp');
   assert.ok(omp.length<=3,omp.join('\n'));
   assert.match(omp[0],/download-failed/);
   assert.match(omp.join('\n'),/Claude project plugin/i);
   assert.doesNotMatch(output.join(''),/Probe CLI|Evidence:|draft the fix commands|does not authenticate|plugin.*link/);
  }
  return ['Approve'];
 };
 assert.equal(await runCli(['init',root,'--agents','claude,omp','--sdd','superpowers','--tools','none','--language','en'],io),3,output.join(''));
 assert.equal(prompts,2);
 assert.deepEqual(steps,['marketplace','install']);
 assert.deepEqual(commands,[]);
 assert.deepEqual(finalPreparation(reports).hosts.map(({status})=>status),['ready','manual']);
 assert.equal((output.join('').match(/^Next:/gm)??[]).length,1);
})));

test('native approval transcript treats the OMP plan as a fallback to Claude reuse',()=>project(root=>project(async home=>{
 const {io,output,reports}=cli(root,home),steps:string[]=[];
 await fakeClaude(io,root,home,steps,{cliVersion:'2.1.327 (Claude Code)'});
 const {archive,commands,requests}=await fakeOmp(io,home);
 await put(join(home,'.env'),'FIXTURE_KEY=fixture-value\n');
 let prompts=0;
 io.ask=async()=>{
  if(prompts++===0){
   const omp=approvalLines(output,'omp'),preview=output.join('');
   assert.equal(omp.length,3,omp.join('\n'));
   assert.match(omp[1],/if.*Claude.*link/i);
   assert.ok(omp[1].includes(archive.pin.version));
   assert.match(omp[2],/fallback.*writes/i);
   assert.equal(omp[2].split(join('~','.omp')).length-1,1);
   assert.doesNotMatch(preview,/Probe CLI|Checked .*\.env|sha512-|\.tgz|omp-plugins\.lock\.json|does not authenticate/);
  }
  return ['Approve'];
 };
 assert.equal(await runCli(args(root,'claude,omp'),io),0,output.join(''));
 assert.deepEqual(steps,['marketplace','install']);
 assert.deepEqual(requests,[latestUrl]);
 assert.deepEqual(commands,[]);
 assert.deepEqual(finalPreparation(reports).blockers,[]);
 const transcript=output.join('');
 assert.equal((transcript.match(/^Claude:.*installed.*Reopen Claude/gm)??[]).length,1);
 assert.equal((transcript.match(/^OMP:.*Claude.*Reopen OMP/gm)??[]).length,1);
 assert.doesNotMatch(transcript,/Observed change|2\.1\.327|plugin uninstall|Evidence:/);
})));

test('native approval transcript reflects the selected OMP profile and leaves an already-ready Claude alone',()=>project(root=>project(async home=>{
 const {io,output}=cli(root,home);
 await fakeClaude(io,root,home,[]);
 const launch=io.services!.nativeSetup!.launch!;
 for(const step of ['marketplace','install'])await launch({executable:'fixture',args:[step],env:{}},root);
 const {commands}=await fakeOmp(io,home);
 const env=io.services!.nativeSetup!.env!,profile='fixture',base=join('~','.omp','profiles',profile);
 env.OMP_PROFILE=profile;
 await put(join(home,'.omp','profiles',profile,'agent','config.yml'),'disabledProviders: [claude-plugins]\n');
 let expected=base;
 if(process.platform!=='win32'){
  env.XDG_DATA_HOME=join(home,'separate data');
  await mkdir(join(env.XDG_DATA_HOME,'omp','profiles',profile),{recursive:true});
  expected=join('~','separate data','omp','profiles',profile,'plugins');
 }
 io.ask=async()=>{
  assert.equal(approvalLines(output,'claude').length,1);
  const omp=approvalLines(output,'omp');
  assert.equal(omp.length,3,omp.join('\n'));
  assert.doesNotMatch(omp[1],/cannot be reused/);
  assert.ok(omp[2].includes(expected),omp[2]);
  assert.equal(omp[2].split(base).length-1,1);
  return ['Cancel'];
 };
 assert.equal(await runCli(args(root,'claude,omp'),io),130,output.join(''));
 assert.deepEqual(commands,[]);
})));

async function fakeOmpRegistry(io:CliIO,home:string,{
 afterProbe=async()=>{},
 install=async(base,fixture)=>{await fixture.write(base);return {code:0};},
}:{
 afterProbe?:()=>Promise<void>;
 install?:(base:string,fixture:ReturnType<typeof ompRegistryFixture>)=>Promise<{code:number;stderr?:string}>;
}={}){
 const service=io.services!.nativeSetup!;
 await launcher(home,'omp');
 const fixture=ompRegistryFixture(),requests:string[]=[],commands:string[][]=[];
 const base=join(home,'.omp','plugins'),target=join(base,'node_modules',ompId);
 service.symlinks=async()=>false;
 service.fetch=async url=>{
  requests.push(String(url));
  assert.equal(String(url),latestUrl);
  return fixture.metadata();
 };
 service.launch=async command=>{
  commands.push(command.args);
  if(command.args.includes('--version')){await afterProbe();return {code:0,output:'omp/18.1.17'};}
  return install(base,fixture);
 };
 return {base,target,fixture,requests,commands,service};
}

test('OMP plans and approves the pinned registry command without using Rigup store',()=>project(root=>project(async home=>{
 const {io,stateRoot,questions,reports}=cli(root,home);
 const {base,fixture,requests,commands}=await fakeOmpRegistry(io,home);
 assert.equal(await runCli([...args(root,'omp'),'--dry-run'],io),0);
 const step=finalPreparation(reports).hosts[0].steps[0];
 const installArgs=['plugin','install',ompId+'@'+fixture.pin.version,'--json'];
 assert.equal(step.id,'install');
 assert.ok(step.command.includes(installArgs.map(quoteShell).join(' ')),step.command);
 assert.ok(step.pin.includes(fixture.pin.integrity));
 assert.ok(step.writes.some(write=>write.path===join(base,'bun.lock')));
 assert.ok(step.writes.every(write=>!write.path.includes('native-packages')));
 assert.deepEqual(questions,[]);
 await missing(stateRoot);
 await missing(base);
 const approve=io.ask;
 io.ask=async()=>['Cancel'];
 assert.equal(await runCli(args(root,'omp'),io),130);
 assert.deepEqual(commands,[]);
 await missing(stateRoot);
 const unusableStore=join(stateRoot,'native-packages');
 await put(unusableStore,'fixture archive store sentinel');
 io.ask=approve;
 assert.equal(await runCli(args(root,'omp'),io),0);
 assert.deepEqual(commands,[['--version'],installArgs]);
 assert.ok(finalPreparation(reports).progress.some(item=>item.status==='recognized'&&item.step==='install'));
 assert.equal(await readFile(unusableStore,'utf8'),'fixture archive store sentinel');
 assert.equal(await runCli(args(root,'omp'),io),0);
 assert.equal(finalPreparation(reports).hosts[0].status,'ready');
 assert.deepEqual(commands,[['--version'],installArgs]);
 assert.deepEqual(requests,[latestUrl,latestUrl,latestUrl]);
 assert.equal(questions.length,1);
})));

for(const duringProbe of [false,true])test('OMP requires fresh approval when symlink capability changes '+(duringProbe?'after version check':'at consent'),()=>project(root=>project(async home=>{
 const {io,reports}=cli(root,home);
 let available=false;
 const {base,commands,service}=await fakeOmpRegistry(io,home,{afterProbe:async()=>{if(duringProbe)available=true;}});
 service.symlinks=async()=>available;
 if(!duringProbe)io.ask=async()=>{available=true;return ['Approve'];};
 assert.equal(await runCli(args(root,'omp'),io),3);
 assert.deepEqual(commands,duringProbe?[['--version']]:[]);
 assert.equal(finalPreparation(reports).blockers[0]?.code,'native-target-changed');
 await missing(base);
})));

test('OMP rechecks the Bun receipt path before dispatch without following redirections',()=>project(root=>project(async home=>{
 const {io,reports}=cli(root,home),base=join(home,'.omp','plugins'),external=join(home,'external');
 await mkdir(external);
 const {commands}=await fakeOmpRegistry(io,home,{afterProbe:async()=>{
  await mkdir(base,{recursive:true});
  await symlink(external,join(base,'bun.lock'),process.platform==='win32'?'junction':'dir');
 }});
 assert.equal(await runCli(args(root,'omp'),io),3);
 assert.deepEqual(commands,[['--version']]);
 assert.ok(finalPreparation(reports).blockers[0]?.evidence.includes(join(base,'bun.lock')));
 assert.deepEqual(await readdir(external),[]);
})));

for(const mismatch of ['version','receipt','binding'] as const)test('OMP rejects registry result with wrong '+mismatch,()=>project(root=>project(async home=>{
 const {io,reports}=cli(root,home);
 const {base,target}=await fakeOmpRegistry(io,home,{install:async (base,fixture)=>{
  const installed=await fixture.write(base);
  if(mismatch==='receipt')await rm(installed.bunLock);
  if(mismatch==='version'){
   const other='8.0.0';
   await put(installed.manifest,{name:ompId,version:other,pi:{extensions:['./.pi/extensions/superpowers.ts']}});
   await put(installed.bunLock,fixture.lockText([ompId+'@'+other,'',{},fixture.pin.integrity]));
   await put(join(base,'omp-plugins.lock.json'),{plugins:{[ompId]:{version:other,enabled:true}}});
  }
  if(mismatch==='binding')await put(join(root,'.omp','skills','brainstorming','SKILL.md'),
   '---\nname: brainstorming\ndescription: Shadowing fixture\n---\n');
  return {code:0};
 }});
 assert.equal(await runCli(args(root,'omp'),io),1);
 const result=finalPreparation(reports);
 assert.equal(result.blockers[0]?.code,'omp-not-recognized-after-install');
 assert.ok(result.blockers[0].evidence.includes(join(base,'bun.lock')));
 assert.ok(result.blockers[0].suggest.includes('omp plugin uninstall '+ompId));
 assert.ok((await stat(target)).isDirectory());
})));

test('OMP leaves a rejected registry target blocked across runs and retries after manual removal',()=>project(root=>project(other=>project(async home=>{
 const {io,stateRoot,reports}=cli(root,home);
 const markers=async()=>(await readdir(stateRoot)).filter(name=>/^native-omp-.*\.unverified\.json$/.test(name));
 let beforeInstall:string[]=[];
 const {base,target,fixture}=await fakeOmpRegistry(io,home,{install:async (base,fixture)=>{
  beforeInstall=await markers();
  const {bunLock}=await fixture.write(base);
  await put(bunLock,fixture.lockText([...fixture.tuple.slice(0,3),'sha512-'+Buffer.alloc(64).toString('base64')]));
  return {code:0};
 }});
 assert.equal(await runCli(args(root,'omp'),io),1);
 assert.equal(finalPreparation(reports).blockers[0]?.code,'omp-not-recognized-after-install');
 const retry=cli(root,home);
 const {commands,requests,service}=await fakeOmpRegistry(retry.io,home);
 assert.equal(await runCli([...args(root,'omp'),'--language','zh-CN'],retry.io),3);
 assert.match(retry.output.join(''),/未通过核验的 OMP 注册表安装/);
 assert.doesNotMatch(retry.output.join(''),/Remove the unverified OMP registry install/);
 assert.equal(finalPreparation(retry.reports).blockers[0]?.reason,'Remove the unverified OMP registry install before retrying Rigup.');
 assert.equal(beforeInstall.length,1);
 assert.deepEqual(await markers(),beforeInstall);
 assert.equal(finalPreparation(retry.reports).hosts[0].status,'manual');
 assert.equal(finalPreparation(retry.reports).blockers[0]?.code,'omp-not-recognized-after-install');
 assert.deepEqual(commands,[]);
 assert.deepEqual(requests,[]);
 const options={agents:['omp' as const],sdd:'superpowers' as const,backend:'host' as const};
 const scan=await scanNativeEntries(other,options,{home,env:service.env,ompWriterRoot:stateRoot});
 const ordinary=await prepareIntegrations(scan,options);
 assert.equal(ordinary.bindings.length,0);
 assert.match(ordinary.requirements[0].reason,/unverified OMP registry install/i);
 const profileBase=join(home,'.omp','profiles','other','plugins');
 await fixture.write(profileBase);
 const otherProfile=await planNativePreparation(other,['omp'],{...service,env:{...service.env,OMP_PROFILE:'other'}});
 assert.equal(otherProfile.entries[0].status,'ready');
 assert.ok((await stat(target)).isDirectory());
 await rm(target,{recursive:true});
 assert.equal(await runCli(args(root,'omp'),retry.io),0);
 assert.ok((await stat(target)).isDirectory());
 assert.deepEqual(requests,[latestUrl]);
 assert.deepEqual(await markers(),[]);
 assert.ok((await stat(join(base,'bun.lock'))).isFile());
 await missing(join(stateRoot,'native-packages'));
}))));

test('OMP retries an empty registry failure and captures only its safe stderr summary',()=>project(root=>project(async home=>{
 const {io,stateRoot,reports,output}=cli(root,home);
 let attempt=0;
 await fakeOmpRegistry(io,home,{install:async (base,fixture)=>{
  if(attempt++===0){
   await mkdir(join(base,'node_modules'),{recursive:true});
   return {code:23,stderr:"\x1b[31mError: EPERM: operation not permitted, symlink 'C:\\fixture-private\\token' -> '/private/fixture' SECRET_FIXTURE\x1b[0m"};
  }
  await fixture.write(base);
  return {code:0};
 }});
 assert.equal(await runCli(args(root,'omp'),io),1);
 const result=finalPreparation(reports),progress=result.progress.find(item=>item.step==='install');
 assert.equal(progress?.code,23);
 assert.equal(progress?.stderrSummary,'EPERM: permission denied while creating a symbolic link.');
 assert.equal(result.blockers[0]?.code,'install-command-failed');
 assert.deepEqual(result.blockers[0].suggest,[]);
 assert.doesNotMatch(output.join('')+JSON.stringify(result),/fixture-private|SECRET_FIXTURE|\\u001b/);
 assert.ok((await readdir(stateRoot)).every(name=>!name.endsWith('.unverified.json')));
 assert.equal(await runCli(args(root,'omp'),io),0);
 await missing(join(stateRoot,'native-packages'));
})));

test('an interrupted OMP registry install stays unverified even with a matching receipt',()=>project(root=>project(async home=>{
 const attempt=cli(root,home),signal=new AbortController();
 attempt.io.services!.signal=signal.signal;
 await fakeOmpRegistry(attempt.io,home,{install:async(base,fixture)=>{
  await fixture.write(base);
  signal.abort();
  return {code:1,stderr:'EACCES: PRIVATE_CANCEL_DETAIL'};
 }});
 assert.equal(await runCli(args(root,'omp'),attempt.io),130);
 assert.ok(finalPreparation(attempt.reports).progress.every(item=>item.stderrSummary===undefined));
 const retry=cli(root,home);
 const {commands,requests}=await fakeOmpRegistry(retry.io,home);
 assert.equal(await runCli(args(root,'omp'),retry.io),3);
 assert.deepEqual(commands,[]);
 assert.deepEqual(requests,[]);
 assert.equal(finalPreparation(retry.reports).blockers[0]?.code,'omp-not-recognized-after-install');
})));

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
 const {io,output,reports}=cli(root,home),steps:string[]=[];
 await fakeClaude(io,root,home,steps,{failInstall:true});
 assert.equal(await runCli([...args(root),'--verbose'],io),1);
 const failed=finalPreparation(reports);
 assert.equal(failed.blockers[0]?.code,'install-command-failed');
 assert.ok(failed.progress.find(item=>item.step==='marketplace')?.changes?.length);
 assert.deepEqual(failed.progress.find(item=>item.step==='install')?.changes,[]);
 assert.doesNotMatch(output.join(''),/claude plugin uninstall/);
 assert.deepEqual(steps,['marketplace','install']);
 await rm(join(home,'bin'),{recursive:true});
 await fakeClaude(io,root,home,steps);
 await put(join(home,'.env'),'PI_CONFIG_DIR=rerouted\n');
 const {requests,commands}=await fakeOmp(io,home,{offline:true});
 assert.equal(await runCli(args(root,'claude,omp'),io),0,output.join(''));
 assert.deepEqual(steps,['marketplace','install','install']);
 assert.match(output.join(''),/^OMP:.*Claude.*Reopen OMP/m);
 assert.equal((output.join('').match(/^OMP:.*Reopen OMP/gm)??[]).length,1);
 assert.doesNotMatch(output.join(''),/SUPPRESSED_HOST_OUTPUT/);
 assert.deepEqual(requests,[latestUrl]);
 assert.deepEqual(commands,[]);
 assert.deepEqual(finalPreparation(reports).blockers,[]);
 assert.equal(finalPreparation(reports).hosts.find(item=>item.host==='omp')?.status,'ready');
 await missing(join(home,'.omp'));
 assert.equal(await runCli(args(root,'claude,omp'),io),0);
 assert.deepEqual(requests,[latestUrl]);
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
    if(q.message.includes('Claude Superpowers installation')){
     assert.deepEqual(steps,['marketplace']);return ['Approve'];
    }
    if(nativePrompts===1)return 'back';
    assert.deepEqual(steps,[]);
    await missing(join(root,'.claude'));
    return ['Approve'];
   }
   if(q.choices.includes('Save preview, apply later')){previewPrompt=true;return ['Save preview, apply later'];}
   assert.fail('Unexpected question: '+q.message);
  };
  const code=await runCli(['init',root,'--agents','claude','--tools','none','--language','en'],io);
  assert.equal(code,3,output.join(''));
  assert.equal(sddPrompts,2);assert.equal(nativePrompts,3);assert.equal(previewPrompt,true);
  assert.deepEqual(steps,['marketplace','install']);
  assert.ok(reports.some(r=>r.phase==='preview'&&r.executable===true));
 }finally{for(const key of keys){const value=before[key];if(value===undefined)delete process.env[key];else process.env[key]=value;}}
})));

for(const stop of ['optional tools','after back','after marketplace'] as const)test('cancellation '+stop+' reports prior Claude project writes',t=>project(root=>project(async home=>{
 const {io,output,reports}=cli(root,home),steps:string[]=[];
 await fakeClaude(io,root,home,steps);
 const native=io.services!.nativeSetup!;
 testEnvironment(t,{HOME:home,USERPROFILE:home,CLAUDE_CONFIG_DIR:join(home,'.claude'),RIGUP_CONSUMER_PATH:native.env!.RIGUP_CONSUMER_PATH!});
 const target=join(root,'.claude','settings.json');
 await put(target,{permissions:{allow:['Read']}});
 const launch=native.launch!;
 native.launch=async(command,cwd)=>{
  const result=await launch(command,cwd);
  if(!command.args.includes('--version')){
   const written=JSON.parse(await readFile(target,'utf8'));
   await put(target,{...written,permissions:{allow:['Read']}});
  }
  return result;
 };
 let toolPrompts=0;
 io.ask=async question=>{
  const choices=question.choices.map(choice=>typeof choice==='string'?choice:choice.value);
  if(choices.includes('superpowers'))return [toolPrompts?'none':'superpowers'];
  if(choices.includes('Approve'))return [stop==='after marketplace'&&steps.length?'Cancel':'Approve'];
  if(choices.includes('openwiki'))return ++toolPrompts===1&&stop==='after back'?'back':null;
  assert.fail('Unexpected question: '+question.message);
 };
 const code=await runCli(['init','--agents','claude','--language','zh-CN'],io);
 assert.equal(code,130,output.join(''));
 assert.deepEqual(steps,stop==='after marketplace'?['marketplace']:['marketplace','install']);
 assert.equal(toolPrompts,stop==='after marketplace'?0:stop==='after back'?2:1);
 const settings=JSON.parse(await readFile(target,'utf8'));
 assert.deepEqual(settings.permissions,{allow:['Read']});
 assert.ok(settings.extraKnownMarketplaces[market]);
 await missing(join(root,'.rigup','manifest.json'));
 if(stop!=='after marketplace')assert.equal(reports.length,0);
 const terminal=output.join('');
 assert.match(terminal,/结果: 已取消/);
 const result=terminal.slice(terminal.lastIndexOf('结果: 已取消'));
 assert.doesNotMatch(result,/项目没有写入任何内容/);
 assert.equal(result.match(/\.claude[\\/]settings\.json/g)?.length,1,result);
 assert.match(result,/extraKnownMarketplaces/);
 if(stop==='after marketplace')assert.doesNotMatch(result,/claude plugin uninstall/);
 else assert.match(result,/claude plugin uninstall superpowers@claude-plugins-official --scope project --keep-data/);
})));

test('cancellation reports a possibly modified project path when native writes cannot be checked',
 {skip:process.platform==='win32'||process.getuid?.()===0},()=>project(root=>project(async home=>{
 const {io,output}=cli(root,home),steps:string[]=[];
 await fakeClaude(io,root,home,steps);
 const controller=new AbortController();
 io.services!.signal=controller.signal;
 const target=join(root,'.claude');
 const native=io.services!.nativeSetup!,launch=native.launch!;
 native.launch=async(command,cwd)=>{
  const result=await launch(command,cwd);
  if(command.args.includes('marketplace')){
   await chmod(target,0);
   controller.abort();
  }
  return result;
 };
 try{
  assert.equal(await runCli(args(root),io),130,output.join(''));
  assert.deepEqual(steps,['marketplace']);
  const result=output.join('').split('Result: Cancelled').at(-1)!;
  assert.match(result,/may have changed project files/);
  assert.match(result,/\.claude\/settings\.json/);
  assert.doesNotMatch(result,/Nothing was written|claude plugin uninstall/);
 }finally{if(steps.includes('marketplace'))await chmod(target,0o700);}
})));

test('cancellation after an OMP user link reports no project writes',()=>project(root=>project(async home=>{
 const {io,output}=cli(root,home);
 const {target}=await fakeOmp(io,home);
 io.ask=async question=>{
  if(question.choices.includes('Approve'))return ['Approve'];
  if(question.choices.includes('openwiki'))return null;
  assert.fail('Unexpected question: '+question.message);
 };
 assert.equal(await runCli(['init','--agents','omp','--sdd','superpowers','--language','en'],io),130,output.join(''));
 assert.ok((await stat(target)).isDirectory());
 assert.match(output.join(''),/Result: Cancelled\nNothing was written to the project\./);
 await missing(join(root,'.omp'));
})));

test('noninteractive Superpowers gives the native gate before verbose file details',t=>project(root=>project(async home=>{
 const {io,output}=cli(root,home),steps:string[]=[];
 await fakeClaude(io,root,home,steps);
 const native=io.services!.nativeSetup!;
 testEnvironment(t,{HOME:home,USERPROFILE:home,CLAUDE_CONFIG_DIR:join(home,'.claude'),RIGUP_CONSUMER_PATH:native.env!.RIGUP_CONSUMER_PATH!});
 const args=['init','--agents','claude','--sdd','superpowers','--defer-research','--review','--tools','none','--language','zh-CN'];
 const passive={...io,isTTY:false,outputIsTTY:false,ask:async()=>assert.fail('unexpected prompt')};
 assert.equal(await runCli(args,passive),3);
 const plain=output.join('');
 assert.match(plain,/缺少原生 Superpowers/);
 assert.equal(plain.match(/--prepare-native/g)?.length,1,plain);
 assert.doesNotMatch(plain,/missing native entry|\.claude\/skills\//);
 output.length=0;
 assert.equal(await runCli([...args,'--verbose'],{...passive,isTTY:true}),3);
 const verbose=output.join('');
 assert.match(verbose,/\.claude\/skills\//);
 assert.ok(verbose.indexOf('--prepare-native') < verbose.indexOf('.claude/skills/'),verbose);
 output.length=0;
 assert.equal(await runCli([...args,'--json'],{...passive,writeError:undefined}),3);
 const report=JSON.parse(output.join(''));
 assert.equal(report.phase,'preview');
 assert.equal(report.executable,false);
 assert.match(report.nextCommand,/--prepare-native$/);
 assert.match(report.pending[0].reason,/missing native entry/);
 assert.deepEqual(steps,[]);
 await missing(join(root,'.claude'));
})));

test('standalone noninteractive native approval presents its command first',()=>project(root=>project(async home=>{
 const {io,output}=cli(root,home),steps:string[]=[];
 await fakeClaude(io,root,home,steps);
 const passive={...io,isTTY:false,outputIsTTY:false,ask:async()=>assert.fail('unexpected prompt')};
 assert.equal(await runCli(args(root),passive),3);
 const plain=output.join('');
 assert.match(plain,/requires approval with terminal input and output/);
 assert.equal(plain.match(/--prepare-native/g)?.length,1,plain);
 assert.doesNotMatch(plain,/settings\.json/);
 output.length=0;
 assert.equal(await runCli([...args(root),'--verbose'],passive),3);
 const verbose=output.join('');
 assert.match(verbose,/settings\.json/);
 assert.ok(verbose.indexOf('--prepare-native') < verbose.indexOf('settings.json'),verbose);
 assert.deepEqual(steps,[]);
})));

test('guided review stays read-only and an active host can approve native setup',()=>project(root=>project(async home=>{
 const {io,reports,output}=cli(root,home),steps:string[]=[];
 await fakeClaude(io,root,home,steps);
 let asked=0;io.ask=async()=>{asked++;return ['Approve'];};
 const review=await runCli(['init',root,'--agents','claude','--sdd','superpowers','--tools','none','--review','--language','en'],io);
 assert.equal(review,3,output.join(''));
 assert.ok(reports.some(r=>r.phase==='preview'&&r.executable===false));
 const originalCwd=process.cwd(),original=process.env.CLAUDECODE;
 try{
  process.chdir(root);process.env.CLAUDECODE='1';
  assert.equal(await runCli(args(root),io),0,output.join(''));
  assert.equal((output.join('').match(/^Claude:.*installed.*Reopen Claude/gm)??[]).length,1);
  assert.doesNotMatch(output.join(''),/reload.*host session/i);
 }finally{process.chdir(originalCwd);if(original===undefined)delete process.env.CLAUDECODE;else process.env.CLAUDECODE=original;}
 assert.equal(asked,2);
 assert.deepEqual(steps,['marketplace','install']);
})));

test('mixed native preparation finishes only the approved eligible host, leaving another pending',()=>project(root=>project(async home=>{
 const {io,output}=cli(root,home),steps:string[]=[];
 await fakeClaude(io,root,home,steps);
 assert.equal(await runCli(args(root,'codex,claude'),io),3);
 assert.deepEqual(steps,['marketplace','install']);
 const transcript=output.join('');
 assert.equal(transcript.match(/^Codex: missing native entry: superpowers:brainstorming$/gm)?.length,1,transcript);
 assert.match(transcript,/^Next: Open \/plugins/m);
})));

test('OMP approves latest once, tolerates registrations and config overlays, and reuses the recognized link',()=>project(root=>project(async home=>{
 const {io,reports,output}=cli(root,home);
 const {archive,requests,commands,base,target,lock}=await fakeOmp(io,home);
 const setup=io.services!.nativeSetup!,primary=join(home,'.omp/agent/config.yml');
 setup.env!.OMP_CONFIG_FILES='opaque-overlay-path';
 await put(join(home,'.env'),'EXAMPLE_API_KEY=private-api-key\n');
 await put(join(home,'.omp/agent/.env'),'PI_CONFIG_DIR=private-config-dir\n');
 await put(primary,'extensions: [custom.ts]\nskills:\n  customDirectories: [custom-skills]\n');
 await put(join(dirname(primary),'config.yaml'),'skills:\n  enabled: false\n');
 await put(join(base,'package.json'),{dependencies:{[ompId]:'8.7.6'}});
 await put(lock,{plugins:{[ompId]:{enabled:true,version:'8.7.6'}}});
 assert.equal(await nativePreparationProblem(root,'omp',setup),undefined);
 assert.deepEqual(requests,[]);
 io.ask=async()=>{
  const preview=output.join('');
  assert.ok(preview.includes(archive.pin.tarball));
  assert.ok(preview.includes(archive.pin.integrity));
  assert.match(preview,/Checked .*\.env: no effect on install location/);
  assert.match(preview,/may change the install location \(PI_CONFIG_DIR\)/);
  assert.match(preview,/<environment>.*OMP_CONFIG_FILES/);
  assert.doesNotMatch(preview,/99\.0\.0|private-|opaque-overlay-path/);
  assert.deepEqual(requests,[latestUrl]);
  assert.deepEqual(commands,[]);
  return ['Approve'];
 };
 assert.equal(await runCli([...args(root,'omp'),'--verbose'],io),0,output.join(''));
 assert.equal(commands.length,2);
 assert.equal(await realpath(target),commands[1][2]);
 assert.deepEqual(requests,[latestUrl,archive.pin.tarball]);
 assert.match(output.join(''),/CLI version 99\.0\.0 differs from the verified 18\.1\.13/);
 assert.equal(finalPreparation(reports).hosts[0].launcher?.requiredVersion,'18.1.13');
 assert.equal(finalPreparation(reports).hosts[0].launcher?.verifiedVersion,'18.1.13');
 assert.deepEqual(finalPreparation(reports).blockers,[]);
 assert.equal(await runCli(args(root,'omp'),io),0);
 assert.deepEqual(requests,[latestUrl,archive.pin.tarball]);
 assert.equal(commands.length,2);
})));

test('native outcome summary offers one next action and never offers uninstall after a no-change failure',()=>project(root=>project(async home=>{
 const {io,output,reports}=cli(root,home);
 await fakeOmp(io,home,{probe:{code:0,output:'omp/18.1.13'}});
 const setup=io.services!.nativeSetup!,launch=setup.launch!;
 setup.launch=(command,cwd)=>command.args.includes('--version')?launch(command,cwd):Promise.resolve({code:19,output:'PRIVATE_HOST_OUTPUT'});
 const invoke=async(verbose:boolean)=>{
  output.length=0;
  assert.equal(await runCli([...args(root,'omp,codex'),...(verbose?['--verbose']:[])],io),1,output.join(''));
  const report=finalPreparation(reports);
  assert.deepEqual(report.progress.find(item=>item.step==='link')?.changes,[]);
  assert.equal(report.blockers[0].code,'install-command-failed');
  const text=output.join('');
  assert.match(text,/install-command-failed.*exit 19|exit 19.*install-command-failed/);
  assert.doesNotMatch(text,/plugin uninstall|PRIVATE_HOST_OUTPUT|draft the fix commands|does not authenticate/);
  assert.equal((text.match(/^Next:/gm)??[]).length,1);
  if(verbose)assert.match(text,/Evidence:/);
  else{
   assert.match(text,/--verbose for details/);
   assert.doesNotMatch(text,/Evidence:|Verified OMP package stored/);
  }
 };
 await invoke(false);
 await invoke(true);
})));

test('native outcome summary offers detailed uninstall advice for the step that changed files',()=>project(root=>project(async home=>{
 const {io,output,reports}=cli(root,home),config=join(home,'.omp','agent','config.yml');
 await fakeOmp(io,home,{afterLink:()=>put(config,'disabledProviders: [omp-plugins]\n')});
 assert.equal(await runCli([...args(root,'omp'),'--verbose'],io),1,output.join(''));
 assert.ok(finalPreparation(reports).progress.find(item=>item.step==='link')?.changes?.length);
 assert.match(output.join(''),/omp plugin uninstall @loneexile\/omp-superpowers/);
})));

test('native outcome summary reads the safe stderr field and keeps child and blocker codes',async()=>{
 const {nativeFailureText}=await import('../src/integrations/host-setup/index.js');
 const {withLocale}=await import('../src/i18n/index.js');
 const reason='The omp link command failed.';
 const blocker={host:'omp' as const,code:'install-command-failed',reason,evidence:[],suggest:[],agent_can_draft:true};
 const item={host:'omp' as const,step:'link' as const,status:'stopped' as const,message:reason,code:19,blocker};
 const permission=nativeFailureText(blocker,{...item,stderrSummary:'EPERM: permission denied while creating a symbolic link.'});
 assert.match(permission,/EPERM.*symbolic link/);
 assert.match(permission,/exit 19/);
 assert.match(permission,/install-command-failed/);
 const generic=nativeFailureText({...blocker,host:'claude'},{...item,host:'claude',stderrSummary:'Terminal reported an unknown error.\nSee the host logs.'});
 assert.match(generic,/Terminal reported an unknown error\..*See the host logs\./);
 assert.doesNotMatch(generic,/\n/);
 assert.match(nativeFailureText(blocker,item),/The omp link command failed\./);
 const chinese=withLocale('zh-CN',()=>nativeFailureText(blocker,{...item,stderrSummary:'EPERM: permission denied while creating a symbolic link.'}));
 assert.match(chinese,/EPERM.*符号链接/);
 assert.match(chinese,/退出码 19/);
 assert.doesNotMatch(chinese,/creating a symbolic link/);
 const missing=withLocale('zh-CN',()=>nativeFailureText(blocker,{...item,stderrSummary:'ENOENT: A required file or executable was missing.'}));
 assert.match(missing,/ENOENT.*文件.*命令|ENOENT.*文件.*可执行/);
 assert.doesNotMatch(missing,/A required file or executable/);
 const auth=withLocale('zh-CN',()=>nativeFailureText(blocker,{...item,stderrSummary:'Git authentication failed.'}));
 assert.match(auth,/Git.*失败/);
 assert.doesNotMatch(auth,/Git authentication failed/);
});

test('OMP approval keeps an integrity failure out of both the store and link',()=>project(root=>project(async home=>{
 const {io,stateRoot,reports}=cli(root,home),{commands,requests,archive,target}=await fakeOmp(io,home,{badArchive:true});
 assert.equal(await runCli(args(root,'omp'),io),3);
 assert.deepEqual(finalPreparation(reports).blockers.map(blocker=>blocker.code),['download-failed']);
 assert.deepEqual(commands,[]);
 assert.deepEqual(requests,[latestUrl,archive.pin.tarball]);
 await missing(target);
 await missing(join(stateRoot,'native-packages'));
})));

test('OMP blocks an unsuccessful or empty version probe without exposing host output',()=>project(root=>project(async home=>{
 const {io,stateRoot,reports,output}=cli(root,home);
 for(const probe of [{code:0,output:''},{code:19,output:'\x1b[31mPRIVATE_HOST_DATA',stderr:'ENOENT: /fixture-private-stderr'}]){
  const {commands}=await fakeOmp(io,home,{probe});
  assert.equal(await runCli(args(root,'omp'),io),1);
  assert.deepEqual(commands,[['--version']]);
  assert.equal(finalPreparation(reports).blockers[0]?.code,'cli-not-runnable');
  const failure=finalPreparation(reports).progress.at(-1);
  assert.equal(failure?.code,probe.code);
  assert.equal(failure?.stderrSummary,probe.code===19?'ENOENT: A required file or executable was missing.':undefined);
  await missing(join(stateRoot,'native-packages'));
 }
 assert.doesNotMatch(output.join('')+JSON.stringify(reports),/PRIVATE_HOST_DATA|fixture-private-stderr/);
})));

test('an OMP rescan blocker includes write paths, shadowing evidence and undo, then clears on rerun',()=>project(root=>project(async home=>{
 const {io,reports,output}=cli(root,home),config=join(home,'.omp/agent/config.yml'),dotenv=join(dirname(config),'.env');
 const initial='skills:\n  customDirectories: [custom-skills]\nextensions: [custom.ts]\n';
 await put(config,initial);
 await put(dotenv,'export PI_CONFIG_DIR="private-path"\n');
 const {archive,requests,target,lock}=await fakeOmp(io,home,{afterLink:()=>put(config,initial+'disabledProviders: [omp-plugins]\n')});
 assert.equal(await runCli(args(root,'omp'),io),1);
 const result=finalPreparation(reports),blocker=result.blockers[0];
 assert.equal(blocker.code,'omp-not-recognized-after-install');
 for(const path of [target,lock,dotenv+' (PI_CONFIG_DIR)',config+' (skills.customDirectories)',config+' (extensions)'])assert.ok(blocker.evidence.includes(path),path);
 assert.ok(blocker.suggest.includes('omp plugin uninstall '+ompId));
 assert.ok(result.progress.find(item=>item.step==='link')?.changes?.includes(target));
 assert.match(output.join(''),/omp-not-recognized-after-install/);
 assert.doesNotMatch(output.join(''),/plugin uninstall|Evidence:/);
 assert.doesNotMatch(output.join('')+JSON.stringify(result),/private-path|SUPPRESSED_HOST_OUTPUT/);
 await put(config,initial);
 assert.equal(await runCli(args(root,'omp'),io),0);
 assert.deepEqual(finalPreparation(reports).blockers,[]);
 assert.equal(finalPreparation(reports).hosts[0].status,'ready');
 assert.deepEqual(requests,[latestUrl,archive.pin.tarball]);
})));

test('an explicitly disabled host from the scan reports its settings while the other host runs',()=>project(root=>project(async home=>{
 const {io,output,reports}=cli(root,home),settings=join(root,'.claude/settings.local.json');
 await put(settings,{enabledPlugins:{[id]:false}});
 const {commands}=await fakeOmp(io,home);
 assert.equal(await runCli(args(root,'claude,omp'),io),3,output.join(''));
 const result=finalPreparation(reports);
 assert.deepEqual(result.hosts.map(({status})=>status),['manual','ready']);
 assert.equal(result.blockers[0].code,'host-plugin-disabled');
 assert.ok(result.blockers[0].evidence.includes(settings));
 assert.equal(commands.length,2);
})));

test('OMP can finish when the Claude install command fails',()=>project(root=>project(async home=>{
 const {io,output,reports}=cli(root,home),steps:string[]=[];
 await fakeClaude(io,root,home,steps,{failInstall:true});
 const {commands}=await fakeOmp(io,home);
 assert.equal(await runCli(args(root,'claude,omp'),io),1,output.join(''));
 assert.deepEqual(steps,['marketplace','install']);
 assert.equal(commands.length,2);
 assert.deepEqual(finalPreparation(reports).blockers.map(({host,code})=>({host,code})),[{host:'claude',code:'install-command-failed'}]);
 const failure=finalPreparation(reports).progress.find(item=>item.host==='claude'&&item.status==='stopped');
 assert.equal(failure?.code,19);
 assert.equal(failure?.stderrSummary,'Git authentication failed.');
 assert.doesNotMatch(output.join('')+JSON.stringify(reports),/FIXTURE_PASSWORD|private-repo/);
})));

test('offline OMP metadata remains a pre-write blocker when Claude is not imported',()=>project(root=>project(async home=>{
 const {io,reports,output}=cli(root,home),steps:string[]=[];
 await fakeClaude(io,root,home,steps);
 const {requests,commands}=await fakeOmp(io,home,{offline:true});
 await put(join(home,'.omp/agent/config.yml'),'disabledProviders: [claude-plugins]\n');
 const plan=await planNativePreparation(root,['omp'],io.services!.nativeSetup);
 assert.deepEqual(describeNativePreparation(plan).blockers.map(blocker=>blocker.code),['download-failed']);
 assert.equal(await runCli(args(root,'claude,omp'),io),3,output.join(''));
 assert.deepEqual(steps,['marketplace','install']);
 assert.deepEqual(commands,[]);
 assert.deepEqual(requests,[latestUrl,latestUrl]);
 const result=finalPreparation(reports);
 assert.deepEqual(result.hosts.map(({status})=>status),['ready','manual']);
 assert.equal(result.blockers[0].host,'omp');
 assert.doesNotMatch(output.join('')+JSON.stringify(result),/private response detail/);
})));

test('a fresh Claude marketplace needs separate approval of the catalog SHA before install',()=>project(root=>project(async home=>{
 const {io,reports,output}=cli(root,home),steps:string[]=[],sha='a'.repeat(40);
 await fakeClaude(io,root,home,steps,{sha,installedVersion:'9.8.7',cliVersion:'99.0.0 (Claude Code)'});
 const free=join(home,'bin');
 await put(join(free,'git.cmd'),'@echo off\r\nexit /b 0\r\n');
 const env=io.services!.nativeSetup!.env!;
 env.PATH=env.RIGUP_CONSUMER_PATH=free;
 let approvals=0,previousOutput=0;
 io.ask=async()=>{
  approvals++;
  const lines=approvalLines(output,'claude',previousOutput);
  previousOutput=output.length;
  assert.equal(lines.length,3,lines.join('\n'));
  assert.deepEqual(steps,approvals===1?[]:['marketplace']);
  if(approvals===1){
   assert.ok(!lines[1].includes(sha));
   assert.match(lines[1],/marketplace.*ask for approval/i);
  }else{
   assert.ok(lines[1].includes(sha));
   assert.match(lines[1],/catalog version unavailable/);
   assert.ok(lines[2].includes(join(root,'.claude')));
  }
  return approvals===1?['Approve']:['Cancel'];
 };
 assert.equal(await runCli(args(root),io),130,output.join(''));
 assert.equal(approvals,2);
 assert.deepEqual(steps,['marketplace']);
 assert.doesNotMatch(output.join(''),/Reopen Claude|Use --verbose|^Next:/m);
 assert.ok(finalPreparation(reports).progress.find(item=>item.step==='marketplace')?.changes?.length);
 await missing(join(home,'.claude/plugins/installed_plugins.json'));
 await put(join(catalog(home),'.git/config'),'[remote "origin"]\n url = https://mirror.example/official.git\n');
 io.ask=async()=>{
  approvals++;
  return ['Approve'];
 };
 assert.equal(await runCli([...args(root),'--verbose'],io),0,output.join(''));
 assert.equal(approvals,3);
 assert.deepEqual(steps,['marketplace','install']);
 assert.match(output.join(''),/CLI version 99\.0\.0 differs from the verified 2\.1\.273/);
 assert.equal(finalPreparation(reports).progress.find(item=>item.step==='install')?.installedVersion,'9.8.7');
})));

test('cached Claude version and SHA shown at approval cannot drift before dispatch',()=>project(root=>project(async home=>{
 const {io,reports,output}=cli(root,home),steps:string[]=[],sha='c'.repeat(40);
 await fakeClaude(io,root,home,steps,{catalogVersion:'8.7.6',installedVersion:'8.7.6',sha});
 await io.services!.nativeSetup!.launch!({executable:'fixture',args:['marketplace'],env:{}},root);
 await rm(join(root,'.claude','settings.json'));
 steps.length=0;
 io.ask=async()=>{
  const lines=approvalLines(output,'claude');
  assert.equal(lines.length,3,lines.join('\n'));
  assert.match(lines[1],/marketplace.*add.*install/);
  assert.ok(lines[1].includes(sha)&&lines[1].includes('8.7.6'));
  assert.equal(lines[2].split(join(root,'.claude')).length-1,1);
  await put(catalogFile(home),catalogEntry('d'.repeat(40),'8.7.7'));
  return ['Approve'];
 };
 assert.equal(await runCli(args(root),io),3,output.join(''));
 assert.deepEqual(steps,[]);
 assert.equal(finalPreparation(reports).blockers[0]?.code,'native-target-changed');
})));

test('the fresh Claude catalog is rechecked after approval of the specific install',()=>project(root=>project(async home=>{
 const {io,reports,output}=cli(root,home),steps:string[]=[];
 await fakeClaude(io,root,home,steps);
 io.ask=async ({message})=>{
  if(message.includes('Claude Superpowers installation'))await put(catalogFile(home),catalogEntry('d'.repeat(40)));
  return ['Approve'];
 };
 assert.equal(await runCli(args(root),io),3,output.join(''));
 assert.deepEqual(steps,['marketplace']);
 assert.equal(finalPreparation(reports).blockers[0]?.code,'native-target-changed');
})));

test('recognized user-scope Claude and foreign OMP installs need neither a launcher nor a registry request',()=>project(root=>project(async home=>{
 const {io,questions,reports,output}=cli(root,home);
 const claude=join(home,'.claude/plugins/cache',market,'superpowers','4.3.2');
 await put(join(claude,'.claude-plugin/plugin.json'),{name:'superpowers'});
 await put(join(home,'.claude/settings.json'),{enabledPlugins:{[id]:true}});
 await put(join(home,'.claude/plugins/installed_plugins.json'),{version:2,plugins:{[id]:[{scope:'user',version:'4.3.2',installPath:claude}]}});
 const omp=join(home,'.omp/plugins'),foreign=join(omp,'node_modules',ompId),{files}=ompArchive('6.5.4-omp.2');
 for(const [file,text] of Object.entries(files))await put(join(foreign,file),text);
 await put(join(omp,'package.json'),{dependencies:{[ompId]:'6.5.4-omp.2'}});
 for(const name of requiredSkills)await put(join(claude,'skills',name,'SKILL.md'),files['skills/'+name+'/SKILL.md']);
 const setup=io.services!.nativeSetup!;
 setup.env!.PI_CONFIG_FILES='unused-overlay';
 setup.env!.PATH=setup.env!.RIGUP_CONSUMER_PATH=join(home,'no launchers');
 let requests=0,launches=0;
 setup.fetch=async()=>{requests++;throw Error('network unavailable');};
 setup.launch=async()=>{launches++;return {code:50};};
 assert.equal(await runCli(args(root,'claude,omp'),io),0,output.join(''));
 assert.deepEqual(finalPreparation(reports).hosts.map(({status})=>status),['ready','ready']);
 assert.deepEqual(finalPreparation(reports).blockers,[]);
 assert.equal(requests,0);
 assert.equal(launches,0);
 assert.deepEqual(questions,[]);
 for(const host of ['claude','omp'])assert.equal(approvalLines(output,host).length,1);
 assert.doesNotMatch(output.join(''),/Reopen|Superpowers is installed/);
})));

test('a previously recognized OMP source that disappears during approval reports drift',()=>project(root=>project(async home=>{
 const {io,reports,output}=cli(root,home),steps:string[]=[];
 await fakeClaude(io,root,home,steps);
 const {base,target,lock,archive,requests,commands}=await fakeOmp(io,home);
 for(const [file,text] of Object.entries(archive.files))await put(join(target,file),text);
 await put(lock,{plugins:{[ompId]:{enabled:true,version:archive.pin.version}}});
 await put(join(base,'package.json'),{dependencies:{[ompId]:archive.pin.version}});
 await put(join(home,'.omp/agent/config.yml'),'disabledProviders: [claude-plugins]\n');
 io.ask=async ({message})=>{
  if(!message.includes('Claude Superpowers installation'))await rm(target,{recursive:true});
  return ['Approve'];
 };
 assert.equal(await runCli(args(root,'claude,omp'),io),3,output.join(''));
 const result=finalPreparation(reports);
 assert.deepEqual(result.hosts.map(({status})=>status),['ready','manual']);
 assert.equal(result.blockers[0]?.code,'native-target-changed');
 assert.ok(result.blockers[0]?.evidence.some(path=>path.startsWith(target)));
 assert.deepEqual(requests,[]);
 assert.deepEqual(commands,[]);
})));

for(const mismatch of ['SHA','version'])test('Claude detects receipt '+mismatch+' drift after install',()=>project(root=>project(async home=>{
 const {io,reports,output}=cli(root,home),steps:string[]=[],sha='c'.repeat(40);
 await fakeClaude(io,root,home,steps,{catalogVersion:'8.7.6',installedVersion:mismatch==='version'?'8.7.7':'8.7.6',
  sha,installedSha:mismatch==='SHA'?'d'.repeat(40):sha});
 assert.equal(await runCli(args(root),io),1,output.join(''));
 const blocker=finalPreparation(reports).blockers[0];
 assert.equal(blocker.code,'claude-not-recognized-after-install');
 assert.ok(blocker.evidence.includes(catalogFile(home)));
 assert.ok(blocker.evidence.some(item=>item.includes('Approved SHA '+sha)));
 assert.ok(blocker.evidence.some(item=>item.includes(mismatch==='SHA'?'Installed SHA '+'d'.repeat(40):'Installed version 8.7.7')));
 assert.ok(blocker.suggest[0].includes('claude plugin uninstall'));
})));

test('native Superpowers renders a Chinese approval while passing the stable Approve value',()=>project(root=>project(async home=>{
 const {io,questions,output}=cli(root,home),steps:string[]=[];
 await fakeClaude(io,root,home,steps);
 const invoke=async(language:string)=>{
  let json='';
  const exit=await runCli([...args(root),'--language',language,'--review','--json'],{...io,write:text=>json+=text});
  assert.equal(exit,0,json);
  return json;
 };
 assert.equal(await invoke('zh-CN'),await invoke('en'));
 output.length=0;
 assert.equal(await runCli([...args(root),'--language','zh-CN'],io),0,output.join(''));
 assert.match(output[0],/^初始化: /);
 assert.deepEqual(questions.map(question=>question.message),['批准准备原生 Superpowers 吗？','批准安装这个 Claude Superpowers 目标吗？']);
 for(const question of questions)assert.deepEqual(question.choices,[{value:'Cancel',label:'取消'},{value:'Approve',label:'批准'}]);
 assert.match(output.join(''),/目录未提供版本/);
 assert.match(output.join(''),/^Claude：Superpowers 已安装，请重新打开 Claude。$/m);
 assert.match(output.join(''),/结果: 原生准备完成/);
 assert.deepEqual(steps,['marketplace','install']);
})));

test('native blocker advice is localized and the machine report is independent of the UI language',()=>project(root=>project(async home=>{
 const {io,output,questions}=cli(root,home);
 const env=io.services!.nativeSetup!.env!;
 env.PATH=env.RIGUP_CONSUMER_PATH=join(home,'missing-bin');
 const invoke=async(language:string,verbose=false)=>{
  output.length=0;
  let json='';
  const exit=await runCli([...args(root,'omp'),'--language',language,'--json',...(verbose?['--verbose']:[])],{...io,write:text=>json+=text});
  assert.equal(exit,3,json);
  return json;
 };
 const english=await invoke('en');
 assert.equal(await invoke('zh-CN'),english);
 const terse=output.join('');
 assert.equal(await invoke('zh-CN',true),english);
 assert.deepEqual(JSON.parse(english).nativePreparation.blockers.map((blocker:{code:string})=>blocker.code),['cli-not-runnable']);
 assert.match(terse,/OMP.*在 PATH 中找不到 omp.*cli-not-runnable/);
 assert.equal((terse.match(/Rigup 找到了需要先解决的问题/g)??[]).length,1);
 assert.doesNotMatch(terse,/相关文件和链接：|omp was not found on PATH/);
 assert.match(output.join(''),/相关文件和链接：/);
 assert.match(output.join(''),/请核实相关文件和链接并起草修复命令/);
 for(const outputIsTTY of [true,false]){
  output.length=0;
  assert.equal(await runCli([...args(root,'omp'),'--review','--verbose'],{...io,outputIsTTY}),0);
  assert.equal((output.join('').match(/draft the fix commands/g)??[]).length,outputIsTTY?0:1);
 }
 assert.equal(questions.length,0);
})));
