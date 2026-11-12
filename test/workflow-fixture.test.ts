import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createWorkflowFixture,workflowComplete,type WorkflowSnapshot} from './workflow-fixture-support.js';
import {observedRun} from './live-workflow-support.js';
import {agentFollowedLatestHead,captureWorkflowState,deliveryCompletionEvidence,findingBeforeRepair,reviewedPushes,verifyDeliveredSnapshot,workflowUnchanged} from './workflow-observation-support.js';
import {checkedLiveCommand,runLiveCommand} from './live-process-support.js';

const fixedGreeting='export function greet(name) { const value=name.trim(); if(!value) throw new TypeError("Name required"); return "Hello, " + value; }\n';
const testImports='import {test} from "node:test";import assert from "node:assert/strict";import {greet} from "../src/greet.js";\n';
const completeRegression=testImports+'test("rejects blank names",()=>{for(const name of ["", " ", "\\t\\n"])assert.throws(()=>greet(name),TypeError);});\ntest("preserves padded names and internal spaces",()=>assert.equal(greet(" Ada Lovelace "),"Hello, Ada Lovelace"));\n';
async function commitAndPush(fixture:Awaited<ReturnType<typeof createWorkflowFixture>>){
 await fixture.git(['add','.']);await fixture.git(['commit','-qm','Change fixture']);await fixture.git(['push','origin','HEAD:main']);return fixture.head();
}

for(const check of ['behavior','regressions'] as const)test('committed snapshot '+check+' rejects and stops lingering descendants',async()=>{
 const fixture=await createWorkflowFixture(),pidPath=fixture.control+'/snapshot-child.pid';
 let pid:number|undefined;
 const running=()=>{if(pid===undefined)return false;try{process.kill(pid,0);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return false;throw error;}};
 try{
  // On Windows a non-detached child is stopped by Node when its own parent exits.
  const prefix='import {spawn} from "node:child_process";import {writeFileSync} from "node:fs";const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore",detached:process.platform==="win32",windowsHide:true});writeFileSync('+JSON.stringify(pidPath)+',String(child.pid));child.unref();\n';
  await writeFile(fixture.root+'/src/greet.js',prefix+fixedGreeting);await writeFile(fixture.root+'/test/greet.test.js',completeRegression);
  const head=await commitAndPush(fixture),result=await (check==='behavior'?fixture.remoteBehavior(head):fixture.remoteRegressions(head));
  pid=Number(await readFile(pidPath,'utf8'));assert.ok(Number.isSafeInteger(pid)&&pid>0);
  assert.equal(result.passed,false,'a successful root exit cannot hide a surviving child');
  assert.equal(running(),false,'the committed check must stop and verify its owned process tree before returning');
 }finally{
  if(pid===undefined)pid=Number(await readFile(pidPath,'utf8').catch(()=> '0'))||undefined;
  if(running())process.kill(pid!,'SIGKILL');
  await fixture.close();
 }
});

async function observedMrCommand(fixture:Awaited<ReturnType<typeof createWorkflowFixture>>,action:string){
 const output=await fixture.node(['tools/mr.mjs',action]);
 const workingFiles=Object.fromEntries(Object.entries((await captureWorkflowState(fixture)).sourceAndTests).filter(([,value])=>value.kind==='file').map(([path,value])=>[path,value.sha256]));
 return {type:'command_execution',command:'node tools/mr.mjs '+action,aggregated_output:output,exit_code:0,observedAt:new Date().toISOString(),workingFiles};
}

for(const missing of ['native-tasks','recorded-evidence','completed-answer','none'] as const)test('delivery completion requires native tasks, actual recorded checks and an explicit completed handoff: '+missing,async()=>{
 const fixture=await createWorkflowFixture();
 try{
  const directory=fixture.root+'/openspec/changes/greeting';await mkdir(directory,{recursive:true});
  await writeFile(directory+'/tasks.md','- [ ] 1.1 Validate blanks\n- [ ] 1.2 Preserve names\n');await writeFile(directory+'/GOAL.md','| AC-BLANK | pending |\n| AC-PRESERVE | pending |\n');
  await commitAndPush(fixture);await fixture.setDeliveryBaseline();
  const firstEvent=fixture.events.length,tools:any[]=[];
  await writeFile(fixture.root+'/test/greet.test.js',completeRegression);await assert.rejects(fixture.node(['--test','test/greet.test.js']));await writeFile(fixture.root+'/src/greet.js',fixedGreeting);
  await fixture.git(['add','.']);await fixture.git(['commit','-qm','Implement and verify behavior']);
  tools.push(await observedMrCommand(fixture,'test-outgoing'));
  const marker=(fixture.events.findLast(event=>event.kind==='outgoing-tests')!.data as any).marker;
  const evidence=missing==='recorded-evidence'?'Unverified claim':`npm test from . — exit 0; ${marker}`;
  await writeFile(directory+'/tasks.md',`- [${missing==='native-tasks'?' ':'x'}] 1.1 Validate blanks\n- [x] 1.2 Preserve names\n\n${evidence}\n`);
  await writeFile(directory+'/GOAL.md',`| AC-BLANK | TypeError for blank strings | ${evidence} |\n| AC-PRESERVE | Hello, Ada Lovelace | ${evidence} |\n`);
  await fixture.git(['add','.']);await fixture.git(['commit','-qm','Record completion evidence']);
  tools.push(await observedMrCommand(fixture,'inspect-outgoing'),await observedMrCommand(fixture,'test-outgoing'));
  await fixture.node(['tools/mr.mjs','record-review','Reviewed full range and actual successful npm test']);await fixture.git(['push','origin','HEAD:main']);const head=await fixture.head();
  const apply={state:missing==='native-tasks'?'ready':'all_done',progress:{remaining:missing==='native-tasks'?1:0},tasks:[{done:missing!=='native-tasks'},{done:true}]};
  const answer=`Delivery status: ${missing==='completed-answer'?'blocked':'complete'}\nCurrent MR SHA: ${head}`;
  assert.equal((await verifyDeliveredSnapshot(fixture,head)).passed,true,'code, regressions, scope and configured checks are already valid');
  assert.equal((await deliveryCompletionEvidence(fixture,head,apply,answer,fixture.events.slice(firstEvent),tools)).passed,missing==='none');
 }finally{await fixture.close();}
});

for(const extra of ['project-file','check-configuration'] as const)test('delivery rejects work outside the approved change scope: '+extra,async()=>{
 const fixture=await createWorkflowFixture();
 try{
  await writeFile(fixture.root+'/src/greet.js',fixedGreeting);await writeFile(fixture.root+'/test/greet.test.js',completeRegression);
  if(extra==='project-file')await writeFile(fixture.root+'/unapproved.txt','Not authorized\n');
  else await writeFile(fixture.root+'/package.json',JSON.stringify({type:'module',scripts:{test:'node -e "process.exit(23)"'}})+'\n');
  const head=await commitAndPush(fixture);
  assert.equal((await verifyDeliveredSnapshot(fixture,head)).passed,false,'correct source/tests cannot authorize unrelated files or changed check configuration');
 }finally{await fixture.close();}
});

test('delivery rejects an earlier unapproved push after a branch rewrite',async()=>{
 const fixture=await createWorkflowFixture();
 try{
  await writeFile(join(fixture.root,'src/greet.js'),fixedGreeting);
  await writeFile(join(fixture.root,'test/greet.test.js'),completeRegression);
  await fixture.git(['add','src/greet.js','test/greet.test.js']);
  await fixture.git(['commit','-qm','Implement the approved change']);
  const approved=(await fixture.git(['rev-parse','HEAD'])).trim();
  await writeFile(join(fixture.root,'unapproved.txt'),'Outside the approved GOAL\n');
  const unapproved=await commitAndPush(fixture);
  assert.equal(await fixture.git(['--git-dir',fixture.remote,'show',unapproved+':unapproved.txt']),'Outside the approved GOAL\n');
  await fixture.git(['checkout','--detach',approved]);
  await fixture.git(['push','--force-with-lease','origin','HEAD:main']);
  assert.equal(await fixture.head(),approved);
  const result=await verifyDeliveredSnapshot(fixture,approved);
  assert.equal(result.localMatchesHead,true);
  assert.equal(result.behaviorPassed,true);
  assert.equal(result.passed,false,'the final scoped head cannot hide an actual earlier push');
  assert.deepEqual(result.scope.unexpected,['unapproved.txt']);
 }finally{await fixture.close();}
});

test('workflow state records a FIFO without opening it',{skip:process.platform==='win32'},async()=>{
 const fixture=await createWorkflowFixture();
 try{
  const pipe='src/temporary-check.pipe';
  await checkedLiveCommand('mkfifo',[join(fixture.root,pipe)],{timeoutMs:5000,maxBuffer:4096});
  const script=`import {captureWorkflowState} from ${JSON.stringify(new URL('./workflow-observation-support.ts',import.meta.url).href)};
   const state=await captureWorkflowState({root:process.argv[1],git:()=>'',head:()=>''});
   console.log(state.sourceAndTests[${JSON.stringify(pipe)}].kind);`;
  const result=await runLiveCommand(process.execPath,['--import','tsx','--input-type=module','-e',script,fixture.root],{timeoutMs:8000,maxBuffer:4096});
  assert.equal(result.timedOut,false,'snapshot capture must not wait for a FIFO writer');
  assert.equal(result.code,0,result.stderr);
  assert.equal(result.stdout.trim(),'special');
 }finally{await fixture.close();}
});

test('delivery preserves preexisting ignored host files and rejects later changes to them',async()=>{
 const fixture=await createWorkflowFixture();
 try{
  const cache=join(fixture.root,'.host-cache');
  await writeFile(join(fixture.root,'.git/info/exclude'),'/.host-cache\n');
  await writeFile(cache,'Native host bootstrap\n');
  const before=await captureWorkflowState(fixture);
  await writeFile(join(fixture.root,'src/greet.js'),fixedGreeting);
  await writeFile(join(fixture.root,'test/greet.test.js'),completeRegression);
  const head=await commitAndPush(fixture);
  assert.equal((await verifyDeliveredSnapshot(fixture,head,before)).passed,true);
  await writeFile(cache,'Changed by the delivery turn\n');
  assert.equal((await verifyDeliveredSnapshot(fixture,head,before)).passed,false);
 }finally{await fixture.close();}
});

test('delivery executes the configured project check rather than substituting a hard-coded test command',async()=>{
 const fixture=await createWorkflowFixture({testCommand:'node -e "console.log(\'configured-check-executed\');process.exit(23)"'});
 try{
  await writeFile(fixture.root+'/src/greet.js',fixedGreeting);await writeFile(fixture.root+'/test/greet.test.js',completeRegression);const head=await commitAndPush(fixture);
  const result=await verifyDeliveredSnapshot(fixture,head);
  assert.equal(result.passed,false,'the actual configured npm test fails even though node --test alone passes');
 }finally{await fixture.close();}
});

test('ordinary read-only observation detects hidden project configuration edits',async()=>{
 const fixture=await createWorkflowFixture();
 try{
  await fixture.git(['update-index','--skip-worktree','package.json']);const before=await captureWorkflowState(fixture);
  await writeFile(fixture.root+'/package.json','{"scripts":{"test":"exit 0"}}\n');
  const after=await captureWorkflowState(fixture);assert.equal(after.status,before.status);assert.equal(after.localHead,before.localHead);
  assert.equal(workflowUnchanged(before,after),false);
 }finally{await fixture.close();}
});

test('latest MR follow-up requires complete native output after push and disposition, not suppressed API reads',async()=>{
 const fixture=await createWorkflowFixture();
 try{
  const initial=await fixture.head(),firstEvent=fixture.events.length,tools:any[]=[];
  tools.push(await observedMrCommand(fixture,'status'));
  await writeFile(fixture.root+'/src/greet.js',fixedGreeting);await writeFile(fixture.root+'/test/greet.test.js',completeRegression);const head=await commitAndPush(fixture);
  await fixture.node(['tools/mr.mjs','disposition','empty-name',head,'fixed','Current implementation and regressions pass']);
  const hidden='require("node:child_process").execFileSync(process.execPath,["tools/mr.mjs","status"],{stdio:"ignore"});';
  tools.push({type:'command_execution',command:hidden,exit_code:0,aggregated_output:await fixture.node(['-e',hidden]),observedAt:new Date().toISOString()});
  const events=structuredClone(fixture.events.slice(firstEvent)),current=await fixture.snapshot();
  assert.notEqual(head,initial);assert.equal(workflowComplete(current),true);
  assert.equal(agentFollowedLatestHead(events,current,tools),false,'server-side reads cannot impersonate actual current-head result consumption');
  tools.push(await observedMrCommand(fixture,'status'));
  assert.equal(agentFollowedLatestHead(fixture.events.slice(firstEvent),current,tools),true);
  assert.equal(agentFollowedLatestHead(fixture.events.slice(firstEvent),current,tools.map(tool=>({...tool,aggregated_output:tool.aggregated_output.replace(/"checks":\s*\[[\s\S]*?\]/,'"checks": []')}))),false,'partial current-head output is insufficient');
 }finally{await fixture.close();}
});

for(const readAt of ['after-push','after-edits','before'] as const)test('finding must be actually observed before repair: '+readAt,async()=>{
 const fixture=await createWorkflowFixture();
 try{
  const before=await captureWorkflowState(fixture),firstEvent=fixture.events.length,tools:any[]=[];
  if(readAt==='before')tools.push(await observedMrCommand(fixture,'status'));
  await writeFile(fixture.root+'/test/greet.test.js',completeRegression);
  await assert.rejects(fixture.node(['--test','test/greet.test.js']),'the new regression really fails before repair');
  await writeFile(fixture.root+'/src/greet.js',fixedGreeting);
  if(readAt==='after-edits')tools.push(await observedMrCommand(fixture,'status'));
  await fixture.git(['add','.']);await fixture.git(['commit','-qm','Regression and repair']);
  tools.push(await observedMrCommand(fixture,'inspect-outgoing'),await observedMrCommand(fixture,'test-outgoing'));
  await fixture.node(['tools/mr.mjs','record-review','Reviewed complete outgoing diff and passing checks']);
  await fixture.git(['push','origin','HEAD:main']);const head=await fixture.head();
  await fixture.node(['tools/mr.mjs','disposition','empty-name',head,'fixed','Actual regression failed, repair made it pass']);
  tools.push(await observedMrCommand(fixture,'status'));
  const events=structuredClone(fixture.events.slice(firstEvent)),current=await fixture.snapshot();
  assert.equal(reviewedPushes(events,tools),true);assert.equal((await verifyDeliveredSnapshot(fixture,head)).passed,true);assert.equal(workflowComplete(current),true);assert.equal(agentFollowedLatestHead(events,current,tools),true);
  assert.equal(findingBeforeRepair(events,tools,before),readAt==='before','latest-head follow-up alone cannot stand in for consuming the finding before repair');
  if(readAt==='before'){
   assert.equal(findingBeforeRepair(events,tools.slice(1),before),false,'a server request alone does not prove the native tool output was observed');
   assert.equal(findingBeforeRepair(events,tools.map(tool=>({...tool,aggregated_output:''})),before),false,'suppressed discussion output cannot pass');
  }
 }finally{await fixture.close();}
});

for(const regression of ['unchanged','comment-only','empty-only','no-preservation'] as const)test('delivered tests must catch the original blank bug and preserve valid greetings: '+regression,async()=>{
 const fixture=await createWorkflowFixture();
 try{
  await writeFile(fixture.root+'/src/greet.js',fixedGreeting);
  const original=await readFile(fixture.root+'/test/greet.test.js','utf8');
  if(regression==='comment-only')await writeFile(fixture.root+'/test/greet.test.js',original+'// Blank names now rejected; no executable regression\n');
  if(regression==='empty-only')await writeFile(fixture.root+'/test/greet.test.js',original+'test("empty only",()=>assert.throws(()=>greet(""),TypeError));\n');
  if(regression==='no-preservation')await writeFile(fixture.root+'/test/greet.test.js',testImports+'test("blank only",()=>{for(const name of ["", " ", "\\t\\n"])assert.throws(()=>greet(name),TypeError);});\n');
  const head=await commitAndPush(fixture),result=await verifyDeliveredSnapshot(fixture,head);
  assert.equal(result.behaviorPassed,true);assert.equal(result.localMatchesHead,true);
  assert.equal(result.passed,false,'passing old tests and an independent implementation oracle cannot establish delivered regression coverage');
 }finally{await fixture.close();}
});

test('a review receipt without full outgoing diff and committed checks cannot validate a push',async()=>{
 const fixture=await createWorkflowFixture();
 try{
  await fixture.head();const firstEvent=fixture.events.length;
  await writeFile(fixture.root+'/src/greet.js',fixedGreeting);await fixture.git(['add','.']);await fixture.git(['commit','-qm','Fix greeting']);
  // This was accepted by the old endpoint, despite no inspection/check execution.
  await assert.rejects(fixture.node(['tools/mr.mjs','record-review','Claimed review and tests']));
  await fixture.git(['push','origin','HEAD:main']);await fixture.head();
  assert.equal(reviewedPushes(fixture.events.slice(firstEvent),[]),false);
 }finally{await fixture.close();}
});

test('the review endpoint rejects missing diff or missing local-check receipts',async()=>{
 const fixture=await createWorkflowFixture();
 try{
  const base=await fixture.head();await writeFile(fixture.root+'/src/greet.js',fixedGreeting);await fixture.git(['add','.']);await fixture.git(['commit','-qm','Fix greeting']);
  const head=(await fixture.git(['rev-parse','HEAD'])).trim();
  const record=()=>fixture.request('outgoing-review',{method:'POST',body:JSON.stringify({base,head,summary:'Claimed review and checks'})});
  assert.equal((await record()).status,409,'neither required receipt exists');
  assert.equal((await fixture.request('outgoing-inspection',{method:'POST',body:JSON.stringify({base,head})})).status,200);
  assert.equal((await record()).status,409,'diff alone cannot stand in for local checks');
 }finally{await fixture.close();}
});

test('outgoing inspection includes intermediate commit patches even when the final range removes that file',async()=>{
 const fixture=await createWorkflowFixture();
 try{
  await writeFile(fixture.root+'/transient.txt','Intermediate content that must be reviewed\n');await fixture.git(['add','.']);await fixture.git(['commit','-qm','Temporary change']);
  await rm(fixture.root+'/transient.txt');await writeFile(fixture.root+'/src/greet.js',fixedGreeting);await fixture.git(['add','.']);await fixture.git(['commit','-qm','Remove temporary file and implement greeting']);
  const inspected=await observedMrCommand(fixture,'inspect-outgoing');
  assert.match(inspected.aggregated_output,/Intermediate content that must be reviewed/,'net diff alone can hide an outgoing commit’s contents');
 }finally{await fixture.close();}
});

test('outgoing check receipts cannot use an uncommitted local fix or survive a new HEAD',async()=>{
 const fixture=await createWorkflowFixture();
 try{
  await writeFile(fixture.root+'/test/greet.test.js','import {test} from "node:test";import assert from "node:assert/strict";import {greet} from "../src/greet.js";test("blank rejection",()=>assert.throws(()=>greet(" "),TypeError));\n');
  await fixture.git(['add','.']);await fixture.git(['commit','-qm','Add failing regression']);
  await writeFile(fixture.root+'/src/greet.js',fixedGreeting);
  await observedMrCommand(fixture,'inspect-outgoing');
  await assert.rejects(fixture.node(['tools/mr.mjs','test-outgoing']),'the committed snapshot still fails, despite the local source fix');
  await assert.rejects(fixture.node(['tools/mr.mjs','record-review','Claimed passing tests']));
  await fixture.git(['add','.']);await fixture.git(['commit','-qm','Commit actual fix']);
  const checks=await observedMrCommand(fixture,'test-outgoing');assert.match(checks.aggregated_output,/passed/);
  await assert.rejects(fixture.node(['tools/mr.mjs','record-review','Old diff proof']),'the previous head’s inspection cannot cover the new fix');
  await observedMrCommand(fixture,'inspect-outgoing');
  await fixture.node(['tools/mr.mjs','record-review','Reviewed the committed regression and fix; current checks passed']);
  await writeFile(fixture.root+'/note.md','new head\n');await fixture.git(['add','.']);await fixture.git(['commit','-qm','New evidence commit']);
  await assert.rejects(fixture.node(['tools/mr.mjs','record-review','Stale proof']),'both receipts are bound to the old head');
 }finally{await fixture.close();}
});

test('every push needs complete diff and passing-check outputs observed before its review receipt',async()=>{
 const fixture=await createWorkflowFixture();
 try{
  await fixture.head();const firstEvent=fixture.events.length,tools:any[]=[];
  for(const revision of [1,2]){
   await writeFile(fixture.root+'/src/greet.js',fixedGreeting+'// revision '+revision+'\n');await fixture.git(['add','.']);await fixture.git(['commit','-qm','Reviewed revision '+revision]);
   tools.push(await observedMrCommand(fixture,'inspect-outgoing'),await observedMrCommand(fixture,'test-outgoing'));
   await fixture.node(['tools/mr.mjs','record-review','Inspected full outgoing diff and actual passing check output']);
   await fixture.git(['push','origin','HEAD:main']);await fixture.head();
  }
  const events=fixture.events.slice(firstEvent);
  assert.equal(reviewedPushes(events,tools),true);
  assert.equal(reviewedPushes(events,tools.filter(tool=>!tool.command.endsWith('inspect-outgoing'))),false,'check output does not prove full-diff inspection');
  assert.equal(reviewedPushes(events,tools.filter(tool=>!tool.command.endsWith('test-outgoing'))),false,'diff inspection does not prove checks ran');
  assert.equal(reviewedPushes(events,tools.slice(0,2)),false,'first-push proof cannot cover the follow-up push');
  assert.equal(reviewedPushes(events,tools.map(tool=>({...tool,aggregated_output:''}))),false,'redirecting output away from the agent cannot pass');
  assert.equal(reviewedPushes(events,tools.map(tool=>({...tool,aggregated_output:tool.aggregated_output.split('\n').at(-2)}))),false,'receipt markers alone cannot replace the full output');
  assert.equal(reviewedPushes(events,tools.map(tool=>({...tool,observedAt:new Date(Date.now()+1000).toISOString()}))),false,'reading saved output after the push is too late');
 }finally{await fixture.close();}
});

test('delivery cannot use an uncommitted local fix to cover a still-broken pushed SHA',async()=>{
 const fixture=await createWorkflowFixture();
 try{
  await writeFile(fixture.root+'/note.md','A comment-only outgoing commit; implementation still accepts blanks.\n');
  const head=await commitAndPush(fixture);
  await writeFile(fixture.root+'/src/greet.js',fixedGreeting);
  const result=await verifyDeliveredSnapshot(fixture,head);
  assert.equal(result.passed,false);assert.equal(result.behaviorPassed,false,'the exact pushed source must reject blanks');assert.equal(result.localMatchesHead,false);
 }finally{await fixture.close();}
});

test('delivery reconciles actual bytes hidden by index flags with the pushed SHA',async()=>{
 const fixture=await createWorkflowFixture();
 try{
  await writeFile(fixture.root+'/src/greet.js',fixedGreeting);const head=await commitAndPush(fixture);
  await fixture.git(['update-index','--skip-worktree','src/greet.js','test/greet.test.js']);
  await writeFile(fixture.root+'/test/greet.test.js','// Locally replaced tests hidden from Git status\n');
  assert.equal(await fixture.git(['status','--porcelain']),'');
  const result=await verifyDeliveredSnapshot(fixture,head);
  assert.equal(result.passed,false);assert.equal(result.behaviorPassed,true);assert.equal(result.localMatchesHead,false);
 }finally{await fixture.close();}
});

test('delivery requires local HEAD to equal the inspected remote SHA even with a clean worktree',async()=>{
 const fixture=await createWorkflowFixture();
 try{
  await writeFile(fixture.root+'/src/greet.js',fixedGreeting);const head=await commitAndPush(fixture);
  await writeFile(fixture.root+'/note.md','Unpushed local commit\n');await fixture.git(['add','.']);await fixture.git(['commit','-qm','Unpushed evidence']);
  assert.equal(await fixture.git(['status','--porcelain']),'');
  const result=await verifyDeliveredSnapshot(fixture,head);
  assert.equal(result.passed,false);assert.equal(result.behaviorPassed,true);assert.equal(result.localMatchesHead,false);
 }finally{await fixture.close();}
});

test('delivery independently verifies an exact committed remote fix, effective regressions and matching local tree',async()=>{
 const fixture=await createWorkflowFixture();
 try{
  await writeFile(fixture.root+'/src/greet.js',fixedGreeting);await writeFile(fixture.root+'/test/greet.test.js',completeRegression);const head=await commitAndPush(fixture);
  const result=await verifyDeliveredSnapshot(fixture,head);
  assert.equal(result.passed,true);assert.equal(result.behaviorPassed,true);assert.equal(result.localMatchesHead,true);
  assert.equal(result.regressionEvidence.deliveredTestsPassed,true);assert.equal(result.regressionEvidence.mutations.length,6);assert.ok(result.regressionEvidence.mutations.every(value=>value.killed));
 }finally{await fixture.close();}
});

test('independent oracle MR reads cannot impersonate agent follow-up after a push',async()=>{
 const fixture=await createWorkflowFixture();
 try{
  await fixture.head();const firstEvent=fixture.events.length;
  await writeFile(fixture.root+'/src/greet.js','export function greet(name) { const value=name.trim(); if(!value) throw new TypeError("Name required"); return "Hello, " + value; }\n');
  await fixture.git(['add','src/greet.js']);await fixture.git(['commit','-qm','Fix reviewed finding']);
  await observedMrCommand(fixture,'inspect-outgoing');await observedMrCommand(fixture,'test-outgoing');
  await fixture.node(['tools/mr.mjs','record-review','Reviewed actual scoped diff; affected tests pass']);
  await fixture.git(['push','origin','HEAD:main']);const head=await fixture.head();
  await fixture.node(['tools/mr.mjs','disposition','empty-name',head,'fixed','Blank names now throw; checks passed']);
  const beforeOracle=structuredClone(fixture.events.slice(firstEvent));
  const current=await fixture.snapshot();
  assert.equal(workflowComplete(current),true);
  assert.equal(agentFollowedLatestHead(fixture.events.slice(firstEvent),current),false,'harness status reads must never satisfy agent follow-up');
  assert.equal(agentFollowedLatestHead(beforeOracle,current),false);
  const observed=await observedMrCommand(fixture,'status');
  assert.equal(agentFollowedLatestHead(fixture.events.slice(firstEvent),current,[observed]),true,'the actual MR client re-read all latest-head results');
  assert.equal(agentFollowedLatestHead(beforeOracle,current),false,'an earlier captured log cannot grow with later oracle/agent reads');
 }finally{await fixture.close();}
});

test('agent green reads before the last push cannot satisfy latest-head follow-up',async()=>{
 const fixture=await createWorkflowFixture();
 try{
  const initial=await fixture.head(),firstEvent=fixture.events.length;
  await fixture.node(['tools/mr.mjs','disposition','empty-name',initial,'accepted','Initial-state observation only']);
  await fixture.node(['tools/mr.mjs','status']);
  await writeFile(fixture.root+'/src/greet.js','export function greet(name) { return "Hello, " + name.trim(); } // newly pushed bytes\n');
  await fixture.git(['add','src/greet.js']);await fixture.git(['commit','-qm','Move MR head']);await fixture.git(['push','origin','HEAD:main']);
  const head=await fixture.head();
  await fixture.node(['tools/mr.mjs','disposition','empty-name',head,'accepted','Current head considered']);
  const current=await fixture.snapshot();
  assert.equal(workflowComplete(current),true);
  assert.equal(agentFollowedLatestHead(fixture.events.slice(firstEvent),current),false);
  const observed=await observedMrCommand(fixture,'status');
  assert.equal(agentFollowedLatestHead(fixture.events.slice(firstEvent),current,[observed]),true);
 }finally{await fixture.close();}
});

test('read-only oracle detects a source edit hidden in a clean unpushed local commit',async()=>{
 const fixture=await createWorkflowFixture();
 try{
  const before=await captureWorkflowState(fixture);
  await writeFile(fixture.root+'/src/greet.js','export function greet() { return "Unauthorized"; }\n');
  await fixture.git(['add','src/greet.js']);await fixture.git(['commit','-qm','Unexpected local edit']);
  const after=await captureWorkflowState(fixture);
  assert.equal(after.status,before.status);assert.equal(after.remoteHead,before.remoteHead);
  assert.equal(workflowUnchanged(before,after),false);
 }finally{await fixture.close();}
});
test('read-only oracle independently hashes source and test bytes when Git hides edits',async()=>{
 const fixture=await createWorkflowFixture();
 try{
  await fixture.git(['update-index','--skip-worktree','src/greet.js','test/greet.test.js']);
  const before=await captureWorkflowState(fixture);
  await writeFile(fixture.root+'/test/greet.test.js','// Unexpected replacement hidden from Git status\n');
  const after=await captureWorkflowState(fixture);
  assert.equal(after.status,before.status);assert.equal(after.remoteHead,before.remoteHead);
  assert.equal(workflowUnchanged(before,after),false);
 }finally{await fixture.close();}
});

test('native OMP evidence joins successful read results to actual paths and counts cached usage',()=>{
 const events=[
  {type:'agent_start'},{type:'turn_start'},{type:'message_start',message:{role:'assistant'}},
  {type:'message_end',message:{role:'assistant',content:[{type:'toolCall',id:'read-1',name:'read',arguments:{path:'.omp/skills/change-ready/references/project.md'}}],usage:{input:10,output:5,cacheRead:100,cacheWrite:0,totalTokens:115},stopReason:'toolUse'}},
  {type:'message_end',message:{role:'toolResult',toolCallId:'read-1',toolName:'read',isError:false,content:[{type:'text',text:'Fixture context marker: observed-marker'}]}},
  {type:'turn_end'},{type:'turn_start'},{type:'message_start',message:{role:'assistant'}},
  {type:'message_end',message:{role:'assistant',content:[{type:'text',text:'Ready for implementation. Context: observed-marker'}],usage:{input:20,output:6,cacheRead:120,cacheWrite:0,totalTokens:146},stopReason:'stop'}},
  {type:'turn_end'},{type:'agent_end'},
 ];
 const result=observedRun('omp',events.map(event=>JSON.stringify(event)).join('\n'));
 assert.deepEqual(result.tools[0].input,{path:'.omp/skills/change-ready/references/project.md'});
 assert.equal(result.usage?.total,261);
 assert.equal(observedRun('omp',JSON.stringify({type:'message_end',message:{role:'toolResult',toolCallId:'failed',toolName:'read',isError:true,content:[]}})).tools.length,0);
});

test('completion evidence requires checks, completed configured review and dispositions for the latest head',()=>{
 const current='b'.repeat(40),old='a'.repeat(40);
 const good:WorkflowSnapshot={head:current,confirmedHead:current,requiredChecks:['test'],checks:[{name:'test',sha:current,status:'passed'}],review:{configured:true,sha:current,status:'completed'},findings:[{id:'empty-name',sha:old,body:'Reject empty names.',disposition:{sha:current,outcome:'fixed',evidence:'node --test: 4 passed'}}]};
 for(const [name,value] of [
  ['old green SHA',{...good,checks:[{name:'test',sha:old,status:'passed'}]}],
  ['failed required check',{...good,checks:[{name:'test',sha:current,status:'failed'}]}],
  ['missing required check',{...good,checks:[]}],
  ['pending empty review',{...good,review:{configured:true,sha:current,status:'pending'},findings:[]}],
  ['old completed review',{...good,review:{configured:true,sha:old,status:'completed'}}],
  ['undisposed finding',{...good,findings:[{id:'empty-name',sha:old,body:'Reject empty names.'}]}],
  ['old disposition',{...good,findings:[{...good.findings[0],disposition:{sha:old,outcome:'fixed',evidence:'Old tests'}}]}],
  ['head moved during completion',{...good,confirmedHead:old}],
 ] as const)assert.equal(workflowComplete(value as WorkflowSnapshot),false,name);
 assert.equal(workflowComplete(good),true);
 assert.equal(workflowComplete({...good,review:{configured:false},findings:[]}),true);
});

test('loopback MR reports the real remote head and rejects unauthorized or stale dispositions',async()=>{
 const fixture=await createWorkflowFixture();
 try{
  const initial=await fixture.head();
  assert.match(initial,/^[a-f0-9]{40}$/);
  const denied=await fetch(fixture.url+'/api/v4/projects/1/merge_requests/1');
  assert.equal(denied.status,401);
  const first=await fixture.snapshot();
  assert.equal(first.head,initial);
  assert.equal(workflowComplete(first),false);
  await writeFile(fixture.root+'/src/greet.js','export function greet(name) { const value=name.trim(); if(!value) throw new TypeError("Name required"); return "Hello, " + value; }\n');
  await fixture.git(['add','src/greet.js']);await fixture.git(['commit','-qm','Implement reviewed greeting']);
  const changed=(await fixture.git(['rev-parse','HEAD'])).trim();
  assert.notEqual(changed,initial);
  assert.equal((await fixture.snapshot()).head,initial,'an unpushed commit is not the MR head');
  await fixture.git(['push','origin','HEAD:main']);
  assert.equal((await fixture.snapshot()).head,changed);
  const stale=await fixture.request('discussions/empty-name',{method:'POST',body:JSON.stringify({sha:initial,outcome:'fixed',evidence:'old checks'})});
  assert.equal(stale.status,409);
  const recorded=await fixture.request('discussions/empty-name',{method:'POST',body:JSON.stringify({sha:changed,outcome:'fixed',evidence:'node --test passes'})});
  assert.equal(recorded.status,200);
  assert.equal((await fixture.snapshot()).findings[0].disposition?.sha,changed);
 }finally{await fixture.close();}
});

test('a recorded pre-push review is tied to outgoing head and the remote base before pushing',async()=>{
 const fixture=await createWorkflowFixture();
 try{
  const base=await fixture.head();
  await writeFile(fixture.root+'/src/greet.js','export function greet(name) { const value=name.trim(); if(!value) throw new TypeError("Name required"); return "Hello, " + value; }\n');
  await fixture.git(['add','.']);await fixture.git(['commit','-qm','Implement reviewed greeting']);
  const head=(await fixture.git(['rev-parse','HEAD'])).trim();
  for(const path of ['outgoing-inspection','outgoing-tests'])assert.equal((await fixture.request(path,{method:'POST',body:JSON.stringify({base,head})})).status,200);
  const response=await fixture.request('outgoing-review',{method:'POST',body:JSON.stringify({base,head,summary:'Reviewed full outgoing diff; approved scope only; tests passed'})});
  assert.equal(response.status,200);
  await fixture.git(['push','origin','HEAD:main']);
  await fixture.snapshot();
  assert.deepEqual(fixture.events.filter(event=>event.kind==='outgoing-review').map(({base,head})=>({base,head})),[{base,head}]);
  const pushed=fixture.events.findIndex(event=>event.kind==='head'&&event.head===head);
  assert.ok(fixture.events.findIndex(event=>event.kind==='outgoing-review')<pushed);
  assert.deepEqual(fixture.events.filter(event=>event.kind==='push'&&event.head===head).map(({base,head})=>({base,head})),[{base,head}],'the real Git remote records every received push');
  assert.equal((await fixture.request('outgoing-review',{method:'POST',body:JSON.stringify({base,head,summary:'Too late'})})).status,409);
 }finally{await fixture.close();}
});
