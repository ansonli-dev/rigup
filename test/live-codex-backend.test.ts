import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {runCli} from '../src/cli.js';
const exec=promisify(execFile);
test('live default Codex researches generates applies and reuses without another API credential',{skip:process.env.RIGUP_LIVE_CODEX_BACKEND!=='1',timeout:600000},async()=>{
 const prior=process.env.RIGUP_CODEX_MAINLINE_RESUME?JSON.parse(await readFile(process.env.RIGUP_CODEX_MAINLINE_RESUME,'utf8')):undefined;
 if(prior&&(!prior.root?.startsWith('/private/tmp/rigup-codex-mainline-')||!prior.control?.startsWith('/private/tmp/rigup-codex-mainline-control-')))throw Error('Invalid disposable mainline resume fixture');
 const root=prior?.root??await realpath(await mkdtemp('/private/tmp/rigup-codex-mainline-')),control=prior?.control??await realpath(await mkdtemp('/private/tmp/rigup-codex-mainline-control-'));
 const evidence:any={caseId:'codex/default-local-mainline',status:'failed',root,control,startedAt:new Date().toISOString(),node:process.version,platform:process.platform,reports:[]};
 try{
  const openspec=process.env.RIGUP_OPENSPEC_BIN;assert.ok(openspec,'Supply the pinned official OpenSpec 1.16.0 CLI');assert.equal((await exec(openspec,['--version'])).stdout.trim(),'1.16.0');
  const source='export function createOrder(reference) { return {reference}; }\n';
  const readme='# Order fixture\n\nThis small service exports createOrder(reference) from src/order.js. The function returns an object containing the supplied reference. No network, database, deployment, or testing command is configured. This README is authoritative; reuse it rather than duplicating it.\n';
  if(!prior){await exec('git',['-C',root,'-c','init.templateDir=','init','-q']);await mkdir(root+'/src');await writeFile(root+'/src/order.js',source);await writeFile(root+'/README.md',readme);await writeFile(root+'/profile.yaml','sdd: openspec\nresearchBudget: {maxCalls: 8, maxTokens: 300000}\n');await exec(openspec,['init','--tools','codex'],{cwd:root,env:{...process.env,DO_NOT_TRACK:'1'},timeout:30000,maxBuffer:200000});}
  else{assert.equal(await readFile(root+'/README.md','utf8'),readme);assert.equal(await readFile(root+'/src/order.js','utf8'),source);evidence.resumedFrom=process.env.RIGUP_CODEX_MAINLINE_RESUME;}
  const run=async(args:string[])=>{let output='';const code=await runCli(args,{cwd:root,isTTY:false,write:s=>output+=s,services:{cacheRoot:control+'/cache',stateRoot:control+'/state'}});let report;try{report=JSON.parse(output);}catch{throw Error('Expected one final CLI JSON report');}evidence.reports.push(report);assert.equal(code,0,JSON.stringify(report));return report;};
  const first=await run(['init','--profile','profile.yaml','--sessions-ended','--json']);assert.equal(first.status,'complete');
  const budgetFiles=()=>readdir(control+'/state/codex').then(names=>names.filter(p=>p.endsWith('.usage.json')));
  const readBudgets=async()=>Promise.all((await budgetFiles()).map(async p=>JSON.parse(await readFile(control+'/state/codex/'+p,'utf8'))));
  const before=await readBudgets();assert.ok(before.some(b=>Object.keys(b.attempts).length>=2));for(const b of before)for(const a of Object.values(b.attempts) as any[]){assert.equal(a.status,'observed');assert.equal(typeof a.tokens,'number');}
  await run(['update','--sessions-ended','--json']);assert.deepEqual(await readBudgets(),before);
  assert.equal(await readFile(root+'/src/order.js','utf8'),source);assert.equal(await readFile(root+'/README.md','utf8'),readme);
  evidence.status='passed';evidence.usage=before;evidence.scope='Actual default local Codex backend, official OpenSpec bindings, bounded filtered research, generation/apply and unchanged reuse. No model override/switch or Anthropic credential.';
 }catch(error){evidence.reason=(error as Error).message;throw error;}
 finally{evidence.finishedAt=new Date().toISOString();const folder=process.env.RIGUP_LIVE_EVIDENCE_DIR??'docs/compatibility/evidence/2026-11-04-native-initialization';await mkdir(folder,{recursive:true});await writeFile(folder+'/codex-mainline.json',JSON.stringify(evidence,null,2)+'\n');if(evidence.status==='passed'){await rm(root,{recursive:true,force:true});await rm(control,{recursive:true,force:true});}}
});
