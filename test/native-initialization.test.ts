import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,symlink} from 'node:fs/promises';
import {project} from './helpers.js';
import {scanRepository} from '../src/analyzer/repository.js';
import {prepareIntegrations} from '../src/integrations/registry.js';
import type {SetupOptions} from '../src/types.js';

const options:SetupOptions={agents:['codex'],backend:'host',tools:[
 {id:'openwiki',install:true,initialize:true,agents:['codex']},
 {id:'codegraph',install:true,initialize:true,agents:['codex']},
]};
test('native initialization plans closed staged operations after pinned installation',()=>project(async root=>{
 await writeFile(root+'/AGENTS.md','User instructions stay here.\n');
 const prepared=await prepareIntegrations(await scanRepository(root,options),options);
 assert.deepEqual(prepared.operations.map(o=>[o.id,o.prerequisiteIds]),[
  ['install:openwiki',[]],['initialize:openwiki',['install:openwiki']],
  ['install:codegraph',[]],['initialize:codegraph',['install:codegraph']],
 ]);
 assert.deepEqual(prepared.requirements,[]);
 for(const op of prepared.operations.filter(o=>o.kind==='initialize')){
  assert.equal(op.protection.kind,'native-staging');
  assert.equal(op.query.kind,'native-initialization');
  assert.ok(!op.declaredWrites.some(p=>p==='.'||p==='AGENTS.md'||p.startsWith('.git/')));
 }
 assert.equal(await readFile(root+'/AGENTS.md','utf8'),'User instructions stay here.\n');
}));
test('unowned wiki and index remain untouched and are never implicitly adopted',()=>project(async root=>{
 await mkdir(root+'/openwiki');await writeFile(root+'/openwiki/quickstart.md','Customer wiki');
 await mkdir(root+'/.codegraph');await writeFile(root+'/.codegraph/config.json','Customer index configuration');
 const prepared=await prepareIntegrations(await scanRepository(root,options),options);
 assert.equal(prepared.operations.filter(o=>o.kind==='initialize').length,0);
 assert.equal(prepared.requirements.length,2);
 assert.equal(await readFile(root+'/openwiki/quickstart.md','utf8'),'Customer wiki');
 assert.equal(await readFile(root+'/.codegraph/config.json','utf8'),'Customer index configuration');
}));
test('native initialization rejects unsafe target and staging ancestors',()=>project(async root=>project(async outside=>{
 await symlink(outside,root+'/openwiki');
 await mkdir(root+'/.rigup',{recursive:true});await symlink(outside,root+'/.rigup/native');
 const prepared=await prepareIntegrations(await scanRepository(root,options),options);
 assert.equal(prepared.operations.filter(o=>o.kind==='initialize').length,0);
 assert.equal(prepared.requirements.length,2);
})));
test('registering an unverified external binary does not authorize initialization',()=>project(async root=>{
 const opts:SetupOptions={...options,tools:[{id:'openwiki',install:false,initialize:true,agents:['codex']}]};
 const prepared=await prepareIntegrations(await scanRepository(root,opts),opts);
 assert.equal(prepared.operations.length,0);
 assert.match(prepared.requirements[0]?.reason??'',/pinned project installation/);
}));
