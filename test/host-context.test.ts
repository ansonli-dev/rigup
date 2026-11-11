import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {project} from './helpers.js';
import {scanRepository,repositoryReader} from '../src/analyzer/repository.js';
import {hostBackend} from '../src/analyzer/host.js';
import type {ResearchRequest,RepositoryReader} from '../src/analyzer/backend.js';

const locks=['bun.lock','bun.lockb','npm-shrinkwrap.json','package-lock.json','pnpm-lock.yaml','yarn.lock'];
async function fixture(fn:(root:string,cache:string,request:ResearchRequest,reader:RepositoryReader)=>Promise<void>){await project(async root=>project(async cache=>{
 await mkdir(root+'/src');await mkdir(root+'/docs');
 await writeFile(root+'/src/service.ts','export const projectBehavior = true;\n');
 await writeFile(root+'/package.json',JSON.stringify({dependencies:{react:'^18.3.1'}}));
 await writeFile(root+'/docs/yarn.lock.md','Handwritten project guidance must remain visible.\n');
 for(const name of locks)await writeFile(root+'/'+name,'LOCK_BODY_MUST_NOT_BE_SENT '+name+'\n');
 const options={agents:['codex' as const],backend:'codex' as const};const profile=await scanRepository(root,options);
 const request:ResearchRequest={kind:'analyze',runId:'context-fixture',root,fingerprint:profile.fingerprint,options,versions:{prompt:'4',read:'4'},budget:{maxCalls:12,maxTokens:1200000},previousInventoryDigest:'none',templateSourcesDigest:'none'};
 await fn(root,cache,request,await repositoryReader(root,options));
}));}
async function exported(cache:string,request:ResearchRequest,reader:RepositoryReader,omitDependencyLocks=false){
 const result=await hostBackend({cacheRoot:cache,omitDependencyLocks}).run(request,reader);
 assert.equal(result.status,'pending-host');if(result.status!=='pending-host')throw Error('expected pending export');
 return {result,body:JSON.parse(await readFile(result.requestPath,'utf8'))};
}
test('dependency context omits lock bodies even when an older complete snapshot exists',()=>fixture(async(_root,cache,request,reader)=>{
 const full=await exported(cache,{...request,runId:'manual-context'},reader);
 assert.match(JSON.stringify(full.body),/LOCK_BODY_MUST_NOT_BE_SENT/);
 assert.equal(full.body.omittedEvidence,undefined,'manual host exchange keeps its existing default');
 const slim=await exported(cache,request,reader,true);
 assert.equal(JSON.stringify(slim.body).includes('LOCK_BODY_MUST_NOT_BE_SENT'),false);
 assert.deepEqual(slim.body.paths.filter((p:string)=>locks.includes(p)).sort(),locks);
 assert.deepEqual(slim.body.omittedEvidence.map((o:any)=>o.path).sort(),locks);
 assert.ok(slim.body.omittedEvidence.every((o:any)=>typeof o.reason==='string'&&o.reason.length));
 assert.deepEqual(slim.body.evidence.map((e:any)=>e.evidence.path).sort(),['docs/yarn.lock.md','package.json','src/service.ts']);
 assert.match(JSON.stringify(slim.body.evidence),/Handwritten project guidance/);
 assert.match(JSON.stringify(slim.body.evidence),/18\.3\.1/);
}));
test('dependency context is used for analysis planning content and acceptance',()=>fixture(async(_root,cache,request,reader)=>{
 const phases:Partial<ResearchRequest>[]=[{}, {kind:'artifact-plan',expectedOutput:'plan'}, {kind:'artifact-content',expectedOutput:'content'}, {kind:'artifact-content',expectedOutput:'acceptance'}];
 for(const phase of phases){const item=await exported(cache,{...request,...phase},reader,true);assert.equal(JSON.stringify(item.body).includes('LOCK_BODY_MUST_NOT_BE_SENT'),false);assert.ok(item.body.evidence.some((e:any)=>e.evidence.path==='src/service.ts'));}
}));
test('an evidence policy cannot import a response from a different export policy',()=>fixture(async(_root,cache,request,reader)=>{
 const full=await exported(cache+'/full',request,reader),slim=await exported(cache+'/slim',request,reader,true);
 assert.notEqual(full.result.requestId,slim.result.requestId);
 const spoofed={...request,evidencePolicy:'dependency-manifests-v1'};assert.equal((await exported(cache+'/spoofed',spoofed,reader)).result.requestId,full.result.requestId);
 const responsePath=cache+'/response.json';await writeFile(responsePath,JSON.stringify({requestId:full.result.requestId,requestDigest:full.body.requestDigest,model:'fixture',data:{observations:[],unknowns:[]}}),{mode:0o600});
 await assert.rejects(()=>hostBackend({cacheRoot:cache+'/slim',omitDependencyLocks:true,responsePath}).run(request,reader),/digest|context|request/);
}));
test('tampered omission metadata cannot be accepted as the approved context',()=>fixture(async(_root,cache,request,reader)=>{
 const item=await exported(cache,request,reader,true);item.body.omittedEvidence=[{path:'yarn.lock',reason:'unapproved metadata'}];
 await writeFile(item.result.requestPath,JSON.stringify(item.body));
 const responsePath=cache+'/response.json';await writeFile(responsePath,JSON.stringify({requestId:item.result.requestId,requestDigest:item.body.requestDigest,model:'fixture',data:{observations:[],unknowns:[]}}),{mode:0o600});
 await assert.rejects(()=>hostBackend({cacheRoot:cache,omitDependencyLocks:true,responsePath}).run(request,reader),/context|policy|omission|evidence/);
}));
test('accepted dependency context can be reused without another request',()=>fixture(async(_root,cache,request,reader)=>{
 const item=await exported(cache,request,reader,true),responsePath=cache+'/response.json';
 await writeFile(responsePath,JSON.stringify({requestId:item.result.requestId,requestDigest:item.body.requestDigest,model:'fixture',data:{observations:[],unknowns:['Locked dependency versions were not supplied']}}),{mode:0o600});
 assert.equal((await hostBackend({cacheRoot:cache,omitDependencyLocks:true,responsePath}).run(request,reader)).status,'complete');
 const reused=await hostBackend({cacheRoot:cache,omitDependencyLocks:true}).run(request,reader);assert.equal(reused.status,'complete');
 if(reused.status==='complete')assert.ok(reused.value.unknowns.includes('Locked dependency versions were not supplied'));
}));
test('omitting dependency bodies does not hide lock changes from the source fingerprint',()=>fixture(async(root,_cache,request)=>{
 await writeFile(root+'/yarn.lock','Changed dependency resolution\n');
 const changed=await scanRepository(root,request.options as any);assert.notEqual(changed.fingerprint,request.fingerprint);assert.ok(changed.files.includes('yarn.lock'));
}));

test('harness host exports scoped authority and rejects an omitted body',()=>fixture(async(root,cache,request)=>{
 const {confirmedHarnessSource}=await import('./helpers.js');
 const options={agents:['codex' as const],backend:'host' as const,projectRules:true};
 const authority=await confirmedHarnessSource(root,options);
 const current={...request,options,fingerprint:authority.profile.fingerprint,sourceGuidance:authority.sourceGuidance};
 const item=await exported(cache,current,authority.reader);
 assert.deepEqual(item.body.context.sourceGuidance,authority.sourceGuidance);
 assert.ok(item.body.evidence.some((e:any)=>e.evidence.path===authority.path&&e.content.includes(authority.body)));
 const plan={...current,kind:'artifact-plan' as const,expectedOutput:'plan' as const,sourceGuidance:undefined,runId:'omitted-source'};
 const backend=hostBackend({cacheRoot:cache,stageEvidence:true});
 const omitted=await backend.run(plan,authority.reader);
 if(omitted.status!=='pending-host')throw Error('expected pending');
 const requestFile=JSON.parse(await readFile(omitted.requestPath,'utf8'));
 assert.equal(requestFile.evidence.some((item:any)=>item.evidence.path===authority.path),false);
 const responsePath=cache+'/response.json';
 await writeFile(responsePath,JSON.stringify({requestId:omitted.requestId,requestDigest:requestFile.requestDigest,model:'fixture',
  data:{observations:[],unknowns:[],guidance:authority.sourceGuidance},
 }));
 await assert.rejects(hostBackend({cacheRoot:cache,stageEvidence:true,responsePath}).run(plan,authority.reader),/scoped source body was not exported/);
}));

test('harness does not reset the budget of an older research run on resume',()=>fixture(async(root,cache)=>{
 const {executeLifecycle}=await import('../src/lifecycle.js');
 const {readdir,rename}=await import('node:fs/promises');
 const settings={agents:['codex' as const],backend:'host' as const,projectRules:true};
 const stateRoot=cache+'/state',cacheRoot=cache+'/cache';
 let requests=0;
 const backend:import('../src/analyzer/backend.js').AnalysisBackend={run:async request=>{
  requests++;
  if(request.kind==='analyze')return {status:'complete',value:{model:'fixture',usage:{calls:1,tokens:15},unknowns:[],data:{observations:[],unknowns:[]}}};
  return {status:'pending-host',requestId:'fixture',requestPath:cacheRoot+'/host/plan.request.json',nextCommand:'resume'};
 }};
 const services={backend,stateRoot,cacheRoot};
 assert.equal(await executeLifecycle(root,settings,{review:true},()=>{},services),3);
 assert.equal(requests,2);
 const directory=stateRoot+'/runs';
 const run=(await readdir(directory)).find(file=>/^[a-f0-9]{64}\.json$/.test(file))!;
 const record=JSON.parse(await readFile(directory+'/'+run,'utf8'));
 assert.deepEqual(record.spent,{calls:1,tokens:15});
 const older='f'.repeat(64);
 await rename(directory+'/'+run,directory+'/'+older+'.json');
 record.consent=older;
 record.versions={...record.versions,prompt:'11',template:'7'};
 const original=JSON.stringify(record);
 await writeFile(directory+'/'+older+'.json',original);
 await assert.rejects(executeLifecycle(root,settings,{review:true,resume:true},()=>{},services),/earlier evidence contract/);
 assert.equal(requests,2);
 assert.equal(await readFile(directory+'/'+older+'.json','utf8'),original);
}));
