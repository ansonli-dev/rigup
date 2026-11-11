import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:net';
import {basename,dirname,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {copyFile,mkdir,writeFile,readFile,readdir,symlink,lstat,rename} from 'node:fs/promises';
import {project} from './helpers.js';
import {scanRepository} from '../src/analyzer/repository.js';
import {prepareIntegrations} from '../src/integrations/registry.js';
import type {SetupOptions} from '../src/types.js';
import {preview} from '../src/installer/preview.js';
import type {SetupPlan} from '../src/types.js';
import {initializationRecipe} from '../src/integrations/tools/initialization.js';
import {loadUpstreamLock} from '../src/integrations/registry.js';
import {executeOperation,queryOperation} from '../src/installer/operations.js';
import {nativeEnvironment,resumableNativeOperation} from '../src/integrations/tools/native-state.js';
import {assertToolOperationRecipe} from '../src/integrations/tools/recipes.js';
import {writeNativeToolFixture} from './native-tool-fixture.js';
import {apply} from '../src/installer/apply.js';
import {executeLifecycle} from '../src/lifecycle.js';
import {rm} from 'node:fs/promises';

const options:SetupOptions={agents:['codex'],backend:'host',tools:[
 {id:'openwiki',install:true,initialize:true,agents:['codex']},
 {id:'codegraph',install:true,initialize:true,agents:['codex']},
]};
test('scaffolding installs OpenWiki and stages only CodeGraph initialization',()=>project(async root=>{
 await writeFile(root+'/AGENTS.md','User instructions stay here.\n');
 const prepared=await prepareIntegrations(await scanRepository(root,options),options);
 assert.deepEqual(prepared.operations.map(o=>[o.id,o.prerequisiteIds]),[
  ['install:openwiki',[]],
  ['install:codegraph',[]],['initialize:codegraph',['install:codegraph']],
 ]);
 const reversed={...options,tools:[...options.tools!].reverse()};
 const otherOrder=await prepareIntegrations(await scanRepository(root,reversed),reversed);
 assert.deepEqual(otherOrder.operations.map(o=>o.id),['install:codegraph','install:openwiki','initialize:codegraph']);
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
 assert.equal(prepared.requirements.length,1);
 assert.equal(await readFile(root+'/openwiki/quickstart.md','utf8'),'Customer wiki');
 assert.equal(await readFile(root+'/.codegraph/config.json','utf8'),'Customer index configuration');
}));
test('native initialization rejects unsafe target and staging ancestors',()=>project(async root=>project(async outside=>{
 await symlink(outside,root+'/openwiki',process.platform==='win32'?'junction':'dir');
 await mkdir(root+'/.rigup',{recursive:true});await symlink(outside,root+'/.rigup/native',process.platform==='win32'?'junction':'dir');
 const prepared=await prepareIntegrations(await scanRepository(root,options),options);
 assert.equal(prepared.operations.filter(o=>o.kind==='initialize').length,0);
 assert.equal(prepared.requirements.length,1);
})));
test('registering an unverified external binary does not authorize initialization',()=>project(async root=>{
 const opts:SetupOptions={...options,tools:[{id:'codegraph',install:false,initialize:true,agents:['codex']}]};
 const prepared=await prepareIntegrations(await scanRepository(root,opts),opts);
 assert.equal(prepared.operations.length,0);
 assert.match(prepared.requirements[0]?.reason??'',/pinned project installation/);
}));
async function nativePlan(root:string):Promise<SetupPlan>{const profile=await scanRepository(root,options);const prepared=await prepareIntegrations(profile,options);return {root,fingerprint:profile.fingerprint,options,assets:prepared.assets,operations:prepared.operations,requirements:prepared.requirements,warnings:prepared.warnings,versions:{},dispositions:[]};}
test('preview authorizes staged CodeGraph initialization without OpenWiki generation',()=>project(async root=>project(async cache=>{
 const plan=await nativePlan(root);const p=await preview(plan,[],{cacheRoot:cache});
 assert.equal(p.executable,true,p.blockers.join('\n'));
 assert.equal(p.operations.filter(o=>o.kind==='initialize').length,1);
})));
test('preview refuses a canonical OpenWiki initialization even with a pinned install prerequisite',()=>project(async root=>project(async cache=>{
 const plan=await nativePlan(root);
 const recipe=(await loadUpstreamLock()).find(r=>r.integrationId==='openwiki')!;
 plan.operations.push(initializationRecipe(root,'openwiki',recipe.version,recipe.packageIntegrity,['install:openwiki']));
 const approved=await preview(plan,[],{cacheRoot:cache});
 assert.equal(approved.executable,false);
 assert.ok(approved.blockers.some(reason=>/initialize:openwiki.*separate/i.test(reason)));
})));
test('preview refuses missing or reordered initialization dependencies',()=>project(async root=>project(async cache=>{
 const plan=await nativePlan(root);plan.operations=plan.operations.filter(o=>o.kind!=='install');
 assert.equal((await preview(plan,[],{cacheRoot:cache})).executable,false);
 const reordered=await nativePlan(root);reordered.operations.reverse();
 assert.equal((await preview(reordered,[],{cacheRoot:cache})).executable,false);
})));
test('preview refuses native scope edits and unsafe staging after planning',()=>project(async root=>project(async cache=>project(async outside=>{
 const plan=await nativePlan(root);await symlink(outside,root+'/.codegraph-rigup-init',process.platform==='win32'?'junction':'dir');
 assert.equal((await preview(plan,[],{cacheRoot:cache})).executable,false);
}))));
test('receipted native output is excluded from source research while unowned state stays visible',()=>project(async root=>{
 await mkdir(root+'/.codegraph');await writeFile(root+'/.codegraph/user.md','existing input');
 const unowned=await scanRepository(root,options);assert.ok(unowned.files.includes('.codegraph/user.md'));
 await mkdir(root+'/.rigup/native/codegraph',{recursive:true});
 const stat=await lstat(root+'/.codegraph'),identity=String(stat.dev)+':'+String(stat.ino);
 const receipt={version:'1.6.2',target:'.codegraph',identity};
 await writeFile(root+'/.rigup/native/codegraph/promotion.json',JSON.stringify({root,id:'codegraph',...receipt}));
 await writeFile(root+'/.rigup/manifest.json',JSON.stringify({schemaVersion:1,installId:'fixture',assets:[],initializedTools:{codegraph:receipt}}));
 const owned=await scanRepository(root,options);
 assert.ok(!owned.files.some(p=>p.startsWith('.codegraph/')||p.startsWith('.rigup/native/')));
 await writeFile(root+'/.rigup/native/codegraph/promotion.json',JSON.stringify({root,id:'codegraph',...receipt,identity:'changed'}));
 const broken=await scanRepository(root,options);assert.match(broken.researchBlocked??'',/ownership|native/);
 assert.ok(!broken.files.some(p=>p.startsWith('.codegraph/')||p.startsWith('.rigup/native/')));
}));
test('native state query never executes substituted adapter commands',()=>project(async root=>{
 const recipe=(await loadUpstreamLock()).find(r=>r.integrationId==='openwiki')!;
 const {prefix}=await writeNativeToolFixture(root,'openwiki','0.7.3');
 await writeFile(prefix+'/package-lock.json',JSON.stringify({packages:{'':{dependencies:{openwiki:'0.7.3'}},'node_modules/openwiki':{version:'0.7.3',integrity:recipe.packageIntegrity}}}));
 const op=initializationRecipe(root,'openwiki','0.7.3',recipe.packageIntegrity);
 op.parameters.args=['-e',`require('fs').writeFileSync(${JSON.stringify(root+'/substituted-command-ran')},'bad')`,'ignored','initialize'];
 await queryOperation(op);
 await assert.rejects(()=>readFile(root+'/substituted-command-ran'),{code:'ENOENT'});
}));
async function codeGraphWorker(root:string){
 const pin=(await loadUpstreamLock()).find(r=>r.integrationId==='codegraph')!;
 const {packageRoot,prefix}=await writeNativeToolFixture(root,'codegraph',pin.version);
 const name='@colbymchenry/codegraph';
 await writeFile(join(prefix,'package-lock.json'),JSON.stringify({packages:{'':{dependencies:{[name]:pin.version}},['node_modules/'+name]:{version:pin.version,integrity:pin.packageIntegrity}}}));
 await writeFile(join(packageRoot,'index.js'),`
  const {DatabaseSync}=require('node:sqlite');
  const {existsSync,mkdirSync,rmSync}=require('node:fs');
  const {join}=require('node:path');
  module.exports.CodeGraph=class CodeGraph {
   static isInitialized(root){return existsSync(join(root,process.env.CODEGRAPH_DIR,'codegraph.db'));}
   static recreate(root){rmSync(join(root,process.env.CODEGRAPH_DIR),{recursive:true});return this.init(root);}
   static init(root){
    const index=join(root,process.env.CODEGRAPH_DIR);
    mkdirSync(index);
    if(existsSync(join(root,'create-destination-during-index')))mkdirSync(join(root,'.codegraph'));
    const db=new DatabaseSync(join(index,'codegraph.db'));
    try{
     db.exec("CREATE TABLE project_metadata(key TEXT PRIMARY KEY,value TEXT); INSERT INTO project_metadata VALUES ('index_state','complete'),('indexed_with_version','1.6.2'); CREATE TABLE files(id TEXT); CREATE TABLE nodes(id TEXT);");
    }finally{db.close();}
    return new CodeGraph();
   }
   indexAll(){return {success:true};}
   getIndexState(){return 'complete';}
   close(){}
  };
 `);
 const operation=initializationRecipe(root,'codegraph',pin.version,pin.packageIntegrity);
 return {pin,operation,runWorker:(preload?:string)=>runNativeWorker(operation,preload)};
}

function runNativeWorker(operation:SetupOperation,preload?:string){
 const {executable,args}=operation.parameters;
 const argv=preload?['--import',pathToFileURL(preload).href,...args]:args;
 return JSON.parse(execFileSync(executable,argv,{cwd:operation.parameters.cwd,env:nativeEnvironment(operation),encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:15000}));
}

async function injectWindowsRename(root:string,implementation:string){
 const preload=join(root,'rename-fault.mjs');
 await writeFile(preload,`
  import fs from 'node:fs/promises';
  import {basename} from 'node:path';
  import {syncBuiltinESMExports} from 'node:module';
  Object.defineProperty(process,'platform',{value:'win32'});
  const rename=fs.rename;
  const failed=new Set();
  fs.rename=${implementation};
  syncBuiltinESMExports();
 `);
 return preload;
}

test('native CodeGraph publication promotes a staged index into an empty target',()=>project(async root=>{
 const target=join(root,'.codegraph'),staging=join(root,'.codegraph-rigup-init');
 await mkdir(target);
 const {operation,runWorker}=await codeGraphWorker(root);
 const promote=async()=>{
  const result=runWorker();
  assert.equal(result.status,'done');
  const info=await lstat(target);
  assert.equal(result.nativeReceipt.identity,info.dev+':'+info.ino);
  await assert.rejects(lstat(staging),{code:'ENOENT'});
 };
 await promote();
 // Restore the filesystem shape left by a crash after Windows rmdir and
 // before promotion. The intent and promotion marker remain on disk.
 await rename(target,staging);
 assert.equal(await resumableNativeOperation(operation),true);
 await promote();
 if(process.platform==='win32'){
  await rename(target,staging);
  await writeFile(join(root,'create-destination-during-index'),'');
  assert.throws(runWorker,/Native target changed before promotion/);
  assert.ok((await lstat(target)).isDirectory());
  assert.ok((await lstat(join(staging,'codegraph.db'))).isFile());
 }
}));
test('native worker retries Windows journal, quarantine and publication renames',()=>project(async root=>{
 const target=join(root,'.codegraph'),staging=join(root,'.codegraph-rigup-init');
 const control=join(root,'.rigup/native/codegraph');
 await mkdir(staging);
 await writeFile(join(staging,'checkpoint'),'malformed unpublished checkpoint');
 const {runWorker}=await codeGraphWorker(root);
 const preload=await injectWindowsRename(root,`async (from,to)=>{
  const name=basename(to);
  const code=name==='intent.json'?'EPERM':name.startsWith('interrupted-')?'EACCES':name==='promotion.json'?'EBUSY':name==='.codegraph'?'EPERM':undefined;
  if(code&&!failed.has(to)){failed.add(to);throw Object.assign(Error('transient rename failure'),{code});}
  await rename(from,to);
 }`);
 assert.equal(runWorker(preload).status,'done');
 assert.ok((await lstat(join(target,'codegraph.db'))).isFile());
 const retained=(await readdir(control)).find(name=>/^interrupted-[a-f0-9-]+$/.test(name))!;
 assert.equal(await readFile(join(control,retained,'checkpoint'),'utf8'),'malformed unpublished checkpoint');
 await assert.rejects(lstat(staging),{code:'ENOENT'});
}));
test('the Windows native worker retains an OpenWiki checkpoint after a transient quarantine failure',()=>project(async root=>{
 const control=join(root,'.rigup/native/openwiki'),staging=join(control,'repository');
 await mkdir(staging,{recursive:true});
 await writeFile(join(staging,'malformed'),'unreadable checkpoint');
 const {packageRoot}=await writeNativeToolFixture(root,'openwiki','0.7.3','module');
 await mkdir(join(packageRoot,'dist/generation'),{recursive:true});
 await mkdir(join(packageRoot,'dist/integrations/core'),{recursive:true});
 await writeFile(join(packageRoot,'dist/generation/run-state.js'),`
  import {existsSync} from 'node:fs';
  import {join} from 'node:path';
  export function readRepositoryRunState(root){
   if(existsSync(join(root,'malformed')))throw Error('malformed');
   if(existsSync(join(root,'openwiki','checkpoint')))return {phase:'ready',runId:'fixture'};
  }
 `);
 await writeFile(join(packageRoot,'dist/integrations/core/session-manager.js'),`
  import {mkdir,writeFile} from 'node:fs/promises';
  import {join} from 'node:path';
  export class HostSessionManager {
   static create(){return new HostSessionManager();}
   async begin({root}){await mkdir(join(root,'openwiki'));await writeFile(join(root,'openwiki','checkpoint'),'new checkpoint');}
  }
 `);
 const preload=await injectWindowsRename(root,`async (from,to)=>{
  if(basename(to).startsWith('interrupted-')&&!failed.has(to)){
   failed.add(to);throw Object.assign(Error('transient quarantine failure'),{code:'EACCES'});
  }
  await rename(from,to);
 }`);
 const result=runNativeWorker(initializationRecipe(root,'openwiki','0.7.3'),preload);
 assert.equal(result.status,'done');
 assert.equal(await readFile(join(root,'openwiki','checkpoint'),'utf8'),'new checkpoint');
 const retained=(await readdir(control)).find(name=>name.startsWith('interrupted-'))!;
 assert.equal(await readFile(join(control,retained,'malformed'),'utf8'),'unreadable checkpoint');
}));
test('native publication refuses a new Windows target after a transient rename failure',()=>project(async root=>{
 const target=join(root,'.codegraph'),staging=join(root,'.codegraph-rigup-init');
 await mkdir(target);
 const {runWorker}=await codeGraphWorker(root);
 const preload=await injectWindowsRename(root,`async (from,to)=>{
  if(basename(to)!=='.codegraph')return rename(from,to);
  await fs.mkdir(to);
  throw Object.assign(Error('transient rename failure'),{code:'EBUSY'});
 }`);
 assert.throws(()=>runWorker(preload),/Native target appeared before promotion/);
 assert.deepEqual(await readdir(target),[]);
 assert.ok((await lstat(join(staging,'codegraph.db'))).isFile());
}));
test('the Windows native worker stops after five blocked rename attempts',()=>project(async root=>{
 const {runWorker}=await codeGraphWorker(root);
 const preload=await injectWindowsRename(root,`async (from,to)=>{
  if(basename(to)==='intent.json'&&failed.size<5){
   failed.add(failed.size);throw Object.assign(Error('blocked rename attempt '+failed.size),{code:'EPERM'});
  }
  await rename(from,to);
 }`);
 assert.throws(()=>runWorker(preload),/blocked rename attempt 5/);
 await assert.rejects(lstat(join(root,'.rigup/native/codegraph/intent.json')),{code:'ENOENT'});
}));
test('a recognized v0.2.4 native recipe can reconcile staging and completed output',()=>project(async root=>{
 const {operation,pin,runWorker}=await codeGraphWorker(root);
 const prior=(digest:string)=>{
  const legacy=structuredClone(operation);legacy.parameters.args[8]=digest;return legacy;
 };
 const legacy=[
  prior('6cf421b0ba225d9f371a7dd67b083475fed40bacd30aee838a7d4bfb18cbf5b8'), // source checkout
  prior('4cedd2d4e9de317a10d60e82a7211aa20837d4f1f250704fde9b9141a3d32c19'), // source with CRLF
  prior('7a9e129185bd1c91eb6985ba3cb63d30e0c5c3b9a8a2ac9d93354d3ae43589a7'), // compiled distribution
  prior('3bb951b931d7218fb70247d579c8b702ca0dd19a57c4ec68321bf5b6dc5debb3'), // distribution with CRLF
 ];
 for(const candidate of legacy)assert.equal(await resumableNativeOperation(candidate),true);
 const {nativeReceipt}=runWorker();
 for(const candidate of legacy)assert.deepEqual((await queryOperation(candidate)).nativeReceipt,nativeReceipt);
 const arbitrary=prior('0'.repeat(64));
 const substituted=structuredClone(legacy[0]);substituted.parameters.args[2]=join(root,'untrusted.mjs');
 for(const rejected of [...legacy,arbitrary,substituted])assert.throws(()=>assertToolOperationRecipe(root,rejected,pin,[]),/verified recipe/);
 for(const rejected of [arbitrary,substituted])assert.equal((await queryOperation(rejected)).status,'unknown');
}));
test('a relocated native recipe resumes only with the same verified adapter',()=>project(async root=>project(async stateRoot=>{
 const {operation}=await codeGraphWorker(root);
 const previous=structuredClone(operation);
 const priorRelease=join(stateRoot,'versions','v0.4.0','lib');
 const worker=join(priorRelease,'app','dist','integrations','tools','native-worker.mjs');
 await mkdir(dirname(worker),{recursive:true});
 await copyFile(operation.parameters.args[2],worker);
 previous.parameters.args[2]=worker;
 previous.parameters.executable=join(priorRelease,'node','bin',basename(process.execPath));
 const approval={stateRoot,authorizationRef:'fixture-approved'};
 const fresh=await executeOperation(previous,approval);
 assert.equal(fresh.status,'pending');
 assert.match(fresh.message??'',/verified recipe/);
 assert.equal(await resumableNativeOperation(previous),true);
 const resumed=await executeOperation(previous,{...approval,restoringApproval:true});
 assert.equal(resumed.status,'done',resumed.message);
 assert.deepEqual((await queryOperation(previous)).nativeReceipt,resumed.nativeReceipt);

 await writeFile(worker,'// Modified prior adapter');
 const changed=await executeOperation(previous,{...approval,restoringApproval:true});
 assert.equal(changed.status,'pending');
 assert.match(changed.message??'',/Prior native adapter is unavailable/);
})));
test('a live CodeGraph daemon socket preserves verified initialization', {skip:process.platform==='win32'},()=>project(async root=>{
 const index=root+'/.codegraph',control=root+'/.rigup/native/codegraph',socket=index+'/daemon.sock';
 await mkdir(index);await mkdir(control,{recursive:true});
 const info=await lstat(index),receipt={target:'.codegraph',version:'1.6.2',identity:info.dev+':'+info.ino};
 const marker=control+'/promotion.json';
 const record={root,id:'codegraph',...receipt};
 await writeFile(marker,JSON.stringify(record));
 const db=new DatabaseSync(index+'/codegraph.db');
 db.exec(`CREATE TABLE project_metadata(key TEXT, value TEXT);
   INSERT INTO project_metadata VALUES ('index_state', 'complete'), ('indexed_with_version', '1.6.2');
   CREATE TABLE files(id INTEGER);
   CREATE TABLE nodes(id INTEGER);`);
 db.close();
 const {parameters:{executable,args}}=initializationRecipe(root,'codegraph',receipt.version);
 args[3]='query';
 const query=()=>JSON.parse(execFileSync(executable,args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
 assert.deepEqual(query().nativeReceipt,receipt);

 const server=createServer();
 await new Promise<void>((resolve,reject)=>server.once('error',reject).listen(socket,resolve));
 try {
  assert.deepEqual(query().nativeReceipt,receipt);
  await writeFile(marker,JSON.stringify({...record,identity:'replaced'}));
  assert.throws(query,/Native promotion ownership does not match/);
 }finally{
  await new Promise<void>(resolve=>server.close(()=>resolve()));
 }
 await writeFile(marker,JSON.stringify(record));
 await symlink('codegraph.db',socket);
 assert.throws(query,/Unsafe native state entry/);
}));
test('durable apply resumes without research credentials after its preview cache is deleted',()=>project(async root=>project(async cache=>project(async state=>{
 const selected:SetupOptions={agents:['codex'],backend:'native',sdd:'openspec'};
 const plan:SetupPlan={root,options:selected,fingerprint:(await scanRepository(root,selected)).fingerprint,assets:[{logicalId:'fixture',target:'owned.md',content:'Prepared content\n',ownership:{kind:'file'},source:{kind:'test',ref:'test'}}],operations:[],requirements:[],warnings:[],versions:{},dispositions:[]};
 const p=await preview(plan,[],{cacheRoot:cache+'/previews'});
 await assert.rejects(()=>apply(p.previewId,{cacheRoot:cache+'/previews',stateRoot:state,hook:async()=>{throw Error('interrupted');}}),/interrupted/);
 await rm(cache,{recursive:true});await mkdir(cache,{mode:0o700});
 assert.equal(await executeLifecycle(root,selected,{resume:true},()=>{},{cacheRoot:cache,stateRoot:state}),0);
 assert.equal(await readFile(root+'/owned.md','utf8'),'Prepared content\n');
}))));
