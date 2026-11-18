import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {test} from 'node:test';
import type {HostRuntime} from '../src/integrations/host-setup/runtime.js';
import {scanNativeEntries} from '../src/analyzer/repository.js';
import {project} from './helpers.js';

const market='claude-plugins-official';
const id='superpowers@'+market;
const sha='a'.repeat(40),version='9.8.7';
const names=['brainstorming','writing-plans','executing-plans','verification-before-completion'];
const load=()=>import('../src/integrations/host-setup/claude.js').catch(()=>undefined);
async function write(path:string,value:unknown){
 await mkdir(dirname(path),{recursive:true});
 await writeFile(path,typeof value==='string'?value:JSON.stringify(value));
}
function runtime(root:string,home:string):HostRuntime{
 return {root,home,stateRoot:join(home,'state'),writerRoot:join(home,'state'),env:{HOME:home,PATH:process.env.PATH},program:{file:process.execPath,args:[]},approved:'runtime'};
}
async function marketplace(home:string,source:unknown={source:'url',url:'https://github.com/obra/superpowers.git',sha},published?:string){
 const path=join(home,'.claude/plugins/marketplaces',market);
 await write(join(home,'.claude/plugins/known_marketplaces.json'),{
  [market]:{source:{source:'github',repo:'anthropics/claude-plugins-official'},installLocation:path},
 });
 await write(join(path,'.claude-plugin/marketplace.json'),{name:market,plugins:[{name:'superpowers',source,version:published}]});
 return path;
}

test('Claude verifies the official source of a cached marketplace item',()=>project(root=>project(async home=>{
 const c=await load();assert.ok(c,'Claude recipe is missing');
 const scope=runtime(root,home);
 assert.equal((await c.inspectClaude(scope)).market,'missing');
 await marketplace(home);
 assert.equal((await c.inspectClaude(scope)).market,'ready');
 for(const source of [
  {source:'url',url:'https://github.com/evil/superpowers.git',sha},
  {source:'url',url:'https://github.com/obra/superpowers.git'},
  {source:'url',url:'https://github.com/obra/superpowers.git',sha,ref:'main'},
 ]){
  await marketplace(home,source);
  await assert.rejects(c.inspectClaude(scope),{code:'claude-catalog-no-entry'});
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

test('Claude installation recognizes required entries from a different version and local scope',()=>project(root=>project(async home=>{
 const c=await load();assert.ok(c,'Claude recipe is missing');
 const scope=runtime(root,home);
 await marketplace(home);
 const path=join(home,'.claude/plugins/cache',market,'superpowers',version);
 await write(join(root,'.claude/settings.local.json'),{enabledPlugins:{[id]:true}});
 await write(join(path,'.claude-plugin/plugin.json'),{name:'superpowers'});
 for(const name of names)await write(join(path,'skills',name,'SKILL.md'),'---\nname: '+name+'\ndescription: Native fixture\n---\n');
 const receipt=join(home,'.claude/plugins/installed_plugins.json');
 const installed={scope:'local',projectPath:root,installPath:path,version,gitCommitSha:sha};
 await write(receipt,{version:2,plugins:{[id]:[{...installed,scope:'user',projectPath:undefined}]}});
 assert.equal((await c.inspectClaude(scope)).installed,undefined);
 await write(receipt,{version:2,plugins:{[id]:[installed,installed]}});
 await assert.rejects(c.inspectClaude(scope),/conflicting install receipt/);
 await write(receipt,{version:2,plugins:{[id]:[{...installed,projectPath:home},installed]}});
 const checked=await c.inspectClaude(scope);
 assert.equal(checked.installedSha,sha);
 assert.equal(checked.installedVersion,version);
 const opts={agents:['claude' as const],tools:[],backend:'host' as const,sdd:'superpowers' as const};
 const profile=await scanNativeEntries(root,opts,{home});
 assert.ok(c.claudeRecognized(checked,profile));
 const stale={...profile,skillSources:{claude:profile.skillSources!.claude!.map((source,i)=>i===0?{...source,identity:join(home,'unrelated','SKILL.md')}:source)}};
 assert.equal(c.claudeRecognized(checked,stale),false);
})));

test('Claude follows the official catalog SHA and accepts a cached Git mirror and an optional version',()=>project(root=>project(async home=>{
 const c=await load();assert.ok(c);
 const scope=runtime(root,home);
 const official={source:'url',url:'https://github.com/obra/superpowers.git',sha};
 const path=await marketplace(home,official);
 await write(join(path,'.git/config'),'[remote "origin"]\n url = https://mirror.example/claude-plugins-official.git\n');
 assert.deepEqual((await c.inspectClaude(scope)).target,{sha});
 await marketplace(home,official,version);
 assert.deepEqual((await c.inspectClaude(scope)).target,{sha,version});
 await marketplace(home,official,'rolling');
 await assert.rejects(c.inspectClaude(scope),{code:'claude-catalog-no-entry'});
 for(const source of [{...official,url:'https://example.test/superpowers.git'},{...official,sha:'not-a-sha'}]){
  await marketplace(home,source,version);
  await assert.rejects(c.inspectClaude(scope),{code:'claude-catalog-no-entry'});
 }
 await write(join(path,'.claude-plugin/marketplace.json'),{name:market,plugins:[]});
 await assert.rejects(c.inspectClaude(scope),{code:'claude-catalog-no-entry'});
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
