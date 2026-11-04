import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,mkdir,writeFile,readFile,readdir,rm,cp,access,constants} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {scanRepository} from '../src/analyzer/repository.js';
import {prepareIntegrations} from '../src/integrations/registry.js';
import {preview} from '../src/installer/preview.js';
import {apply} from '../src/installer/apply.js';
import {loadManifest} from '../src/installer/baseline.js';
import {saveDurable} from '../src/installer/state.js';
import {pendingOperations,executeOperation,assertNoUnknownWriters} from '../src/installer/operations.js';
import {initializationRecipe} from '../src/integrations/tools/initialization.js';
import {loadUpstreamLock} from '../src/integrations/registry.js';
import {doctor} from '../src/installer/doctor.js';
import {codexNativeTools} from './native-tools-support.js';
import {executeLifecycle} from '../src/lifecycle.js';
import type {SetupPlan,SetupOptions} from '../src/types.js';
const exec=promisify(execFile);
const enabled=process.env.RIGUP_LIVE_NATIVE==='1';
test('live public install initializes both tools and resumes after native acceptance and cache loss',{skip:!enabled,timeout:240000},async()=>{
 const root=await realpath(await mkdtemp('/private/tmp/rigup-protected-native-'));
 const control=await realpath(await mkdtemp('/private/tmp/rigup-protected-control-'));
 const cache=control+'/cache',state=control+'/state';await mkdir(cache,{mode:0o700});await mkdir(state,{mode:0o700});
 const options:SetupOptions={agents:['codex'],backend:'host',tools:[{id:'openwiki',install:true,initialize:true,agents:['codex']},{id:'codegraph',install:true,initialize:true,agents:['codex']}]};
 const evidence:any={caseId:'protected-native/initialization-recovery',status:'failed',root,startedAt:new Date().toISOString(),node:process.version,platform:process.platform};
 try {
  await exec('git',['-C',root,'-c','init.templateDir=','init','-q']);
  await mkdir(root+'/src');await writeFile(root+'/src/order.js','export function createOrder(reference) { return {reference}; }\n');
  await writeFile(root+'/AGENTS.md','User agent instructions\n');await writeFile(root+'/CLAUDE.md','User Claude instructions\n');
  await mkdir(root+'/.github/workflows',{recursive:true});await writeFile(root+'/.github/workflows/openwiki-update.yml','User workflow\n');
  const profile=await scanRepository(root,options),prepared=await prepareIntegrations(profile,options);
  const plan:SetupPlan={root,fingerprint:profile.fingerprint,options,...prepared,versions:{},dispositions:[]};
  const p=await preview(plan,[],{cacheRoot:cache});assert.equal(p.executable,true,p.blockers.join('\n'));
  let crashed=false;
  await assert.rejects(()=>apply(p.previewId,{cacheRoot:cache,stateRoot:state,operation:{save:async(path,content)=>{
   const journal=JSON.parse(content);const last=journal.operations.at(-1);
   if(!crashed&&last.operation.kind==='initialize'&&last.result?.status==='done'){crashed=true;throw Error('controller stopped after native acceptance');}
   await saveDurable(path,content);
  }}}),/controller stopped after native acceptance/);
  const interrupted=await pendingOperations(root,state);assert.equal(interrupted.at(-1)?.stage,'dispatching');
  evidence.interrupted=interrupted.map(o=>({id:o.operation.id,stage:o.stage,status:o.result?.status}));
  await rm(cache,{recursive:true});await mkdir(cache,{mode:0o700});
  const reports:any[]=[];
  assert.equal(await executeLifecycle(root,options,{resume:true},()=>{}, {cacheRoot:cache,stateRoot:state,report:r=>reports.push(r)}),0);
  const manifest=(await loadManifest(root))!;
  assert.deepEqual(Object.keys(manifest.installedTools!).sort(),['codegraph','openwiki']);
  assert.deepEqual(Object.keys((manifest as any).initializedTools).sort(),['codegraph','openwiki']);
  const run=JSON.parse(await readFile(root+'/openwiki/.run.json','utf8'));assert.equal(run.phase,'planning');
  const cg=root+'/.rigup/tools/codegraph/node_modules/.bin/codegraph';
  const query=JSON.parse((await exec(cg,['query','createOrder','--path',root,'--json'],{cwd:root,env:{...process.env,CODEGRAPH_NO_DAEMON:'1',DO_NOT_TRACK:'1',CODEGRAPH_NO_DOWNLOAD:'1'},timeout:30000})).stdout);
  assert.match(JSON.stringify(query),/createOrder/);assert.match(JSON.stringify(query),/src\/order\.js/);
  assert.equal(await readFile(root+'/AGENTS.md','utf8'),'User agent instructions\n');
  assert.equal(await readFile(root+'/CLAUDE.md','utf8'),'User Claude instructions\n');
  assert.equal(await readFile(root+'/.github/workflows/openwiki-update.yml','utf8'),'User workflow\n');
  assert.deepEqual(await readdir(root+'/.git/hooks').catch(()=>[]),[]);
  const diagnostic=await doctor(root,{stateRoot:state});for(const id of ['openwiki','codegraph'])assert.equal(diagnostic.diagnostics.find(d=>d.id===id+':initialization')?.state,'initialized');
  // An unchanged update reuses both kinds of receipt and never reinitializes.
  const current=await scanRepository(root,options);current.installedTools=manifest.installedTools;current.initializedTools=manifest.initializedTools;
  const update=await prepareIntegrations(current,options);assert.deepEqual(update.operations,[]);assert.deepEqual(update.requirements,[]);
  assert.equal(current.truncated,false);assert.ok(!current.files.some(p=>p.startsWith('.codegraph/')||p.startsWith('openwiki/')||p.startsWith('.rigup/native/')));
  // Kill the real CodeGraph writer after it creates a DB, then rebuild only its
  // unpublished staging directory. The existing initialized project is retained.
  const interruptedRoot=control+'/interrupted-project';await mkdir(interruptedRoot);await mkdir(interruptedRoot+'/.rigup/tools',{recursive:true});
  await cp(root+'/.rigup/tools/codegraph',interruptedRoot+'/.rigup/tools/codegraph',{recursive:true,verbatimSymlinks:true,mode:constants.COPYFILE_FICLONE});
  await mkdir(interruptedRoot+'/src');for(let i=0;i<80;i++)await writeFile(interruptedRoot+'/src/file'+i+'.js','export function createOrder'+i+'(id) { return {id}; }\n');
  const cgRecipe=(await loadUpstreamLock()).find(r=>r.integrationId==='codegraph')!;
  const init=initializationRecipe(interruptedRoot,'codegraph',cgRecipe.version,cgRecipe.packageIntegrity);const abort=new AbortController();
  const poll=setInterval(()=>{void access(interruptedRoot+'/.codegraph-rigup-init/codegraph.db').then(()=>abort.abort()).catch(()=>{});},5);
  let cancelled;try{cancelled=await executeOperation(init,{stateRoot:state,authorizationRef:'live-interruption',signal:abort.signal});}finally{clearInterval(poll);}
  evidence.cancellation=cancelled;assert.equal(abort.signal.aborted,true,JSON.stringify(cancelled));assert.equal(cancelled.status,'unknown');await assert.rejects(access(interruptedRoot+'/.codegraph'));
  await assertNoUnknownWriters(interruptedRoot,state);
  const recovered=await executeOperation(init,{stateRoot:state,authorizationRef:'live-interruption'});assert.equal(recovered.status,'done',recovered.message);evidence.partialRecovery={first:cancelled,recovered};
  if(process.env.RIGUP_LIVE_CODEX==='1'){
   evidence.codex=await codexNativeTools(root,control);assert.ok(evidence.codex.servers.some((s:any)=>s.name==='openwiki'&&s.tools.includes('openwiki_begin')));assert.ok(evidence.codex.servers.some((s:any)=>s.name==='codegraph'&&s.tools.includes('codegraph_explore')));assert.match(JSON.stringify(evidence.codex.search),/createOrder/);
   const resumed=JSON.parse(await readFile(root+'/openwiki/.run.json','utf8'));assert.equal(resumed.runId,run.runId);evidence.codex.resumedRunId=resumed.runId;assert.match(await readFile(root+'/AGENTS.md','utf8'),/^User agent instructions\n/);
  }
  evidence.status='passed';evidence.query=query;evidence.runId=run.runId;evidence.receipts={software:manifest.installedTools,initialization:(manifest as any).initializedTools};evidence.reports=reports;
 }catch(error){evidence.reason=(error as Error).message;throw error;}
 finally {evidence.finishedAt=new Date().toISOString();const out=process.env.RIGUP_LIVE_EVIDENCE_DIR??'docs/compatibility/evidence/2026-11-04-native-initialization';await mkdir(out,{recursive:true});await writeFile(out+'/initialization-recovery.json',JSON.stringify(evidence,null,2)+'\n');if(evidence.status==='passed'){await rm(root,{recursive:true,force:true});await rm(control,{recursive:true,force:true});}}
});
