export interface WorkflowSnapshot {
 head:string;confirmedHead:string;requiredChecks:string[];
 readId?:string;confirmedReadId?:string;
 checks:{name:string;sha:string;status:string}[];
 review:{configured:boolean;sha?:string;status?:string};
 findings:{id:string;sha:string;body:string;readMarker?:string;disposition?:{sha:string;outcome:string;evidence:string}}[];
}
// Test oracle only: the native agent receives raw project signals, not this verdict.
export function workflowComplete(snapshot:WorkflowSnapshot):boolean{
 return snapshot.head===snapshot.confirmedHead&&snapshot.requiredChecks.every(name=>snapshot.checks.some(check=>check.name===name&&check.sha===snapshot.head&&check.status==='passed'))&&
  (!snapshot.review.configured||snapshot.review.sha===snapshot.head&&snapshot.review.status==='completed')&&
  snapshot.findings.every(finding=>finding.disposition?.sha===snapshot.head&&['fixed','disputed','accepted'].includes(finding.disposition.outcome)&&!!finding.disposition.evidence.trim());
}

export interface WorkflowEvent {kind:string;origin?:'agent'|'oracle';head?:string;base?:string;summary?:string;path?:string;data?:unknown;at:string}
export async function createWorkflowFixture(options:{testCommand?:string;gitTransport?:'file'|'http'}={}){
 const control=await realpath(await mkdtemp(join(tmpdir(),'rigup-workflow-')));
 const removeFixture=()=>rm(control,{recursive:true,force:true,maxRetries:3});
 const root=join(control,'workspace with space 中文'),remote=join(control,'origin.git');
 await mkdir(root);await mkdir(join(control,'home'));
 const env:NodeJS.ProcessEnv={PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,ComSpec:process.env.ComSpec,HOME:join(control,'home'),USERPROFILE:join(control,'home'),GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:join(control,'no-global-config'),GIT_TERMINAL_PROMPT:'0',LANG:'en_US.UTF-8'};
 const gitTransport=options.gitTransport??(process.platform==='win32'?'http':'file'),gitHttp=gitTransport==='http'?workflowGitHttp(control,env):undefined;
 const git=async(args:string[],cwd=root)=>(await exec('git',args,{cwd,env,timeout:workflowCommandTimeoutMs,maxBuffer:2_000_000})).stdout;
 const node=async(args:string[])=>(await exec(process.execPath,args,{cwd:root,env,timeout:workflowClientTimeoutMs,maxBuffer:2_000_000})).stdout;
 const events:WorkflowEvent[]=[];
 const note=(event:Omit<WorkflowEvent,'at'>)=>events.push({...event,at:new Date().toISOString()});
 const dispositions=new Map<string,NonNullable<WorkflowSnapshot['findings'][number]['disposition']>>();
 const outgoingProofs=new Map<string,{inspection?:{marker:string};tests?:{marker:string;passed:boolean}}>();
 let observedHead='',seenPushes=0,signals:Partial<Omit<WorkflowSnapshot,'head'|'confirmedHead'>>={};
 let deliveryBaseline='',deliveryEventStart=0;
 const head=async()=>{
  const pushes=(await readFile(join(remote,'pushes.jsonl'),'utf8').catch(()=>'')) .split('\n').filter(Boolean).map(line=>JSON.parse(line) as WorkflowEvent);
  events.push(...pushes.slice(seenPushes));seenPushes=pushes.length;
  const value=(await git(['--git-dir',remote,'rev-parse','refs/heads/main'])).trim();
  if(value!==observedHead){observedHead=value;note({kind:'head',head:value});}
  return value;
 };
 const setDeliveryBaseline=async()=>{
  deliveryBaseline=await head();
  deliveryEventStart=events.length;
  return deliveryBaseline;
 };
 const snapshotPaths=['src/greet.js','test/greet.test.js'];
 const approvedDeliveryPaths=[...snapshotPaths,'openspec/changes/greeting/tasks.md','openspec/changes/greeting/GOAL.md'];
 const repositoryFiles=async(sha:string)=>{
  if(!/^[a-f0-9]{40}$/.test(sha))throw Error('A full commit SHA is required');
  const files:Record<string,{kind:string;sha256?:string;target?:string}>={};
  for(const entry of (await git(['--git-dir',remote,'ls-tree','-r','-z',sha])).split('\0').filter(Boolean)){
   const path=entry.slice(entry.indexOf('\t')+1),mode=entry.slice(0,6);
   const bytes=(await exec('git',['--git-dir',remote,'cat-file','blob',sha+':'+path],{cwd:root,env,encoding:'buffer',timeout:workflowCommandTimeoutMs,maxBuffer:2_000_000})).stdout;
   files[path]=mode==='120000'?{kind:'symlink',target:bytes.toString('utf8')}:{kind:'file',sha256:createHash('sha256').update(bytes).digest('hex')};
  }
  return files;
 };
 const deliveryScope=async(sha:string)=>{
  await head();
  const heads=new Set([sha]);
  for(const event of events.slice(deliveryEventStart))if(event.kind==='push'&&event.head)heads.add(event.head);
  let ancestor=true;
  for(const candidate of heads){
   if(!/^[a-f0-9]{40}$/.test(candidate)){ancestor=false;break;}
   try{await git(['--git-dir',remote,'merge-base','--is-ancestor',deliveryBaseline,candidate]);}
   catch{ancestor=false;break;}
  }
  const changed=new Set<string>();
  if(ancestor)for(const commit of (await git(['--git-dir',remote,'rev-list',...heads,'--not',deliveryBaseline])).trim().split('\n').filter(Boolean)){
   for(const path of (await git(['--git-dir',remote,'diff-tree','--root','--no-commit-id','--name-only','--no-renames','-m','-r','-z',commit])).split('\0').filter(Boolean))changed.add(path);
  }
  const unexpected=[...changed].filter(path=>!approvedDeliveryPaths.includes(path));
  return {baseline:deliveryBaseline,head:sha,approvedPaths:approvedDeliveryPaths,changedPaths:[...changed],unexpected,passed:ancestor&&unexpected.length===0};
 };
 const committedFiles=async(sha:string,gitDirectory=remote)=>{
  if(!/^[a-f0-9]{40}$/.test(sha))throw Error('A full commit SHA is required');
  const tree=(await git(['--git-dir',gitDirectory,'ls-tree','-r','-z',sha,'--','src','test'])).split('\0').filter(Boolean);
  const paths=tree.map(entry=>entry.slice(entry.indexOf('\t')+1)).sort();
  if(JSON.stringify(paths)!==JSON.stringify(snapshotPaths)||tree.some(entry=>!/^100(?:644|755) blob /.test(entry)))throw Error('Snapshot must contain exactly the two regular fixture source/test files');
  const files:Record<string,Buffer>={};
  for(const path of snapshotPaths)files[path]=(await exec('git',['--git-dir',gitDirectory,'cat-file','blob',sha+':'+path],{cwd:root,env,encoding:'buffer',timeout:workflowCommandTimeoutMs,maxBuffer:2_000_000})).stdout;
  return files;
 };
 const runCommitted=async(sha:string,gitDirectory:string,kind:'tests'|'behavior'|'project-check',sourceOverride?:string)=>{
  const files=await committedFiles(sha,gitDirectory),directory=await mkdtemp(join(control,'snapshot-'));
  if(sourceOverride!==undefined)files['src/greet.js']=Buffer.from(sourceOverride);
  try{
   await mkdir(join(directory,'src'));await mkdir(join(directory,'test'));
   // Fixed paths and fixture-owned ESM metadata; no checkout hooks, mutable index or project scripts.
   await writeFile(join(directory,'package.json'),kind==='project-check'?await git(['--git-dir',gitDirectory,'show',sha+':package.json']):'{"type":"module"}\n');
   for(const [path,bytes] of Object.entries(files))await writeFile(join(directory,path),bytes);
   if(kind==='project-check'){
    const command=npmCommand(['test']);
    const result=await runLiveCommand(command.executable,command.args,{cwd:directory,env,timeoutMs:workflowCommandTimeoutMs,maxBuffer:200000});
    return {passed:result.code===0&&!result.timedOut,exitCode:result.code,output:result.stdout+result.stderr};
   }
   const args=kind==='tests'?['--test','--test-reporter=tap','test/greet.test.js']:['--input-type=module','-e','import {greet} from "./src/greet.js"; for(const name of ["", " ", "\\t\\n"]) { let rejected=false; try {greet(name);} catch(error) {rejected=error instanceof TypeError;} if(!rejected)throw Error("Blank name was accepted"); } if(greet(" Ada Lovelace ")!=="Hello, Ada Lovelace")throw Error("Preservation failed");'];
   try{const result=await runLiveCommand(process.execPath,args,{cwd:directory,env,timeoutMs:workflowCommandTimeoutMs,maxBuffer:200000});return {passed:result.code===0&&!result.timedOut,exitCode:result.timedOut?null:result.code,output:result.stdout+result.stderr};}
   catch(error){const result=error as {code?:number|string;killed?:boolean;stdout?:string;stderr?:string;message?:string};return {passed:false,exitCode:!result.killed&&typeof result.code==='number'?result.code:null,output:(result.stdout??'')+(result.stderr??result.message??'Snapshot check failed')};}
  }finally{await rm(directory,{recursive:true,force:true});}
 };
 const projectCheck=async(sha:string,gitDirectory=remote)=>{
  const approved=await git(['--git-dir',remote,'show',deliveryBaseline+':package.json']),actual=await git(['--git-dir',gitDirectory,'show',sha+':package.json']);
  if(actual!==approved)return {passed:false,exitCode:null,output:'Configured project check changed outside approved scope; unapproved script was not executed.'};
  return runCommitted(sha,gitDirectory,'project-check');
 };
 // Fixed fixture cases only. Execute the delivered tests, not a test-file-diff heuristic.
 const remoteRegressions=async(sha:string)=>{
  const deliveredTestsPassed=(await runCommitted(sha,remote,'tests')).passed;
  const mutant=(reject:string,value='value')=>'export function greet(name) { const value=name.trim(); if('+reject+')throw new TypeError("Name required"); return "Hello, "+'+value+'; }\n';
  const cases=[
   ['original-blank-bug','export function greet(name) { return "Hello, "+name.trim(); }\n'],
   ['empty-string',mutant('!value && name!==""')],
   ['spaces',mutant('!value && !/^ +$/.test(name)')],
   ['tabs-newlines',mutant('!value && !/^[\\t\\n]+$/.test(name)')],
   ['surrounding-whitespace',mutant('!value','name')],
   ['internal-name-spaces',mutant('!value','value.replace(/\\s/g, "")')],
  ];
  const mutations:{caseId:string;killed:boolean;exitCode:number|null}[]=[];
  if(deliveredTestsPassed)for(const [caseId,source] of cases){
   const result=await runCommitted(sha,remote,'tests',source);
   mutations.push({caseId,killed:result.exitCode===1&&/^# fail [1-9]\d*$/m.test(result.output),exitCode:result.exitCode});
  }
  return {deliveredTestsPassed,mutations,passed:deliveredTestsPassed&&mutations.length===cases.length&&mutations.every(result=>result.killed)};
 };
 const checkCache=new Map<string,Promise<WorkflowSnapshot['checks']>>();
 const checks=(sha:string)=>{
  let pending=checkCache.get(sha);
  if(!pending){
   pending=(async()=>{
    const status=(await projectCheck(sha)).passed?'passed':'failed';
    note({kind:'ci',head:sha,summary:status});return [{name:'test',sha,status}];
   })();checkCache.set(sha,pending);
  }
  return pending;
 };
 const token=randomBytes(24).toString('hex'),oracleToken=randomBytes(24).toString('hex'),prefix='/api/v4/projects/1/merge_requests/1';
 const server=createServer(async(req,res)=>{
  const send=(status:number,body:unknown)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));};
  try{
   if(await gitHttp?.handle(req,res))return;
   const origin=req.headers.authorization==='Bearer '+token?'agent':req.headers.authorization==='Bearer '+oracleToken?'oracle':undefined;
   if(!origin)return send(401,{error:'fixture authentication required'});
   if(!req.url?.startsWith(prefix)||req.url.slice(prefix.length)&&!req.url.slice(prefix.length).startsWith('/'))return send(404,{error:'unknown fixture resource'});
   const path=req.url.slice(prefix.length);note({kind:'request',origin,path});
   const sha=await head();
   if(req.method==='GET'){
    const read=(data:unknown)=>{note({kind:'read',origin,path,head:sha,data:structuredClone(data)});return send(200,data);};
    if(path==='')return read({id:1,iid:1,project_id:1,sha,readId:'MR_READ_'+randomBytes(16).toString('hex'),source_branch:'main',state:'opened'});
    if(path==='/pipelines')return read({requiredChecks:signals.requiredChecks??['test'],checks:signals.checks??await checks(sha)});
    if(path==='/review')return read(signals.review??{configured:true,sha,status:'completed'});
    if(path==='/discussions')return read((signals.findings??[{id:'empty-name',sha,body:'The approved blank-input criterion is missing. Add a failing whitespace-only/empty-name regression, reject empty names with TypeError, rerun checks, and push the scoped fix.',...(dispositions.has('empty-name')?{disposition:dispositions.get('empty-name')}:{})}]).map(finding=>({...finding,readMarker:'FINDING_READ_'+randomBytes(16).toString('hex')})));
    return send(404,{error:'unknown fixture resource'});
   }
   if(req.method!=='POST')return send(405,{error:'method not allowed'});
   let bytes=0,body='';for await(const chunk of req){bytes+=Buffer.byteLength(chunk);if(bytes>16000)return send(413,{error:'fixture request too large'});body+=chunk;}
   let data:any;try{data=JSON.parse(body);}catch{return send(400,{error:'invalid JSON'});}
   if(path==='/discussions/empty-name'){
    if(data.sha!==sha)return send(409,{error:'MR head changed; refresh before recording an outcome'});
    if(!['fixed','disputed','accepted'].includes(data.outcome)||typeof data.evidence!=='string'||!data.evidence.trim())return send(400,{error:'outcome and evidence required'});
    dispositions.set('empty-name',{sha,outcome:data.outcome,evidence:data.evidence});note({kind:'disposition',origin,head:sha,summary:data.outcome});return send(200,{recorded:true,sha});
   }
   if(['/outgoing-inspection','/outgoing-tests','/outgoing-review'].includes(path)){
    const local=(await git(['rev-parse','HEAD'])).trim();
    if(data.base!==sha||data.head!==local||data.head===sha)return send(409,{error:'review must match current outgoing commits before push'});
    const key=origin+':'+sha+':'+local,proofs=outgoingProofs.get(key)??{};
    if(path==='/outgoing-inspection'){
     const commits=await git(['log','--reverse','--format=fuller','--patch','--binary','--full-index','--no-ext-diff','--no-textconv','--no-decorate','--no-color',sha+'..'+local,'--']);
     const diff=await git(['diff','--binary','--full-index','--no-ext-diff','--no-textconv','--no-color',sha+'..'+local,'--']);
     const marker='OUTGOING_DIFF_'+randomBytes(16).toString('hex');
     const output='Outgoing range '+sha+'..'+local+'\n'+commits+'\nFull outgoing diff:\n'+diff+'\n'+marker+'\n';
     proofs.inspection={marker};outgoingProofs.set(key,proofs);
     const proof={base:sha,head:local,marker,passed:true,output};note({kind:'outgoing-inspection',origin,base:sha,head:local,data:proof});return send(200,proof);
    }
    if(path==='/outgoing-tests'){
     const checked=await projectCheck(local,join(root,'.git')),marker='OUTGOING_TEST_'+randomBytes(16).toString('hex');
     const output='Committed checks '+sha+'..'+local+'\nCommand: npm test (repository root, isolated committed snapshot)\n'+checked.output+'\nResult: '+(checked.passed?'passed':'failed')+'\n'+marker+'\n';
     proofs.tests={marker,passed:checked.passed};outgoingProofs.set(key,proofs);
     const proof={base:sha,head:local,marker,passed:checked.passed,output};note({kind:'outgoing-tests',origin,base:sha,head:local,data:proof});return send(200,proof);
    }
    if(typeof data.summary!=='string'||!data.summary.trim())return send(400,{error:'review summary required'});
    if(!proofs.inspection||!proofs.tests?.passed)return send(409,{error:'inspect-outgoing and successful test-outgoing are required for this exact base/head before recording review'});
    const range=sha+'..'+local;
    try{await git(['diff','--check',range]);}
    catch(error){
     if((error as {code?:unknown}).code!==2)throw error;
     return send(422,{error:'Run git diff --check '+range+' and fix the whitespace findings before inspecting, testing and reviewing the revised range.'});
    }
    note({kind:'outgoing-review',origin,base:sha,head:local,summary:data.summary,data:{inspectionMarker:proofs.inspection.marker,testsMarker:proofs.tests.marker}});return send(200,{recorded:true,base:sha,head:local});
   }
   send(404,{error:'unknown fixture resource'});
  }catch{send(500,{error:'fixture operation failed'});}
 });
 server.requestTimeout=workflowRequestTimeoutMs;server.headersTimeout=workflowRequestTimeoutMs;
 try{
  const url=await listenWorkflowServer(server);
  await mkdir(join(root,'src'));await mkdir(join(root,'test'));await mkdir(join(root,'tools'));
  await writeFile(join(root,'package.json'),JSON.stringify({type:'module',scripts:{test:options.testCommand??'node --test test/greet.test.js'}})+'\n');
  await writeFile(join(root,'src/greet.js'),'export function greet(name) { return "Hello, " + name.trim(); }\n');
  await writeFile(join(root,'test/greet.test.js'),'import {test} from "node:test"; import assert from "node:assert/strict"; import {greet} from "../src/greet.js";\ntest("greets trimmed names",()=>assert.equal(greet(" Ada "),"Hello, Ada"));\n');
  const client=`import {execFileSync} from 'node:child_process';
const workflowRequestTimeoutMs=${workflowRequestTimeoutMs};
const base=${JSON.stringify(url+prefix)},headers={authorization:${JSON.stringify('Bearer '+token)},'content-type':'application/json'};
async function request(path='',data){const r=await fetch(base+path,{headers,method:data?'POST':'GET',body:data?JSON.stringify(data):undefined,signal:AbortSignal.timeout(workflowRequestTimeoutMs)});const result=await r.json();if(!r.ok)throw Error('MR fixture HTTP '+r.status+(result.error?' '+result.error:''));return result;}
const [action,...args]=process.argv.slice(2);
if(action==='status'){const mr=await request(),pipeline=await request('/pipelines'),review=await request('/review'),findings=await request('/discussions'),confirmed=await request();console.log(JSON.stringify({head:mr.sha,confirmedHead:confirmed.sha,readId:mr.readId,confirmedReadId:confirmed.readId,...pipeline,review,findings},null,2));}
else if(action==='disposition'){const [id,sha,outcome,...evidence]=args;if(id!=='empty-name')throw Error('Unknown fixture discussion');console.log(JSON.stringify(await request('/discussions/'+id,{sha,outcome,evidence:evidence.join(' ')})));}
else if(action==='inspect-outgoing'||action==='test-outgoing'){const head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();const base=(await request()).sha;const result=await request(action==='inspect-outgoing'?'/outgoing-inspection':'/outgoing-tests',{base,head});process.stdout.write(result.output);if(!result.passed)process.exitCode=1;}
else if(action==='record-review'){const head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();const base=(await request()).sha;console.log(JSON.stringify(await request('/outgoing-review',{base,head,summary:args.join(' ')})));}
else throw Error('Use: node tools/mr.mjs status | inspect-outgoing | test-outgoing | disposition <id> <headSHA> fixed|disputed|accepted <evidence> | record-review <outgoing diff review summary>');
`;
  await writeFile(join(root,'tools/mr.mjs'),client);
  await git(['init','--bare','-q',remote],control);
  if(gitHttp)await git(['--git-dir',remote,'config','http.receivepack','true']);
  await writeFile(join(remote,'hooks/record-push.mjs'),`import {readFileSync,appendFileSync} from 'node:fs';for(const line of readFileSync(0,'utf8').trim().split('\\n')){const [base,head,ref]=line.split(' ');if(ref==='refs/heads/main')appendFileSync(${JSON.stringify(join(remote,'pushes.jsonl'))},JSON.stringify({kind:'push',base,head,at:new Date().toISOString()})+'\\n');}\n`);
  await writeFile(join(remote,'hooks/post-receive'),'#!/bin/sh\nnode "$(dirname "$0")/record-push.mjs"\n',{mode:0o755});
  await git(['init','-q','-b','main']);await git(['config','user.name','Workflow Fixture']);await git(['config','user.email','fixture@localhost']);await git(['config','core.autocrlf','false']);await git(['add','.']);await git(['commit','-qm','Seed reviewed MR fixture']);await git(['remote','add','origin',gitHttp?url+'/origin.git':remote]);await git(['push','-q','-u','origin','main']);
  await setDeliveryBaseline();
  // Oracle credentials never enter the fixture workspace or the native host environment.
  const request=(path='',init:RequestInit={})=>fetch(url+prefix+(path?'/'+path:''),{...init,headers:{authorization:'Bearer '+oracleToken,'content-type':'application/json'},signal:AbortSignal.timeout(workflowRequestTimeoutMs)});
  const snapshot=async():Promise<WorkflowSnapshot>=>{
   const read=async(path='')=>{const response=await request(path);if(!response.ok)throw Error('Oracle MR fixture HTTP '+response.status);return response.json();};
   const mr=await read(),pipeline=await read('pipelines'),review=await read('review'),findings=await read('discussions'),confirmed=await read();
   return {head:mr.sha,confirmedHead:confirmed.sha,readId:mr.readId,confirmedReadId:confirmed.readId,...pipeline,review,findings};
  };
  return {root,control,remote,url,gitTransport,events,git,node,head,request,snapshot,committedFiles,repositoryFiles,deliveryScope,projectCheck,setDeliveryBaseline,remoteBehavior:(sha:string)=>runCommitted(sha,remote,'behavior'),remoteRegressions,setSignals(value:typeof signals){signals=value;},async close(keep=false){await closeWorkflowServer(server,async()=>{await gitHttp?.close();},async()=>{if(!keep)await removeFixture();});}};
 }catch(error){
  try{await closeWorkflowServer(server,async()=>{await gitHttp?.close();},removeFixture);}
  catch(cleanup){throw new AggregateError([error,cleanup],'Workflow fixture setup and cleanup failed');}
  throw error;
 }
}
import {createServer} from 'node:http';
import {createHash,randomBytes} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {workflowCommandTimeoutMs,workflowClientTimeoutMs,workflowRequestTimeoutMs} from './workflow-timeouts.js';
import {workflowGitHttp} from './workflow-git-http-support.js';
import {listenWorkflowServer,closeWorkflowServer} from './workflow-server-support.js';
import {npmCommand} from '../src/npm-command.mjs';
import {runLiveCommand} from './live-process-support.js';
const exec=promisify(execFile);
