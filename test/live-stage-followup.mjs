// Opt-in continuation of the recorded real case; never resets its run or ledger.
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,readdir,writeFile,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname,join,resolve} from 'node:path';
import {homedir} from 'node:os';
const exec=promisify(execFile),sha=value=>createHash('sha256').update(value).digest('hex');
assert.equal(process.env.RIGUP_LIVE_STAGE_FOLLOWUP,'1','explicitly opt in to real default-Codex consumption');
const base=await realpath(process.env.RIGUP_E2E_WORKSPACE),cli=await realpath(process.env.RIGUP_E2E_CLI);
assert.ok(base.startsWith('/private/tmp/rigup-context-e2e-'));assert.ok(cli.endsWith('/rigup/dist/cli.js'));
const original=JSON.parse(await readFile(base+'/result.json','utf8')),fixture=JSON.parse(await readFile(base+'/fixture.json','utf8')),root=original.root;
assert.equal(original.status,'passed');assert.equal(fixture.commit,'9506629ed003a561c6627735480cce4994244bb4');assert.equal(root,base+'/frontend');
assert.deepEqual(original.options.researchBudget,{maxCalls:12,maxTokens:1200000});assert.deepEqual(JSON.parse(await readFile(root+'/.rigup/config.yaml','utf8')),fixture.options);
const env={...process.env,HOME:base+'/home',CODEX_HOME:process.env.CODEX_HOME??join(homedir(),'.codex'),XDG_CONFIG_HOME:base+'/home/config',DO_NOT_TRACK:'1',OPENSPEC_TELEMETRY:'0',NO_COLOR:'1'};
delete env.ANTHROPIC_API_KEY;delete env.ANTHROPIC_MODEL;
const exchange=base+'/home/.cache/rigup/codex/exchange',durable=base+'/home/.local/state/rigup',usageDir=durable+'/codex';
const ledgers=async()=>Object.fromEntries(await Promise.all((await readdir(usageDir)).filter(f=>f.endsWith('.usage.json')).sort().map(async f=>[f,JSON.parse(await readFile(usageDir+'/'+f,'utf8'))])));
const totals=values=>{const attempts=Object.values(values).flatMap(v=>Object.values(v.attempts));assert.ok(attempts.every(a=>Number.isSafeInteger(a.tokens)&&a.tokens>=0),'unknown consumption must be reconciled before any retry');return {calls:attempts.length,tokens:attempts.reduce((n,a)=>n+a.tokens,0)};};
const budget=values=>{const used=totals(values);assert.ok(used.calls<=12&&used.tokens<=1200000,'same original cumulative budget');return used;};
const oldAnalysis=original.requests.find(r=>r.kind==='analyze');let context;
for(const file of await readdir(exchange,{recursive:true}))if(file.endsWith(oldAnalysis.requestId+'.request.json'))context=JSON.parse(await readFile(exchange+'/'+file,'utf8')).context;
assert.ok(context);let run;
for(const file of await readdir(durable+'/runs'))if(file.endsWith('.json')){const value=JSON.parse(await readFile(durable+'/runs/'+file,'utf8'));if(value.runId===context.runId)run=value;}
assert.ok(run&&run.root===root);const before=await ledgers();budget(before);
const tag='review-'+Date.now(),out=process.env.RIGUP_LIVE_EVIDENCE_DIR??'docs/compatibility/evidence/2026-11-05-stage-context';
const packageRoot=resolve(dirname(cli),'..'),report={status:'running',startedAt:new Date().toISOString(),workspace:base,root,upstreamCommit:fixture.commit,originalRunId:run.runId,continuation:run.consent,options:fixture.options,package:{sourceRevision:process.env.RIGUP_E2E_SOURCE_REVISION,cliSha256:sha(await readFile(cli)),policySha256:sha(await readFile(packageRoot+'/dist/analyzer/stage-context.js')),generatorSha256:sha(await readFile(packageRoot+'/dist/generator/generate.js'))},before,steps:[],historicalReport:'bulletproof-semantic-e2e.json',limits:{maxCalls:12,maxTokens:1200000},notes:['Unchanged analysis/planning reused; content and independent acceptance regenerated for the expanded authority contract.','Original responses, case, run identity, known consumption and historical report remain unchanged.']};
const invoke=async(label,args)=>{
 budget(await ledgers());const child=spawn(cli,args,{cwd:root,env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',v=>stdout+=v);child.stderr.on('data',v=>stderr+=v);
 const timer=setTimeout(()=>child.kill('SIGINT'),25*60*1000);const code=await new Promise((done,fail)=>{child.once('error',fail);child.once('close',done);});clearTimeout(timer);
 await writeFile(base+'/'+tag+'-'+label+'.stdout.json',stdout,{mode:0o600});await writeFile(base+'/'+tag+'-'+label+'.stderr.log',stderr,{mode:0o600});
 const data=JSON.parse(stdout);report.steps.push({label,args,code,data});console.log(label+': '+code+' / '+data.phase);return {code,data};
};
try{
 const prepared=await invoke('01-preview',['update',root,'--continue',run.consent,'--resume','--json']);assert.equal(prepared.code,3,JSON.stringify(prepared.data));assert.equal(prepared.data.executable,true);assert.equal(prepared.data.phase,'handoff');assert.deepEqual(prepared.data.operations,[]);
 const applied=await invoke('02-apply',['update',root,'--apply',prepared.data.previewId,'--sessions-ended','--resume','--json']);assert.equal(applied.code,0,JSON.stringify(applied.data));
 const after=await ledgers();const counts=budget(after);assert.deepEqual(Object.keys(after),Object.keys(before),'no new paid-run ledger');
 for(const [file,ledger] of Object.entries(before))for(const [id,attempt] of Object.entries(ledger.attempts))assert.deepEqual(after[file].attempts[id],attempt);
 const preview=await invoke('03-unchanged',['update',root,'--dry-run','--sessions-ended','--json']);assert.equal(preview.code,0,JSON.stringify(preview.data));assert.deepEqual(preview.data.operations,[]);assert.ok(preview.data.items.every(i=>i.action==='keep'));
 const unchanged=await invoke('04-unchanged-apply',['update',root,'--apply',preview.data.previewId,'--sessions-ended','--json']);assert.equal(unchanged.code,0,JSON.stringify(unchanged.data));assert.deepEqual(unchanged.data.written,[]);assert.deepEqual(await ledgers(),after);
 const manifest=JSON.parse(await readFile(root+'/.rigup/manifest.json','utf8'));const ref=manifest.assets.find(a=>a.target.endsWith('change-deliver/references/project.md'));assert.match(await readFile(root+'/'+ref.target,'utf8'),/Local E2E note: preserve this user-maintained addition/);
 for(const [path,hash] of Object.entries(fixture.originalHashes)){const body=await readFile(root+'/'+path);if(sha(body)===hash)continue;assert.equal(path,'AGENTS.md');assert.equal(body.toString().split('<!-- rigup:start -->')[0],(await exec('git',['-C',root,'show','HEAD:AGENTS.md'])).stdout);}
 for(const [path,hash] of Object.entries(fixture.nativeHashes))assert.equal(sha(await readFile(root+'/'+path)),hash);
 const requests=[];for(const file of await readdir(exchange,{recursive:true}))if(file.endsWith('.request.json')){const raw=await readFile(exchange+'/'+file,'utf8'),value=JSON.parse(raw);if(value.context.evidencePolicy!=='stage-evidence-v2')continue;
  assert.equal(value.context.runId,run.runId);assert.deepEqual(value.context.budget,report.limits);assert.deepEqual(value.context.options.scope,fixture.options.scope);assert.ok(!value.evidence.some(e=>e.evidence.path.endsWith('yarn.lock')));
  for(const g of value.context.input?.research?.guidance??value.context.input?.profile?.research?.data?.guidance??[])if(['reusable','partial'].includes(g.coverageStatus))assert.ok(value.evidence.some(e=>['path','startLine','endLine','digest'].every(k=>e.evidence[k]===g.sourceRef[k])));
  const chars=value.evidence.reduce((n,e)=>n+e.content.length,0);assert.ok(chars<=oldAnalysis.evidenceChars*0.65);requests.push({requestId:value.requestId,stage:value.context.expectedOutput,policy:value.context.evidencePolicy,bytes:Buffer.byteLength(raw),evidenceFiles:new Set(value.evidence.map(e=>e.evidence.path)).size,evidenceChars:chars,selection:value.context.evidenceSelection,sourceRefs:value.evidence.map(e=>e.evidence)});
 }
 assert.ok(requests.some(r=>r.stage==='content'));assert.ok(requests.some(r=>r.stage==='acceptance'));
 if(requests.some(r=>r.stage==='plan'))report.notes[0]='Analysis reused; planning, content and independent acceptance revalidated for the expanded authority contract.';
 report.requests=requests;report.after=after;report.actualModelCalls=counts.calls;report.actualObservedTokens=counts.tokens;report.newModelCalls=counts.calls-totals(before).calls;report.newObservedTokens=counts.tokens-totals(before).tokens;report.unchangedModelCalls=0;report.unchangedWritten=0;report.localNoteProtected=true;report.status='passed';
}catch(error){report.status='failed';report.reason=error.message;report.after=await ledgers();process.exitCode=1;}
finally{report.finishedAt=new Date().toISOString();await writeFile(base+'/'+tag+'.json',JSON.stringify(report,null,2)+'\n',{mode:0o600});await writeFile(out+'/review-followup-e2e.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,calls:report.actualModelCalls,tokens:report.actualObservedTokens,reason:report.reason}));}
