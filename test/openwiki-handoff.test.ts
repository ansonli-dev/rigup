import {test} from 'node:test';
import assert from 'node:assert/strict';
import {access,lstat,mkdir,readdir,readFile,writeFile} from 'node:fs/promises';
import {writeNativeToolFixture} from './native-tool-fixture.js';
import {project} from './helpers.js';
import {prepareIntegrations,loadUpstreamLock} from '../src/integrations/registry.js';
import {scanRepository} from '../src/analyzer/repository.js';
import {onboard} from '../src/onboarding.js';
import {executeLifecycle} from '../src/lifecycle.js';
import {doctor} from '../src/installer/doctor.js';
import {executeOperation} from '../src/installer/operations.js';
import {initializationRecipe} from '../src/integrations/tools/initialization.js';
import type {SetupOptions} from '../src/types.js';
import {signature} from '../src/generator/cache.js';

async function fixture(fn:(root:string,cache:string,state:string)=>Promise<void>){await project(async root=>project(async cache=>project(async state=>fn(root,cache,state))));}
async function pinnedOpenWiki(root:string){
 const recipe=(await loadUpstreamLock()).find(r=>r.integrationId==='openwiki')!;
 const {prefix}=await writeNativeToolFixture(root,'openwiki','0.7.3','module');
 await writeFile(prefix+'/package-lock.json',JSON.stringify({packages:{'':{dependencies:{openwiki:'0.7.3'}},'node_modules/openwiki':{version:'0.7.3',integrity:recipe.packageIntegrity}}}));
 return initializationRecipe(root,'openwiki','0.7.3',recipe.packageIntegrity);
}

test('OpenWiki setup installs and registers without taking ownership of a user wiki',()=>project(async root=>{
 await mkdir(root+'/openwiki');await writeFile(root+'/openwiki/guide.md','Existing user wiki\n');
 const options:SetupOptions={agents:['codex'],backend:'codex',tools:[{id:'openwiki',install:true,initialize:true,agents:['codex']}]};
 const result=await prepareIntegrations(await scanRepository(root,options),options);
 assert.deepEqual(result.operations.map(o=>o.id),['install:openwiki']);
 assert.deepEqual(result.requirements,[],'separate wiki generation must not block scaffolding');
 assert.ok(result.assets.some(a=>a.target==='.codex/config.toml'));
 assert.ok(result.warnings.some(w=>/openwiki_begin/.test(w)&&/separat/i.test(w)));
 assert.equal(await readFile(root+'/openwiki/guide.md','utf8'),'Existing user wiki\n');
 await assert.rejects(access(root+'/.rigup/native/openwiki'));
}));

test('onboarding separates OpenWiki generation while retaining protected CodeGraph indexing',async()=>{
 const answers=['2','4','1,2','1','1'];
 const selected=await onboard({agents:[],backend:'codex'},{write:()=>{},read:async()=>answers.shift()??null},{configure:true,knownBackend:true});
 assert.ok(selected);assert.deepEqual(selected.options.tools,[
  {id:'openwiki',install:true,initialize:false,agents:['codex']},
  {id:'codegraph',install:true,initialize:true,agents:['codex']},
 ]);
});

test('onboarding does not restore automatic OpenWiki generation from saved selections',async()=>{
 const answers=['','',''];
 const selected=await onboard({agents:['codex'],backend:'codex',tools:[{id:'openwiki',install:true,initialize:true,agents:['codex']}]},{write:()=>{},read:async()=>answers.shift()??null},{configure:true,knownBackend:true});
 assert.ok(selected);assert.equal(selected.options.tools?.[0].initialize,false);
});

test('legacy OpenWiki initialization cannot dispatch a new native write',()=>fixture(async(root,_cache,state)=>{
 const operation=await pinnedOpenWiki(root);let dispatched=0;
 const result=await executeOperation(operation,{stateRoot:state,authorizationRef:'legacy-preview',launch:async()=>{dispatched++;await writeFile(root+'/generated-by-openwiki','unexpected');return {status:'done',message:'Unexpected initialization'};}});
 assert.equal(dispatched,0);assert.equal(result.status,'pending');assert.match(result.message,/openwiki_begin/);
 await assert.rejects(access(root+'/generated-by-openwiki'));assert.deepEqual(await readdir(state),[]);
}));

test('already accepted legacy OpenWiki initialization is reconciled without another native write',()=>fixture(async(root,_cache,state)=>{
 const operation=await pinnedOpenWiki(root),pkg=root+'/.rigup/tools/openwiki/node_modules/openwiki';
 await mkdir(pkg+'/dist/generation',{recursive:true});await writeFile(pkg+'/dist/generation/run-state.js',`import {readFile} from 'node:fs/promises';export async function readRepositoryRunState(root){return JSON.parse(await readFile(root+'/openwiki/.run.json','utf8'));}`);
 await mkdir(root+'/openwiki');await writeFile(root+'/openwiki/.run.json',JSON.stringify({phase:'planning',runId:'legacy-run'}));
 await mkdir(root+'/.rigup/native/openwiki',{recursive:true});const info=await lstat(root+'/openwiki');
 const receipt={version:'0.7.3',target:'openwiki',identity:info.dev+':'+info.ino};
 await writeFile(root+'/.rigup/native/openwiki/promotion.json',JSON.stringify({root,id:'openwiki',...receipt}));
 const resultRecord={status:'done',message:'Recorded native acceptance',nativeReceipt:receipt};
 await writeFile(state+'/'+signature(root)+'.operations.json',JSON.stringify({operations:[{root,operation,authorizationRef:'legacy-preview',parametersDigest:signature(operation),stage:'terminal',result:resultRecord}]}),{mode:0o600});
 const result=await executeOperation(operation,{stateRoot:state,authorizationRef:'legacy-preview',launch:async()=>{throw Error('must not repeat accepted initialization');}});
 assert.equal(result.status,'done');assert.deepEqual(result.nativeReceipt,receipt);
 assert.equal(JSON.parse(await readFile(root+'/openwiki/.run.json','utf8')).runId,'legacy-run');
}));

test('manual OpenWiki initialization appears in successful setup, update and doctor reports',()=>fixture(async(root,cache,state)=>{
 const options:SetupOptions={agents:['codex'],backend:'codex',tools:[{id:'openwiki',install:false,initialize:true,agents:['codex']}]};
 const reports:any[]=[];
 assert.equal(await executeLifecycle(root,options,{sessionsEnded:true},()=>{},{cacheRoot:cache,stateRoot:state,report:r=>reports.push(r)}),0);
 const installed=reports.at(-1);assert.equal(installed.status,'complete');assert.deepEqual(installed.operations,[]);
 assert.ok(installed.warnings.some((w:string)=>/openwiki_begin/.test(w)));
 const manifest=JSON.parse(await readFile(root+'/.rigup/manifest.json','utf8'));assert.equal(manifest.initializedTools?.openwiki,undefined);
 await assert.rejects(access(root+'/openwiki'));await assert.rejects(access(root+'/.rigup/native/openwiki'));
 reports.length=0;assert.equal(await executeLifecycle(root,options,{sessionsEnded:true},()=>{},{cacheRoot:cache,stateRoot:state,report:r=>reports.push(r)}),0);
 assert.deepEqual(reports.at(-1).written,[]);assert.ok(reports.at(-1).warnings.some((w:string)=>/openwiki_begin/.test(w)));
 const diagnostic=(await doctor(root,{stateRoot:state})).diagnostics.find(d=>d.id==='openwiki:initialization');
 assert.equal(diagnostic?.state,'pending');assert.match(diagnostic?.reason??'',/openwiki_begin/);
}));
