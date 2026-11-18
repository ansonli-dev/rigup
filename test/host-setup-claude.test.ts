import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {test} from 'node:test';
import type {HostRuntime} from '../src/integrations/host-setup/runtime.js';
import {scanNativeEntries} from '../src/analyzer/repository.js';
import {project} from './helpers.js';

const market='claude-plugins-official';
const id='superpowers@'+market;
const sha='22f0b463e7a5e579904dd6211a520321035526f7';
const names=['brainstorming','writing-plans','executing-plans','verification-before-completion'];
const load=()=>import('../src/integrations/host-setup/claude.js').catch(()=>undefined);
async function write(path:string,value:unknown){
 await mkdir(dirname(path),{recursive:true});
 await writeFile(path,typeof value==='string'?value:JSON.stringify(value));
}
function runtime(root:string,home:string):HostRuntime{
 return {root,home,stateRoot:join(home,'state'),writerRoot:join(home,'state'),env:{HOME:home,PATH:process.env.PATH},program:{file:process.execPath,args:[]},approved:'runtime'};
}
async function marketplace(home:string,source:unknown={source:'url',url:'https://github.com/obra/superpowers.git',sha}){
 const path=join(home,'.claude/plugins/marketplaces',market);
 await write(join(home,'.claude/plugins/known_marketplaces.json'),{
  [market]:{source:{source:'github',repo:'anthropics/claude-plugins-official'},installLocation:path},
 });
 await write(join(path,'.claude-plugin/marketplace.json'),{name:market,plugins:[{name:'superpowers',source}]});
}

test('Claude skips a registered marketplace only after verifying the exact cached item',()=>project(root=>project(async home=>{
 const c=await load();assert.ok(c,'Claude recipe is missing');
 const scope=runtime(root,home);
 assert.equal((await c.inspectClaude(scope)).market,'missing');
 await marketplace(home);
 assert.equal((await c.inspectClaude(scope)).market,'ready');
 for(const source of [
  {source:'url',url:'https://github.com/evil/superpowers.git',sha},
  {source:'url',url:'https://github.com/obra/superpowers.git',sha:'1'.repeat(40)},
  {source:'url',url:'https://github.com/obra/superpowers.git',sha,ref:'main'},
 ]){
  await marketplace(home,source);
  await assert.rejects(c.inspectClaude(scope),/pinned Superpowers/);
 }
})));

test('Claude rejects duplicate settings, wrong marketplace source and explicit Superpowers conflicts',()=>project(root=>project(async home=>{
 const c=await load();assert.ok(c,'Claude recipe is missing');
 const scope=runtime(root,home),path=join(root,'.claude/settings.json');
 for(const [settings,reason] of [
  [{extraKnownMarketplaces:{[market]:{source:{source:'github',repo:'example/other'}}}},/marketplace/],
  ['{"model":"a","model":"b"}',/invalid.*settings/i],
  [{enabledPlugins:{[id]:false}},/explicitly disabled/],
  [{enabledPlugins:{[id]:true}},/enabled without.*receipt/],
 ] as const){
  await write(path,settings);
  await assert.rejects(c.inspectClaude(scope),reason);
 }
})));

test('Claude accepts unrelated Git settings, project settings and installed plugins',()=>project(root=>project(async home=>{
 const c=await load();assert.ok(c);
 await write(join(root,'.git/config'),'[includeIf "gitdir:~/code/"]\n path = ~/.gitconfig-work\n[credential]\n helper = manager\n[lfs]\n repositoryformatversion = 0\n');
 const source={source:'github',repo:'example/unrelated'};
 await write(join(root,'.claude/settings.json'),{hooks:{},env:{NODE_ENV:'development'},
  enabledPlugins:{'unrelated@custom':true},extraKnownMarketplaces:{custom:{source}}});
 await write(join(home,'.claude/plugins/known_marketplaces.json'),{custom:{source,installLocation:join(home,'custom')}});
 await write(join(home,'.claude/plugins/installed_plugins.json'),{version:2,plugins:{'unrelated@custom':[{scope:'user'}]}});
 const checked=await c.inspectClaude(runtime(root,home));
 assert.equal(checked.market,'missing');
 assert.equal(checked.installed,undefined);
})));

test('Claude installation checks all resolved required entries against the exact scoped receipt',()=>project(root=>project(async home=>{
 const c=await load();assert.ok(c,'Claude recipe is missing');
 const scope=runtime(root,home);
 await marketplace(home);
 const path=join(home,'.claude/plugins/cache',market,'superpowers','7.0.2');
 await write(join(root,'.claude/settings.json'),{enabledPlugins:{[id]:true}});
 await write(join(path,'.claude-plugin/plugin.json'),{name:'superpowers'});
 for(const name of names)await write(join(path,'skills',name,'SKILL.md'),'---\nname: '+name+'\ndescription: Native fixture\n---\n');
 const receipt=join(home,'.claude/plugins/installed_plugins.json');
 const installed={scope:'project',projectPath:root,installPath:path,version:'7.0.2',gitCommitSha:sha};
 await write(receipt,{version:2,plugins:{[id]:[{...installed,scope:'user'}]}});
 await assert.rejects(c.inspectClaude(scope),/different scope/);
 await write(receipt,{version:2,plugins:{[id]:[installed,installed]}});
 await assert.rejects(c.inspectClaude(scope),/conflicting install receipt/);
 await write(receipt,{version:2,plugins:{[id]:[{...installed,projectPath:home},installed]}});
 const checked=await c.inspectClaude(scope);
 const opts={agents:['claude' as const],tools:[],backend:'host' as const,sdd:'superpowers' as const};
 const profile=await scanNativeEntries(root,opts,{home});
 assert.ok(c.claudeRecognized(checked,profile));
 const stale={...profile,skillSources:{claude:profile.skillSources!.claude!.map((source,i)=>i===0?{...source,identity:join(home,'unrelated','SKILL.md')}:source)}};
 assert.equal(c.claudeRecognized(checked,stale),false);
})));

test('only the install child denies official marketplace refresh, and it uses scoped literal argv',async()=>{
 const c=await load();assert.ok(c,'Claude recipe is missing');
 const scope=runtime(process.cwd(),process.cwd());
 const add=c.claudeCommand(scope,process.cwd(),'marketplace');
 const install=c.claudeCommand(scope,process.cwd(),'install');
 assert.deepEqual(add.args,['--setting-sources','user','plugin','marketplace','add','anthropics/claude-plugins-official','--scope','project']);
 assert.deepEqual(install.args,['--setting-sources','user','plugin','install',id,'--scope','project']);
 assert.equal(install.env.GIT_ALLOW_PROTOCOL,'https');
 const values=(env:NodeJS.ProcessEnv)=>Object.entries(env).filter(([key])=>key.startsWith('GIT_CONFIG_VALUE_')).map(([,value])=>value);
 assert.ok(values(install.env).includes('https://github.com/anthropics/claude-plugins-official'));
 assert.ok(values(install.env).includes('git@github.com:anthropics/claude-plugins-official'));
 assert.ok(!values(add.env).includes('https://github.com/anthropics/claude-plugins-official'));
});
