import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {project} from './helpers.js';
import {scanRepository} from '../src/analyzer/repository.js';
import {generateFoundation,prepareGeneration} from '../src/generator/generate.js';
import {preview} from '../src/installer/preview.js';
import {apply} from '../src/installer/apply.js';
import {loadManifest} from '../src/installer/baseline.js';
import {doctor} from '../src/installer/doctor.js';
import {mergeManaged} from '../src/installer/merge.js';
import {equalOwnedContent} from '../src/installer/ownership.js';
import type {SetupOptions} from '../src/types.js';

const options:SetupOptions={agents:['claude'],backend:'host',projectRules:true};
async function plan(root:string,selected=options){
 const profile=await scanRepository(root,selected);
 return generateFoundation(profile,selected,await prepareGeneration(profile,selected),(await loadManifest(root))?.assets??[]);
}
test('Claude skips each unreadable plugin and still binds the later verified Superpowers plugin',()=>project(root=>project(home=>project(async cache=>{
 const claude=join(home,'.claude'),valid=join(claude,'plugins/cache/market/superpowers/7.0.1');
 await mkdir(join(valid,'.claude-plugin'),{recursive:true});
 await writeFile(join(valid,'.claude-plugin/plugin.json'),JSON.stringify({name:'superpowers',version:'7.0.1'}));
 for(const name of ['brainstorming','writing-plans','executing-plans','verification-before-completion']){
  await mkdir(join(valid,'skills',name),{recursive:true});
  await writeFile(join(valid,'skills',name,'SKILL.md'),'---\nname: '+name+'\ndescription: Native workflow\n---\nKeep native requirements.\n');
 }
 await writeFile(join(claude,'settings.json'),JSON.stringify({enabledPlugins:{'typescript-lsp@market':true,'superpowers@market':true}}));
 await writeFile(join(claude,'plugins/installed_plugins.json'),JSON.stringify({plugins:{
  'typescript-lsp@market':[{scope:'user',installPath:join(claude,'plugins/cache/market/typescript-lsp/1.0.0')}],
  'superpowers@market':[{scope:'user',installPath:valid}],
 }}));
 const selected={...options,sdd:'superpowers' as const};
 const profile=await scanRepository(root,selected,{home});
 const prepared=await prepareGeneration(profile,selected);
 const result=await preview(await generateFoundation(profile,selected,prepared),[],{cacheRoot:cache});
 assert.equal(result.executable,true,result.blockers.join('\n'));
 assert.equal(prepared.integration.bindings.length,1);
 assert.match(result.warnings.join('\n'),/typescript-lsp.*(?:missing|ENOENT|manifest)/i);
}))));
test('text ownership treats CRLF as equivalent and still preserves real edits on retirement',()=>{
 const selector={kind:'block' as const,start:'# rigup:start',end:'# rigup:end'};
 const base='# rigup:start\nmanaged\n# rigup:end\n',local=base.replaceAll('\n','\r\n');
 const equals=(a:string,b:string)=>equalOwnedContent(selector,a,b);
 assert.equal(equals(base,local),true);
 assert.equal(mergeManaged(base,local,base,{action:'update',equals}).action,'noop');
 assert.equal(mergeManaged(base,local,undefined,{action:'remove',equals}).action,'remove');
 assert.equal(mergeManaged(base,local.replace('managed','customer'),undefined,{action:'remove',equals}).action,'conflict');
 assert.equal(equalOwnedContent({kind:'file'},'a\nb\n','a\r\nb\r\n'),true);
 assert.equal(equalOwnedContent({kind:'file'},'a\nb\n','a\nb \n'),false);
});
test('fresh clone adopts matching generated files without changing their bytes and keeps real conflicts',()=>project(root=>project(cache=>project(async state=>{
 const generated=await plan(root);
 for(const asset of generated.assets){
  await mkdir(join(root,asset.target,'..'),{recursive:true});
  // All generated assets in this fixture own files or a single block/key in an otherwise empty file.
 }
 const initial=await preview(generated,[],{cacheRoot:cache});
 assert.equal(initial.executable,true,initial.blockers.join('\n'));
 await apply(initial.previewId,{cacheRoot:cache,stateRoot:state});
 const manifest=(await loadManifest(root))!;
 const targets=[...new Set(manifest.assets.map(a=>a.target))];
 for(const target of targets){const text=await readFile(join(root,target),'utf8');await writeFile(join(root,target),text.replace(/\r?\n/g,'\r\n'));}
 await rm(join(root,'.rigup/manifest.json'));
 await rm(join(root,'.rigup/baseline'),{recursive:true});
 const before=await Promise.all(targets.map(target=>readFile(join(root,target))));
 const adopted=await preview(await plan(root),[],{cacheRoot:cache});
 assert.equal(adopted.executable,true,adopted.blockers.join('\n'));
 await apply(adopted.previewId,{cacheRoot:cache,stateRoot:state});
 assert.deepEqual(await Promise.all(targets.map(target=>readFile(join(root,target)))),before);
 const diagnostics=await doctor(root,{stateRoot:state});
 assert.ok(manifest.assets.every(asset=>diagnostics.diagnostics.some(d=>d.id===asset.logicalId&&d.state==='configured')),JSON.stringify(diagnostics.diagnostics));
 const stable=await preview(await plan(root),[],{cacheRoot:cache,skipUnchanged:true,reviewEntryBlocks:true});
 assert.equal(stable.noChanges,true);
 await writeFile(join(root,'CLAUDE.md'),(await readFile(join(root,'CLAUDE.md'),'utf8')).replace(/^(.*rigup:start.*\r?\n)/m,'$1Customer edit\r\n'));
 const conflict=await preview(await plan(root),[],{cacheRoot:cache,reviewEntryBlocks:true});
 assert.equal(conflict.executable,false);
 assert.match(conflict.blockers.join('\n'),/Local edit/);
}))));
