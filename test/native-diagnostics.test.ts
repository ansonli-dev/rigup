import assert from 'node:assert/strict';
import {chmod,copyFile,mkdir,writeFile} from 'node:fs/promises';
import {delimiter,dirname,join} from 'node:path';
import {test} from 'node:test';
import {scanNativeEntries} from '../src/analyzer/repository.js';
import {prepareIntegrations} from '../src/integrations/registry.js';
import type {Agent,SetupOptions} from '../src/types.js';
import {project} from './helpers.js';

const id='superpowers@claude-plugins-official';
const ompPackage='@loneexile/omp-superpowers';
const names=['brainstorming','writing-plans','executing-plans','verification-before-completion'];
const options=(agent:Agent):SetupOptions=>({agents:[agent],sdd:'superpowers',tools:[],backend:'host'});
async function supportedInput(home:string,host:'claude'|'omp'){
 const bin=join(home,'test tools');
 await mkdir(bin);
 const program=join(bin,host+(process.platform==='win32'?'.exe':''));
 await copyFile(process.execPath,program);
 if(process.platform!=='win32')await chmod(program,0o700);
 const path=bin+delimiter+(process.env.PATH??'');
 return {home,stateRoot:join(home,'state'),env:{...process.env,HOME:home,USERPROFILE:home,PATH:path,
  RIGUP_CONSUMER_PATH:path,CLAUDE_CONFIG_DIR:undefined,PI_CODING_AGENT_DIR:undefined,XDG_CONFIG_HOME:undefined}};
}
async function put(root:string,path:string,value:unknown){
 const target=join(root,path);
 await mkdir(dirname(target),{recursive:true});
 await writeFile(target,typeof value==='string'?value:JSON.stringify(value));
}
async function skills(root:string,body:string){
 for(const name of names)await put(root,'skills/'+name+'/SKILL.md','---\nname: '+name+'\ndescription: Native fixture\n---\n'+body);
}
async function claudeReceipt(home:string,root?:string,complete=true){
 const path=join(home,'.claude/plugins/cache/claude-plugins-official/superpowers/7.0.2');
 await put(home,'.claude/plugins/installed_plugins.json',{version:2,plugins:{[id]:[{scope:root?'project':'user',projectPath:root,installPath:path,version:'7.0.2'}]}});
 if(complete){await put(path,'.claude-plugin/plugin.json',{name:'superpowers'});await skills(path,'Claude plugin');}
}
async function ompFixture(base:string){
 await put(base,'omp-plugins.lock.json',{plugins:{[ompPackage]:{version:'7.0.2-omp.3',enabled:true}}});
 const pkg=join(base,'node_modules',ompPackage);
 await put(pkg,'package.json',{name:ompPackage,version:'7.0.2-omp.3',omp:{extensions:['extension.js']}});
 await put(pkg,'extension.js','// fixture\n');
 await skills(pkg,'OMP plugin');
}

test('explains a real filtered Claude user plugin without invalidating the native preview',()=>project(root=>project(async home=>{
 const opts=options('omp');
 const missing=await scanNativeEntries(root,opts,{home});
 assert.equal(missing.nativeDiagnostics?.length??0,0);
 await claudeReceipt(home,undefined,false);
 const dangling=await scanNativeEntries(root,opts,{home});
 assert.equal(dangling.nativeDiagnostics?.some(item=>item.code==='omp-claude-provider-filtered')??false,false);
 await claudeReceipt(home);
 const filtered=await scanNativeEntries(root,opts,{home});
 assert.equal(filtered.fingerprint,missing.fingerprint);
 assert.deepEqual(filtered.unknowns,missing.unknowns);
 assert.equal(filtered.nativeDiagnostics?.find(item=>item.code==='omp-claude-provider-filtered')?.subject,id);
 const pending=(await prepareIntegrations(filtered,opts,await supportedInput(home,'omp'))).requirements[0];
 assert.match(pending.reason,/enabledProviders.*claude-plugins/);
 assert.match(pending.nextCommand??'',/--agents omp --sdd superpowers --prepare-native$/);
 await put(home,'.omp/agent/config.yml','enabledProviders: [claude-plugins]\n');
 const enabled=await scanNativeEntries(root,opts,{home});
 assert.equal(enabled.nativeDiagnostics?.some(item=>item.code==='omp-claude-provider-filtered')??false,false);
 assert.equal((await prepareIntegrations(enabled,opts)).bindings.length,1);
})));

test('points to terminal preparation only for an absent workflow',()=>project(root=>project(async home=>{
 const opts=options('claude');
 const input=await supportedInput(home,'claude');
 const absent=await prepareIntegrations(await scanNativeEntries(root,opts,{home}),opts,input);
 assert.match(absent.requirements[0].nextCommand??'',/--prepare-native$/);
 await put(root,'.claude/settings.json',{hooks:{}});
 const unsafe=await prepareIntegrations(await scanNativeEntries(root,opts,{home}),opts,input);
 assert.match(unsafe.requirements[0].reason,/unsupported Claude project key.*hooks/i);
 assert.doesNotMatch(unsafe.requirements[0].nextCommand??'',/--prepare-native/);
 await claudeReceipt(home,root);
 await put(root,'.claude/settings.json',{enabledPlugins:{[id]:false}});
 const disabled=await prepareIntegrations(await scanNativeEntries(root,opts,{home}),opts);
 assert.match(disabled.requirements[0].reason,/explicitly disabled/);
 assert.doesNotMatch(disabled.requirements[0].nextCommand??'',/--prepare-native/);
 await put(root,'.claude/settings.json',{enabledPlugins:{[id]:true}});
 const plugin=join(home,'.claude/plugins/cache/claude-plugins-official/superpowers/7.0.2');
 await put(plugin,'.claude-plugin/plugin.json','{');
 const corrupt=await scanNativeEntries(root,opts,{home});
 assert.ok(corrupt.unknowns.some(item=>item.includes(id)));
 assert.ok(corrupt.nativeDiagnostics?.some(item=>item.code==='plugin-skipped'&&item.subject===id));
 const pending=await prepareIntegrations(corrupt,opts);
 assert.match(pending.requirements[0].reason,/repair the enabled installation/);
 assert.doesNotMatch(pending.requirements[0].nextCommand??'',/--prepare-native/);
})));

test('OMP selects its Superpowers provider over the corresponding Claude import only',()=>project(root=>project(async home=>{
 const opts=options('omp');
 await claudeReceipt(home,root);
 const inherited=await prepareIntegrations(await scanNativeEntries(root,opts,{home}),opts);
 assert.equal(inherited.bindings.length,1);
 await ompFixture(join(home,'.omp/plugins'));
 const both=await scanNativeEntries(root,opts,{home});
 assert.ok(both.skillSources?.omp?.every(source=>source.packageName===ompPackage));
 assert.equal((await prepareIntegrations(both,opts)).bindings.length,1);
 const path=join(home,'.claude/plugins/other');
 await put(path,'.claude-plugin/plugin.json',{name:'other'});
 await skills(path,'Unrelated plugin');
 const official=join(home,'.claude/plugins/cache/claude-plugins-official/superpowers/7.0.2');
 await put(home,'.claude/plugins/installed_plugins.json',{version:2,plugins:{
  [id]:[{scope:'project',projectPath:root,installPath:official}],
  'other@market':[{scope:'project',projectPath:root,installPath:path}],
 }});
 const colliding=await prepareIntegrations(await scanNativeEntries(root,opts,{home}),opts);
 assert.match(colliding.requirements[0]?.reason??'',/skill source conflict/);
})));

test('named OMP profile keeps its settings even with an agent directory override',()=>project(root=>project(async home=>{
 const opts=options('omp');
 const profile=join(home,'.omp/profiles/work');
 await ompFixture(join(profile,'plugins'));
 await put(profile,'agent/config.yml','skills:\n  enabled: false\n');
 const env={OMP_PROFILE:'work',PI_CODING_AGENT_DIR:join(home,'wrong')};
 const result=await prepareIntegrations(await scanNativeEntries(root,opts,{home,env}),opts);
 assert.match(result.requirements[0]?.reason??'',/skills.enabled:false/);
 assert.doesNotMatch(result.requirements[0]?.nextCommand??'',/--prepare-native/);
})));
