import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,symlink,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {project} from './helpers.js';
import {repositoryReader,scanRepository} from '../src/analyzer/repository.js';
import {prepareIntegrations} from '../src/integrations/registry.js';
import type {SetupOptions} from '../src/types.js';

async function put(root:string,path:string,text:string){
 const file=join(root,path);
 await mkdir(dirname(file),{recursive:true});
 await writeFile(file,text);
}

test('research ignore applies gitignore rules before exposing or hashing evidence',()=>project(async root=>{
 const options:SetupOptions={agents:['claude'],backend:'host',projectRules:true};
 await put(root,'.rigupignore','/docs/generated/*.md\n!/docs/generated/keep.md\n!/.env\n');
 await put(root,'docs/generated/drop.md','private context\n');
 await put(root,'docs/generated/keep.md','relevant context\n');
 await put(root,'.env','PRIVATE=never-read');
 const profile=await scanRepository(root,options);
 const reader=await repositoryReader(root,options);
 assert.deepEqual(await reader.list(),['docs/generated/keep.md']);
 await assert.rejects(()=>reader.read('docs/generated/drop.md',1,1),/outside reader inventory/);
 assert.deepEqual(await reader.search('private context'),[]);
 await put(root,'docs/generated/drop.md','replaced private context\n');
 assert.equal((await scanRepository(root,options)).fingerprint,profile.fingerprint);
 await put(root,'.rigupignore','/docs/generated/*.md\n');
 assert.notEqual((await scanRepository(root,options)).fingerprint,profile.fingerprint);
}));

test('workflow entrypoints stay bindable without becoming project rule evidence',()=>project(async root=>{
 const options:SetupOptions={agents:['claude'],backend:'host',projectRules:true,sdd:'openspec'};
 const entry='.claude/skills/openspec-propose/SKILL.md';
 for(const name of ['openspec-propose','openspec-apply-change','openspec-archive-change']){
  await put(root,'.claude/skills/'+name+'/SKILL.md','---\nname: '+name+'\ndescription: test fixture\n---\nNative workflow only\n');
 }
 await put(root,'.claude/skills/openspec-propose/reference.md','Workflow template only\n');
 await put(root,'.specify/templates/plan.md','Generated plan template\n');
 await put(root,'.specify/memory/constitution.md','Local governance\n');
 await put(root,'openspec/specs/orders/spec.md','Current product specification\n');
 await put(root,'openspec/changes/working/tasks.md','Unapproved work\n');
 const profile=await scanRepository(root,options);
 const reader=await repositoryReader(root,options);
 assert.deepEqual((await reader.list()).sort(),['.specify/memory/constitution.md','openspec/specs/orders/spec.md']);
 assert.ok((await prepareIntegrations(profile,options)).bindings[0]?.projectSources?.includes(entry));
 await assert.rejects(()=>reader.read(entry,1,1),/outside reader inventory/);
}));

test('a symlinked research ignore file is rejected',()=>project(async root=>{
 await put(root,'local-ignore','*.md');
 if(process.platform==='win32')return; // Windows symlink creation may require Developer Mode.
 await symlink('local-ignore',join(root,'.rigupignore'));
 await assert.rejects(()=>repositoryReader(root,{agents:['claude'],backend:'host'}),/symlink denied/);
}));
