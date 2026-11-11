import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,readdir,realpath,rm,stat,writeFile} from 'node:fs/promises';
import {delimiter,dirname,join,resolve} from 'node:path';
import {arch,platform,release} from 'node:os';
import {createInterface} from 'node:readline';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {loadManifest,trustedBaseline} from '../src/installer/baseline.js';
import {markdownLinks} from '../src/generator/document-policy.js';
import {renderConventionSeed} from '../src/project-conventions.js';
import {disposable,live,record} from './live-support.js';
import {checkedLiveCommand,runLiveCommand,startLiveCommand,startLiveSession} from './live-process-support.js';

const nextBinary=fileURLToPath(new URL('../dist/cli.js',import.meta.url));
const currentVersion=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).version;
const versionCommit='be0ca645f9c99c6890adedb9bc7141e3ea720ab2';
const userEntry='# Team instructions\nKeep the team guide intact.\n';
const userCi='customer-build:\n  script:\n    - npm run build\n';
const setup=['--agents','codex','--sdd','none','--tools','none','--defer-research','--review'];
const sourceBody='Use the confirmed error response envelope.\n';
type Report={exitCode:number;previewId:string;projectRules?:string;executable?:boolean;written?:string[];checks?:{status:string}[];error?:string;installStatus:string};
const environment={platform:platform(),arch:arch(),release:release(),node:process.version,oldVersion:'0.3.5',newVersion:currentVersion,oldCommit:versionCommit};

function command(binary:string,args:string[]){
 return /\.[cm]?js$/i.test(binary)?{executable:process.execPath,args:[binary,...args]}:{executable:binary,args};
}

async function versions(env:NodeJS.ProcessEnv){
 const requested=process.env.RIGUP_V035_BIN;
 assert.ok(requested,'Set RIGUP_V035_BIN to a built v0.3.5 CLI or release launcher');
 const old=await realpath(requested);
 for(const [binary,expected] of [[old,'0.3.5'],[nextBinary,currentVersion]]){
  const version=command(binary,['--version']);
  assert.equal((await checkedLiveCommand(version.executable,version.args,{env,timeoutMs:10_000,maxBuffer:4000})).stdout.trim(),expected);
 }
 return old;
}

async function withFixture(name:string,run:(input:{root:string;control:string;env:NodeJS.ProcessEnv;old:string})=>Promise<void>){
 const control=await disposable('rigup-harness-upgrade-');
 try{
  const root=join(control,name),home=join(control,'home');
  await mkdir(root);await mkdir(home,{mode:0o700});await mkdir(join(home,'.codex'),{mode:0o700});
  const openspec=process.env.RIGUP_HARNESS_OPENSPEC_BIN;
  const env:NodeJS.ProcessEnv={
   PATH:[...(openspec?[dirname(resolve(openspec))]:[]),process.env.PATH??''].join(delimiter),
   HOME:home,USERPROFILE:home,CODEX_HOME:join(home,'.codex'),SystemRoot:process.env.SystemRoot,
   LANG:'en_US.UTF-8',NO_COLOR:'1',DO_NOT_TRACK:'1',OPENSPEC_TELEMETRY:'0',
  };
  const old=await versions(env);
  await writeFile(join(root,'README.md'),'# Demo service\nUse the narrow build check to verify a change.\n');
  await writeFile(join(root,'AGENTS.md'),userEntry);
  await writeFile(join(root,'package.json'),JSON.stringify({name:'upgrade-fixture',scripts:{build:'node --version'}})+'\n');
  await run({root,control,env,old});
 }finally{await rm(control,{recursive:true,force:true});}
}

async function cli(binary:string,root:string,env:NodeJS.ProcessEnv,expected:number,verb:string,...args:string[]):Promise<Report>{
 const invocation=command(binary,[verb,root,...args,'--json']);
 const result=await runLiveCommand(invocation.executable,invocation.args,{cwd:root,env,timeoutMs:90_000,maxBuffer:1_000_000});
 assert.equal(result.timedOut,false);
 assert.equal(result.code,expected,result.stdout+'\n'+result.stderr);
 return JSON.parse(result.stdout) as Report;
}

const applyArgs=(id:string)=>['--apply',id,'--sessions-ended'];

async function withRpc<T>(executable:string,args:string[],root:string,env:NodeJS.ProcessEnv,run:(send:(method:string,params:unknown,respond?:boolean)=>Promise<any>)=>Promise<T>):Promise<T>{
 const session=await startLiveSession(executable,args,{cwd:root,env});
 const lines=createInterface({input:session.stdout})[Symbol.asyncIterator]();
 session.stderr.resume();
 let id=0;
 try{
  return await run(async(method,params,respond=true)=>{
   const next=++id;
   session.stdin.write(JSON.stringify({jsonrpc:'2.0',method,params,...(respond?{id:next}:{})})+'\n');
   if(!respond)return;
   const timeout=new AbortController();
   try{
    const response=await Promise.race([(async()=>{
     for(;;){
      const line=await lines.next();
      if(line.done)throw Error('RPC session ended during '+method);
      const value=JSON.parse(line.value);
      if(value.id===next){
       assert.equal(value.error,undefined,JSON.stringify(value.error));
       return value.result;
      }
     }
    })(),delay(20_000,undefined,{signal:timeout.signal}).then(()=>{throw Error('RPC timed out during '+method);})]);
    return response;
   }finally{timeout.abort();}
  });
 }finally{session.stdin.end();await session.stop();}
}

async function readyPreview(binary:string,root:string,env:NodeJS.ProcessEnv){
 const invocation=command(binary,['mcp',root,'--host','codex']);
 return withRpc(invocation.executable,invocation.args,root,env,async send=>{
  const init=await send('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'upgrade-fixture',version:'1.0.0'}});
  assert.equal(init.serverInfo.version,'0.3.5');
  await send('notifications/initialized',{},false);
  const call=async(name:string,args:unknown)=>{
   const response=await send('tools/call',{name,arguments:args});
   assert.equal(response.isError??false,false,JSON.stringify(response));
   return response.structuredContent;
  };
  const begin=await call('rigup_begin',{root,mode:'init'});
  const runId=begin.runId;
  const data={observations:[],unknowns:[],ruleTopics:[{id:'build-verification',title:'Project build verification'}],guidance:[{
   topicId:'build-verification',topic:'Project build verification',scope:['.'],coverageStatus:'reusable',
   consumers:['agent-entry','prepare','deliver'],gaps:[],sourceRef:{path:'README.md',startLine:2,endLine:2}}]};
  const plan=await call('rigup_submit_plan',{runId,jobId:begin.job.id,data});
  const done=await call('rigup_submit_plan',{runId,jobId:plan.job.id,data:{...data,artifacts:[],dispositions:[]}});
  assert.equal(done.status,'ready');
  const review=await call('rigup_finish',{runId});
  assert.equal(review.preview.executable,true);
  return review.previewId as string;
 });
}

async function nativeReachability(root:string,env:NodeJS.ProcessEnv,authority:string){
 const client=(await checkedLiveCommand('codex',['--version'],{env,timeoutMs:15_000,maxBuffer:4000})).stdout.trim();
 await writeFile(join(env.CODEX_HOME!,'config.toml'),
  'sandbox_mode = "read-only"\napproval_policy = "never"\n[projects.'+JSON.stringify(root)+']\ntrust_level = "trusted"\n');
 const entries=await withRpc('codex',['app-server'],root,env,async send=>{
  await send('initialize',{clientInfo:{name:'rigup-harness-upgrade',version:'1.0.0'},capabilities:{experimentalApi:true}});
  await send('initialized',{},false);
  const found=await send('skills/list',{cwds:[root],forceReload:true});
  return new Map<string,string>(found.data.flatMap((scope:any)=>scope.skills.map((skill:any)=>[skill.name,skill.path])));
 });
 const checks=[];
 for(const [name,native] of [['change-prepare','openspec-propose'],['change-deliver','openspec-apply-change']]){
  const skill=join(root,'.agents','skills',name,'SKILL.md'),reference=join(dirname(skill),'references','project.md');
  assert.equal(await realpath(entries.get(name)!),await realpath(skill));
  assert.match(await readFile(skill,'utf8'),/references\/project\.md/);
  const links=[...markdownLinks(await readFile(reference,'utf8'))].map(match=>resolve(dirname(reference),decodeURIComponent(match[1])));
  const expected=[join(root,'README.md'),authority,entries.get(native)!];
  for(const file of expected){assert.ok(links.includes(file),name+' cannot reach '+file);assert.ok((await stat(file)).isFile());}
  assert.ok((await readFile(authority,'utf8')).endsWith(sourceBody));
  checks.push({skill:name,native,customerGuide:'README.md',convention:'knowledge/errors.md'});
 }
 return {client,checks};
}

test('harness upgrade preserves v035 installation', {skip:!live,timeout:180_000},async()=>{
 const cases=[];
 for(const kind of ['legacy-provider','modern-pending','modern-ready'] as const)await withFixture(kind,async({root,env,old})=>{
  let initial:Report,config:string|undefined;
  const configPath=join(root,'.rigup','config.yaml');
  let native:Awaited<ReturnType<typeof nativeReachability>>|undefined;
  let openspecVersion:string|undefined;
  if(kind==='legacy-provider'){
   await mkdir(join(root,'.rigup'));
   config=JSON.stringify({agents:['codex'],backend:'native',model:{provider:'anthropic',model:'fixture-model',apiKeyEnv:'RIGUP_FIXTURE_ONLY_KEY'},
    tools:[{id:'codegraph',install:true,initialize:true,agents:['codex']}],
    templates:[{source:'customer.tmpl',target:'docs/rigup/customer-guide.md'}],executionPolicy:{mode:'review'}})+'\n';
   await writeFile(configPath,config);
   await writeFile(join(root,'customer.tmpl'),'# Customer notes\nRun the scoped build.\n');
   await checkedLiveCommand('git',['-c','init.templateDir=','init','-q'],{cwd:root,env,timeoutMs:15_000});
   await mkdir(join(root,'src'));
   await writeFile(join(root,'src','service.js'),'export function createOrder(id) { return {id}; }\n');
   initial=await cli(old,root,env,3,'init','--sdd','none','--review');
  }else if(kind==='modern-ready'){
   await mkdir(join(root,'.rigup'));
   config=JSON.stringify({agents:['codex'],backend:'host',projectRules:true,sdd:'openspec',executionPolicy:{mode:'review'},
    quality:{gitlab:{checks:[{cwd:'.',script:'build'}]}}})+'\n';
   await writeFile(configPath,config);
   await writeFile(join(root,'.gitlab-ci.yml'),userCi);
   const openspec=process.env.RIGUP_HARNESS_OPENSPEC_BIN??'openspec';
   openspecVersion=(await checkedLiveCommand(openspec,['--version'],{cwd:root,env,timeoutMs:15_000})).stdout.trim();
   assert.equal(openspecVersion,'1.16.0');
   await checkedLiveCommand(openspec,['init','--tools','codex','--profile','core','--no-animation','--no-copilot-cloud',root],{cwd:root,env,timeoutMs:30_000});
   initial=await cli(old,root,env,3,'init','--agents','codex','--sdd','openspec','--tools','none','--defer-research','--review');
  }else initial=await cli(old,root,env,3,'init',...setup);
  assert.equal(initial.executable,true);
  await cli(old,root,env,0,'update',...applyArgs(initial.previewId));
  if(kind==='modern-ready')await cli(old,root,env,0,'update',...applyArgs(await readyPreview(old,root,env)));
  const previous=(await loadManifest(root))!;
  assert.equal(previous.projectRules,kind==='modern-ready'?'ready':kind==='modern-pending'?'pending':undefined);
  assert.equal(previous.versions?.read,'6');
  if(kind==='legacy-provider'){
   assert.ok(previous.installedTools?.codegraph);
   assert.ok(previous.initializedTools?.codegraph);
  }
  if(kind==='modern-ready')assert.ok(previous.assets.some(asset=>asset.logicalId==='project-development-rules'));
  const baselines=new Map(await Promise.all(previous.assets.map(async asset=>[asset.logicalId,await trustedBaseline(root,asset)] as const)));
  assert.ok(baselines.size&&[...baselines.values()].every(value=>value!==undefined));
  const authority=join(root,'knowledge','errors.md');
  const ci=join(root,'.gitlab-ci.yml'),jobs=join(root,'.rigup','gitlab-ci.yml');
  let priorCi:string|undefined,priorJobs:string|undefined;
  const prepareReference=join(root,'.agents','skills','change-prepare','references','project.md');
  const referenceNote='Customer note in the managed preparation reference.';
  if(kind==='modern-ready'){
   await mkdir(dirname(authority));
   const header=renderConventionSeed({topicId:'api-errors',title:'API errors',scope:'.',questions:['Confirm the response envelope']}).content;
   await writeFile(authority,header.replace('status: draft','status: confirmed')+sourceBody);
   priorCi=await readFile(ci,'utf8');assert.ok(priorCi.startsWith(userCi));
   priorJobs=await readFile(jobs,'utf8')+'# Customer job annotation\n';
   await writeFile(jobs,priorJobs);
   const reference=await readFile(prepareReference,'utf8');
   await writeFile(prepareReference,reference.replace('# Project context for preparation','# Project context for preparation\n\n'+referenceNote));
  }
  const preview=await cli(nextBinary,root,env,3,'update','--review');
  assert.equal(preview.executable,true);
  const applied=await cli(nextBinary,root,env,0,'update',...applyArgs(preview.previewId));
  assert.equal(applied.projectRules,previous.projectRules);
  assert.deepEqual(applied.checks,[]);
  const upgraded=(await loadManifest(root))!;
  assert.equal(upgraded.schemaVersion,1);
  assert.equal(upgraded.versions?.read,'7');
  assert.deepEqual(upgraded.options,previous.options);
  assert.deepEqual(upgraded.installedTools,previous.installedTools);
  assert.deepEqual(upgraded.initializedTools,previous.initializedTools);
  assert.deepEqual(upgraded.assets.map(asset=>asset.logicalId).sort(),previous.assets.map(asset=>asset.logicalId).sort());
  for(const asset of upgraded.assets){
   assert.deepEqual(asset.ownership,previous.assets.find(prior=>prior.logicalId===asset.logicalId)?.ownership);
   const actual=await trustedBaseline(root,asset),before=baselines.get(asset.logicalId);
   if(kind==='modern-ready'&&(asset.logicalId.startsWith('entry:')||asset.logicalId.endsWith(':context'))){
    assert.match(actual!,/rigup:harness:start[\s\S]*knowledge\/errors\.md/);
    assert.equal(actual!.replace(/<!-- rigup:harness:start -->[\s\S]*?<!-- rigup:harness:end -->\n/,''),before);
   }else assert.equal(actual,before,asset.logicalId);
  }
  if(config!==undefined)assert.equal(await readFile(configPath,'utf8'),config);
  assert.ok((await readFile(join(root,'AGENTS.md'),'utf8')).startsWith(userEntry));
  if(kind==='modern-ready'){
   assert.equal(await readFile(ci,'utf8'),priorCi);
   assert.equal(await readFile(jobs,'utf8'),priorJobs);
   assert.ok((await readFile(prepareReference,'utf8')).includes(referenceNote));
   native=await nativeReachability(root,env,authority);
  }
  const repeated=await cli(nextBinary,root,env,previous.projectRules==='pending'?3:0,'update','--review');
  assert.equal(repeated.previewId,undefined);
  cases.push({kind,previousAssets:previous.assets.length,upgradedAssets:upgraded.assets.length,projectRules:upgraded.projectRules,
   originalConfigPreserved:config!==undefined,installedToolReceipts:Object.keys(upgraded.installedTools??{}),
   nativeInitializationReceipts:Object.keys(upgraded.initializedTools??{}),openspecVersion,native,gitlabDiscoveryOnly:kind==='modern-ready'});
 });
 await record('harness-upgrade-installation',{status:'passed',...environment,cases});
});

test('harness upgrade rejects stale approval', {skip:!live,timeout:45_000},()=>withFixture('stale',async({root,env,old})=>{
 const approved=await cli(old,root,env,3,'init',...setup);
 const rejected=await cli(nextBinary,root,env,1,'update',...applyArgs(approved.previewId));
 assert.match(rejected.error??'',/implementation version changed|source snapshot version changed/i);
 assert.equal(await loadManifest(root),undefined);
 const fresh=await cli(nextBinary,root,env,3,'init',...setup);
 assert.notEqual(fresh.previewId,approved.previewId);
 await cli(nextBinary,root,env,0,'update',...applyArgs(fresh.previewId));
 await record('harness-upgrade-stale-approval',{status:'passed',...environment,oldApprovalRejected:true,newApprovalApplied:true});
}));

async function waitFor(path:string){
 for(let index=0;index<300;index++){
  if(await stat(path).then(()=>true,()=>false))return;
  await delay(50);
 }
 throw Error('Fixture process did not reach '+path);
}

test('harness upgrade preserves interrupted transaction', {skip:!live,timeout:90_000},()=>withFixture('interrupted',async({root,control,env,old})=>{
 const marker=join(control,'check-started'),releaseFile=join(control,'check-release'),done=join(control,'check-exited');
 await writeFile(join(root,'package.json'),JSON.stringify({name:'upgrade-fixture',scripts:{build:'node wait-check.mjs'}})+'\n');
 await writeFile(join(root,'wait-check.mjs'),`import {existsSync,writeFileSync} from 'node:fs';
const marker=process.env.RIGUP_HARNESS_INTERRUPT_MARKER;
if(marker){
 writeFileSync(marker,'started');
 const end=Date.now()+20_000;
 const timer=setInterval(()=>{
  if(!existsSync(process.env.RIGUP_HARNESS_RELEASE)&&Date.now()<end)return;
  clearInterval(timer);
  writeFileSync(process.env.RIGUP_HARNESS_EXITED,'exited');
 },20);
}
`);
 const replacement=await cli(nextBinary,root,env,3,'init',...setup);
 const original=await cli(old,root,env,3,'init',...setup,'--run-checks','build');
 const invocation=command(old,['update',root,...applyArgs(original.previewId),'--json']);
 const process=startLiveCommand(invocation.executable,invocation.args,{cwd:root,env:{...env,
  RIGUP_HARNESS_INTERRUPT_MARKER:marker,RIGUP_HARNESS_RELEASE:releaseFile,RIGUP_HARNESS_EXITED:done}});
 process.stdout.resume();process.stderr.resume();
 let journal:string|undefined,initial:Buffer|undefined;
 try{
  await waitFor(marker);
  const state=join(env.HOME!,'.local','state','rigup');
  const file=(await readdir(state)).find(name=>name.endsWith('.apply.json'));
  assert.ok(file);
  journal=join(state,file);initial=await readFile(journal);
  const tx=JSON.parse(initial.toString('utf8'));
  assert.equal(tx.status,'prepared');assert.equal(tx.previewId,original.previewId);
  assert.equal(await loadManifest(root),undefined);
  assert.ok((await readFile(join(root,'AGENTS.md'),'utf8')).includes('rigup:start'));
 }finally{
  await process.stop('SIGKILL');
  await writeFile(releaseFile,'release');
  if(platform()!=='win32'&&initial)await waitFor(done);
 }
 assert.ok(journal&&initial);
 for(const args of [
  [...applyArgs(original.previewId),'--resume'],['--resume','--review'],
  [...applyArgs(replacement.previewId),'--resume'],
 ]){
  const rejected=await cli(nextBinary,root,env,1,'update',...args);
  assert.match(rejected.error??'',/original.*Rigup|version changed/i);
  assert.deepEqual(await readFile(journal),initial);
  assert.equal(await loadManifest(root),undefined);
 }
 const resumed=await cli(old,root,env,0,'update',...applyArgs(original.previewId),'--resume');
 assert.equal(resumed.projectRules,'pending');
 assert.equal(resumed.checks?.[0]?.status,'passed');
 const fresh=await cli(nextBinary,root,env,3,'update','--review');
 await cli(nextBinary,root,env,0,'update',...applyArgs(fresh.previewId));
 await record('harness-upgrade-interrupted',{status:'passed',...environment,oldProcessKilledDuring:'approved npm build',
  durableJournalPreserved:true,differentApprovalRejected:true,originalBinaryResumed:true,newApprovalApplied:true});
}));
