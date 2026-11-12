import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {project} from './helpers.js';
import {scanRepository} from '../src/analyzer/repository.js';
import {prepareIntegrations} from '../src/integrations/registry.js';

const options={agents:['codex' as const],backend:'host' as const,sdd:'superpowers' as const};
async function plugin(home:string,market:string,directory:string,version:string){
 const root=join(home,'.codex/plugins/cache',market,'superpowers',directory);
 await mkdir(join(root,'.claude-plugin'),{recursive:true});
 await writeFile(join(root,'.claude-plugin/plugin.json'),JSON.stringify({name:'superpowers',version}));
 for(const name of ['brainstorming','writing-plans','executing-plans','verification-before-completion']){
  await mkdir(join(root,'skills',name),{recursive:true});
  await writeFile(join(root,'skills',name,'SKILL.md'),'---\nname: '+name+'\ndescription: Native workflow\n---\nKeep native requirements.\n');
 }
 return root;
}
async function config(home:string,content:string){await mkdir(join(home,'.codex'),{recursive:true});await writeFile(join(home,'.codex/config.toml'),content);}
test('Codex isolates enabled missing and malformed plugin records before a valid native source',()=>project(root=>project(async home=>{
 await config(home,'[plugins."superpowers@missing"]\nenabled=true\n[plugins."superpowers@broken"]\nenabled=true\n[plugins."superpowers@good"]\nenabled=true\n');
 const bad=await plugin(home,'broken','7.0.1','7.0.1');
 await writeFile(join(bad,'.claude-plugin/plugin.json'),'{ malformed private-value-should-not-leak');
 await plugin(home,'good','7.0.1','7.0.1');
 const profile=await scanRepository(root,options,{home});
 const prepared=await prepareIntegrations(profile,options);
 assert.equal(prepared.bindings.length,1);assert.equal(prepared.requirements.length,0);
 assert.match(profile.unknowns.join('\n'),/superpowers@missing.*skipped/);
 assert.match(profile.unknowns.join('\n'),/superpowers@broken.*skipped/);
 assert.doesNotMatch(profile.unknowns.join('\n'),/private-value-should-not-leak/);
})));
test('Codex ignores incomplete cached versions when one verified plugin remains',()=>project(root=>project(async home=>{
 await config(home,'[plugins."superpowers@good"]\nenabled=true\n');
 await mkdir(join(home,'.codex/plugins/cache/good/superpowers/incomplete'),{recursive:true});
 await plugin(home,'good','7.0.1','7.0.1');
 const profile=await scanRepository(root,options,{home});
 const prepared=await prepareIntegrations(profile,options);
 assert.equal(prepared.bindings.length,1);assert.equal(prepared.requirements.length,0,JSON.stringify(prepared.requirements));
 assert.match(profile.unknowns.join('\n'),/superpowers@good.*skipped/);
})));
test('Codex ignores disabled records while a real required version mismatch stays blocked',()=>project(root=>project(async home=>{
 await config(home,'[plugins."superpowers@disabled"]\nenabled=false\n[plugins."superpowers@good"]\nenabled=true\n');
 await plugin(home,'good','7.0.0','7.0.0');
 const profile=await scanRepository(root,options,{home});
 const prepared=await prepareIntegrations(profile,options);
 assert.equal(prepared.bindings.length,0);assert.ok(prepared.requirements.some(item=>/version|verified/.test(item.reason)));
 assert.doesNotMatch(profile.unknowns.join('\n'),/disabled/);
})));
