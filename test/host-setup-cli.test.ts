import assert from 'node:assert/strict';
import {mkdir,stat,writeFile} from 'node:fs/promises';
import {delimiter,dirname,join} from 'node:path';
import {test} from 'node:test';
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
 const io:CliIO={cwd:root,isTTY:true,outputIsTTY:true,write:t=>output.push(t),writeError:t=>output.push(t),services:{
  stateRoot,report:r=>reports.push(r),nativeSetup:{
   home,env:{...process.env,HOME:home,USERPROFILE:home,CLAUDE_CONFIG_DIR:join(home,'.claude'),
    PI_CODING_AGENT_DIR:undefined,XDG_CONFIG_HOME:undefined,RIGUP_CONSUMER_PATH:undefined,PATH:[join(home,'bin'),process.env.PATH??''].join(delimiter)},
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

test('native approval requires explicit consent and refuses a settings change after preview',()=>project(root=>project(async home=>{
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
 assert.equal(await runCli(args(root),io),3);
 assert.deepEqual(steps,[]);
 assert.doesNotMatch(output.join(''),/SUPPRESSED_HOST_OUTPUT/);
})));

test('native preparation verifies a completed step before retry, and recognizes a Claude import without an OMP write',()=>project(root=>project(async home=>{
 const {io,output}=cli(root,home),steps:string[]=[];
 await fakeClaude(io,root,home,steps,true);
 assert.equal(await runCli(args(root),io),1);
 assert.deepEqual(steps,['marketplace','install']);
 const {rm}=await import('node:fs/promises');
 await rm(join(home,'bin'),{recursive:true});
 await fakeClaude(io,root,home,steps);
 assert.equal(await runCli(args(root,'claude,omp'),io),0);
 assert.deepEqual(steps,['marketplace','install','install']);
 assert.match(output.join(''),/omp:.*recognized.*Claude/i);
 assert.doesNotMatch(output.join(''),/SUPPRESSED_HOST_OUTPUT/);
 await missing(join(home,'.omp'));
 assert.equal(await runCli(args(root,'claude,omp'),io),0);
 assert.equal(steps.length,3);
})));
