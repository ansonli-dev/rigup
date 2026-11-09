import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:net';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {mkdir,writeFile,readFile,symlink,lstat,rename} from 'node:fs/promises';
import {project} from './helpers.js';
import {scanRepository} from '../src/analyzer/repository.js';
import {prepareIntegrations} from '../src/integrations/registry.js';
import type {SetupOptions} from '../src/types.js';
import {preview} from '../src/installer/preview.js';
import type {SetupPlan} from '../src/types.js';
import {initializationRecipe} from '../src/integrations/tools/initialization.js';
import {loadUpstreamLock} from '../src/integrations/registry.js';
import {queryOperation} from '../src/installer/operations.js';
import {nativeEnvironment,resumableNativeOperation} from '../src/integrations/tools/native-state.js';
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
test('native CodeGraph publication promotes a staged index into an empty target',()=>project(async root=>{
 const target=join(root,'.codegraph'),staging=join(root,'.codegraph-rigup-init');
 await mkdir(target);
 const {packageRoot}=await writeNativeToolFixture(root,'codegraph','1.6.2');
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
 const pin=(await loadUpstreamLock()).find(r=>r.integrationId==='codegraph')!;
 const operation=initializationRecipe(root,'codegraph',pin.version,pin.packageIntegrity);
 const {executable,args}=operation.parameters;
 const runWorker=()=>JSON.parse(execFileSync(executable,args,{cwd:root,env:nativeEnvironment(operation),encoding:'utf8',stdio:['ignore','pipe','pipe']}));
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
