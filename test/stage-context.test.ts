import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {project} from './helpers.js';
import {repositoryReader,scanRepository} from '../src/analyzer/repository.js';
import {hostBackend} from '../src/analyzer/host.js';
import {STAGE_EVIDENCE_POLICY} from '../src/analyzer/stage-context.js';
import {signature} from '../src/generator/cache.js';
import type {ResearchRequest,RepositoryReader} from '../src/analyzer/backend.js';

async function fixture(fn:(f:any)=>Promise<void>){await project(async root=>project(async cache=>{
 const files:Record<string,string>={
  'AGENTS.md':'Explicit authority: preserve import rules.\n',
  'package.json':'{"scripts":{"build":"tsc"}}\n',
  'docs/api.md':'NOT_NEEDED_FIRST_LINE\nAPI declarations\nRefresh gap\nNOT_NEEDED_LAST_LINE\n',
  'docs/other.md':'UNRELATED_GUIDANCE_BODY\n',
  'docs/conflict.md':'Unresolved authority conflict for src/a.\n',
  'src/a/update.ts':'OUTSIDE_NEEDED_RANGE\nexport const mutation = "checked update";\nOUTSIDE_NEEDED_RANGE\n',
  'src/a/helper.ts':'export const helper = "CURRENT_SEED_HELPER";\n',
  'src/b/counter.ts':'export const counterexample = "DISTINCT_REFRESH_COUNTEREXAMPLE";\n',
  'src/z/unrelated.ts':'UNRELATED_PROJECT_BODY\n',
  'src/z/linked.ts':'LINKED_ACCEPTANCE_SOURCE\n',
  '.agents/skills/openspec-apply-change/SKILL.md':'Preserve native blocked states and human approval gates.\n',
  '.agents/skills/openspec-explore/SKILL.md':'EXPLORE_ONLY_UNRELATED_BODY\n',
  '.agents/skills/local-proposal/SKILL.md':'EXACT_RESOLVED_NATIVE_ENTRY\n',
  '.claude/skills/openspec-propose/SKILL.md':'UNSELECTED_HOST_NATIVE_BODY\n',
  'docs/long.md':Array.from({length:130},(_,i)=>'Project guidance line '+(i+1)).join('\n'),
  'yarn.lock':'LOCK_BODY_MUST_STAY_OMITTED\n',
  'docs/yarn.lock.md':'Handwritten lock explanation.\n',
 };
 for(const [path,body] of Object.entries(files)){await mkdir(root+'/'+path.slice(0,path.lastIndexOf('/')+1),{recursive:true});await writeFile(root+'/'+path,body);}
 const options={agents:['codex' as const],backend:'codex' as const,sdd:'openspec' as const};const profile=await scanRepository(root,options),reader=await repositoryReader(root,options);
 const ref=async(path:string,start=1,end?:number)=>(await reader.read(path,start,end)).evidence;
 const api=await ref('docs/api.md',2,3),update=await ref('src/a/update.ts',2,2),counter=await ref('src/b/counter.ts'),other=await ref('src/z/unrelated.ts'),conflict=await ref('docs/conflict.md'),gate=await ref('.agents/skills/openspec-apply-change/SKILL.md');
 const observation=(topic:string,source:any,extra:any={})=>({topic,statement:topic,classification:'local-pattern',scope:['src/a'],supportingEvidence:[source],counterEvidence:[],guidanceDisposition:'reference-only',...extra});
 const research={guidance:[{topic:'API',sourceRef:api,scope:['src/a'],coverageStatus:'partial',consumers:['API reviewers'],gaps:['refresh']},{topic:'Other',sourceRef:await ref('docs/other.md'),scope:['src/z'],coverageStatus:'reusable',consumers:['Other'],gaps:[]},{topic:'Conflict',sourceRef:conflict,scope:['src/a'],coverageStatus:'conflicting',consumers:['API reviewers'],gaps:['unresolved']}],observations:[observation('API',update,{gap:'refresh'}),observation('API',counter,{counterEvidence:[counter],exceptions:['A distinct local mechanism']}),observation('Other',other,{scope:['src/z']}),observation('Conflict',conflict,{guidanceDisposition:'needs-decision'}),observation('Native gates',gate,{classification:'explicit-rule',scope:['openspec']})],unknowns:['Global uncertainty must remain visible.']};
 const job={logicalId:'api',target:'docs/rigup/api.md',purpose:'Review API refresh',consumer:'API reviewers',required:true,reason:'Missing refresh rationale',sourceRefs:[api,update],seedPaths:['src/a/helper.ts'],relatedArtifacts:[],acceptance:['Preserve counterexamples, unknowns, native gates and authority.'],status:'pending'};
 const request:ResearchRequest={kind:'analyze',runId:'stage-fixture',root,fingerprint:profile.fingerprint,options,versions:{prompt:'4',read:'4'},budget:{maxCalls:12,maxTokens:1200000},previousInventoryDigest:'none',templateSourcesDigest:'none'};
 const phase=(expectedOutput:string,changes:any={})=>({...request,kind:expectedOutput==='plan'?'artifact-plan':'artifact-content',expectedOutput,artifact:expectedOutput==='plan'?undefined:job.logicalId,input:expectedOutput==='plan'?{allowedRoots:['docs/rigup'],profile:{files:profile.files,commands:profile.commands,research:{data:research,model:'verified',unknowns:research.unknowns,usage:{calls:1,tokens:18}},unknowns:[]},previousInventory:[{logicalId:'old',authority:'previous-generated-output-only',baselineContent:'COMPARISON_ONLY'}],inventoryPolicy:'Comparison only'}:{job,research:{...research,artifacts:[job],dispositions:[]},...(expectedOutput==='acceptance'?{candidate:'A checked review aid.'}:{})},...changes}) as ResearchRequest;
 await fn({root,cache,reader,request,phase,research,job,ref,profile});
}));}
async function exported(f:any,request:ResearchRequest,cache=f.cache){
 const result=await hostBackend({cacheRoot:cache,stageEvidence:true,nativeEntryPaths:['.agents/skills/local-proposal/SKILL.md','.agents/skills/openspec-apply-change/SKILL.md']}).run(request,f.reader);assert.equal(result.status,'pending-host');if(result.status!=='pending-host')throw Error('expected pending export');
 return {result,body:JSON.parse(await readFile(result.requestPath,'utf8'))};
}
const evidencePaths=(body:any)=>[...new Set<string>(body.evidence.map((e:any)=>e.evidence.path))];

test('stage analysis retains its bounded non-lock scan and full inventory',()=>fixture(async f=>{
 const {body}=await exported(f,f.request);assert.equal(body.context.evidencePolicy,STAGE_EVIDENCE_POLICY);
 assert.ok(body.paths.includes('yarn.lock'));assert.ok(evidencePaths(body).includes('src/z/unrelated.ts'));assert.ok(evidencePaths(body).includes('docs/yarn.lock.md'));
 assert.doesNotMatch(JSON.stringify(body.evidence),/LOCK_BODY_MUST_STAY_OMITTED/);
}));
test('analysis exposes verified slices of long sources for later citation',()=>fixture(async f=>{
 const {body}=await exported(f,f.request);
 const chunks=body.evidence.filter((item:any)=>item.evidence.path==='docs/long.md');
 assert.ok(chunks.length>1);
 for(const item of chunks)assert.deepEqual(item,await f.reader.read(item.evidence.path,item.evidence.startLine,item.evidence.endLine));
 assert.equal(chunks[0].evidence.startLine,1);
 assert.equal(chunks.at(-1).evidence.endLine,130);
 for(let index=1;index<chunks.length;index++)assert.equal(chunks[index].evidence.startLine,chunks[index-1].evidence.endLine+1);
}));
test('planning sends cited ranges and guardrails without unrelated project bodies or duplicate inventory',()=>fixture(async f=>{
 const {body}=await exported(f,f.phase('plan'));assert.ok(!evidencePaths(body).includes('src/z/linked.ts'));assert.ok(!evidencePaths(body).includes('docs/yarn.lock.md'));
 assert.doesNotMatch(JSON.stringify(body.evidence),/NOT_NEEDED_FIRST_LINE|NOT_NEEDED_LAST_LINE|OUTSIDE_NEEDED_RANGE/);
 assert.ok(body.evidence.some((e:any)=>e.evidence.path==='docs/api.md'&&e.evidence.startLine===2&&e.evidence.endLine===3));
 assert.ok(evidencePaths(body).includes('.agents/skills/openspec-apply-change/SKILL.md'));assert.ok(evidencePaths(body).includes('AGENTS.md'));
 assert.match(JSON.stringify(body.evidence),/EXACT_RESOLVED_NATIVE_ENTRY/);
 assert.doesNotMatch(JSON.stringify(body.evidence),/EXPLORE_ONLY_UNRELATED_BODY|UNSELECTED_HOST_NATIVE_BODY/);
 assert.equal(body.context.input.profile.files,undefined);assert.match(JSON.stringify(body.context.input.previousInventory),/COMPARISON_ONLY/);assert.equal(body.paths.length,f.profile.files.length);
}));
test('planning projects the analysis contract without replaying unrelated backend payload fields',()=>fixture(async f=>{
 const request=f.phase('plan');const input=request.input as any;input.profile.research.rawContext='WHOLE_PROJECT_DUMP';input.profile.research.data.rawContext='WHOLE_PROJECT_DUMP';
 const {body}=await exported(f,request);assert.doesNotMatch(JSON.stringify(body.context.input),/WHOLE_PROJECT_DUMP/);assert.ok(body.context.input.profile.research.data.observations.length);
}));
test('content keeps current-topic counterexamples conflicts and native gates while excluding unrelated research',()=>fixture(async f=>{
 const {body}=await exported(f,f.phase('content'));const paths=evidencePaths(body);
 for(const path of ['src/a/helper.ts','src/a/update.ts','src/b/counter.ts','docs/conflict.md','AGENTS.md','.agents/skills/openspec-apply-change/SKILL.md'])assert.ok(paths.includes(path),path);
 assert.ok(!paths.includes('src/z/unrelated.ts'));assert.ok(!paths.includes('docs/other.md'));assert.doesNotMatch(JSON.stringify(body.context.input),/UNRELATED|"topic":"Other"/);
 assert.doesNotMatch(JSON.stringify(body.evidence),/EXPLORE_ONLY_UNRELATED_BODY/);
 assert.ok(body.context.input.research.observations.some((o:any)=>o.counterEvidence.length));assert.ok(body.context.input.research.guidance.some((g:any)=>g.coverageStatus==='conflicting'));
 assert.ok(body.context.input.research.unknowns.includes('Global uncertainty must remain visible.'));assert.ok(body.omittedEvidence.some((o:any)=>o.path==='src/z/unrelated.ts'));
}));
test('related artifact cycles retain only the connected jobs and their evidence',()=>fixture(async f=>{
 const related={...f.job,logicalId:'related',target:'docs/rigup/related.md',sourceRefs:[await f.ref('src/b/counter.ts')],seedPaths:[],relatedArtifacts:['api']},job={...f.job,relatedArtifacts:['related']},other={...f.job,logicalId:'unrelated',target:'docs/rigup/unrelated.md',sourceRefs:[await f.ref('src/z/unrelated.ts')],seedPaths:[],relatedArtifacts:[]};
 const {body}=await exported(f,f.phase('content',{input:{job,research:{...f.research,artifacts:[job,related,other]}}}));
 assert.deepEqual(body.context.input.research.artifacts.map((j:any)=>j.logicalId).sort(),['api','related']);assert.ok(!evidencePaths(body).includes('src/z/unrelated.ts'));
}));
test('acceptance adds candidate-linked sources beyond seeds but never follows outside the inventory',()=>fixture(async f=>{
 const {body}=await exported(f,f.phase('acceptance',{input:{job:f.job,research:{...f.research,artifacts:[f.job]},candidate:'[Checked](../../src/z/linked.ts) [outside](../../../../outside.md)'}}));
 assert.ok(evidencePaths(body).includes('src/z/linked.ts'));assert.ok(!evidencePaths(body).some(p=>p.includes('outside.md')));assert.ok(body.context.evidenceSelection.unavailable.some((s:string)=>s.includes('outside.md')));
}));
test('rulebook acceptance keeps exact source ranges even when the candidate links to them',()=>fixture(async f=>{
 const update=await f.ref('src/a/update.ts',2,2);
 const job={...f.job,sourceRefs:[update],ruleSources:[{supportingEvidence:[update]}],seedPaths:[]};
 const {body}=await exported(f,f.phase('acceptance',{input:{job,research:{...f.research,artifacts:[job]},candidate:'[Source](../../src/a/update.ts#L2-L2)'}}));
 assert.ok(body.evidence.some((e:any)=>e.evidence.path===update.path&&e.evidence.digest===update.digest));
 assert.doesNotMatch(JSON.stringify(body.evidence),/OUTSIDE_NEEDED_RANGE/);
}));
test('topic collection acceptance keeps rendered pages and resolves their links from the page directory',()=>fixture(async f=>{
 const update=await f.ref('src/a/update.ts',2,2);
 const page={target:'docs/rigup/api/mutations.md',content:'[Source](../../../src/a/update.ts#L2-L2)'};
 const job={...f.job,sourceRefs:[update],ruleSources:[{supportingEvidence:[update]}],ruleTopics:[{id:'mutations',target:page.target}],seedPaths:[]};
 const {body}=await exported(f,f.phase('acceptance',{input:{job,research:{guidance:[],observations:[],unknowns:[]},candidate:'[Mutations](api/mutations.md)',candidatePages:[page]}}));
 assert.deepEqual(body.context.input.candidatePages,[page]);
 assert.ok(body.evidence.some((e:any)=>e.evidence.path===update.path&&e.evidence.digest===update.digest));
 assert.doesNotMatch(JSON.stringify(body.evidence),/OUTSIDE_NEEDED_RANGE|UNRELATED_PROJECT_BODY/);
 assert.deepEqual(body.context.evidenceSelection.unavailable,[]);
}));
test('missing seeds and omitted lock evidence are explicit and do not trigger a full-project fallback',()=>fixture(async f=>{
 const lock=await f.ref('yarn.lock'),job={...f.job,sourceRefs:[...f.job.sourceRefs,lock],seedPaths:['src/missing.ts','yarn.lock']};const readPaths:string[]=[];const original=f.reader;f.reader={...original,read:async(...args:Parameters<RepositoryReader['read']>)=>{readPaths.push(args[0]);return original.read(...args);}};
 const {body}=await exported(f,f.phase('content',{input:{job,research:{...f.research,artifacts:[job]}}}));assert.ok(!readPaths.includes('yarn.lock'));assert.ok(body.context.evidenceSelection.unavailable.some((s:string)=>s.includes('src/missing.ts')));assert.ok(body.context.evidenceSelection.unavailable.some((s:string)=>s.includes('yarn.lock')));assert.ok(!evidencePaths(body).includes('src/z/unrelated.ts'));
}));
test('stage selection rejects fabricated ranges digests and references outside the allowed reader',()=>fixture(async f=>{
 for(const bad of [{path:'../outside.md',startLine:1,endLine:1,digest:'a'.repeat(64)},{path:'docs/api.md',startLine:2,endLine:3,digest:'0'.repeat(64)},{path:'docs/api.md',startLine:1,endLine:9999,digest:'0'.repeat(64)}]){
  const job={...f.job,sourceRefs:[bad]};await assert.rejects(()=>exported(f,f.phase('content',{input:{job,research:{observations:[],guidance:[],unknowns:[],artifacts:[job]}}}),f.cache+'/'+signature(bad)),/range|evidence|inventory|path|digest/i);
 }
}));
test('stage-only context changes preserve one run budget and incompatible policies cannot share acceptance',()=>fixture(async f=>{
 for(const request of [f.request,f.phase('plan'),f.phase('content'),f.phase('acceptance')])await exported(f,request);
 const request=f.phase('content'),legacy=await hostBackend({cacheRoot:f.cache+'/legacy',omitDependencyLocks:true}).run(request,f.reader);assert.equal(legacy.status,'pending-host');if(legacy.status!=='pending-host')throw Error('expected legacy');
 const current=await exported(f,request,f.cache+'/current');assert.notEqual(legacy.requestId,current.result.requestId);
}));
test('projected-away inputs still bind identity through their original digest',()=>fixture(async f=>{
 const request=f.phase('content'),first=await exported(f,request,f.cache+'/first');const research={...f.research,observations:f.research.observations.map((o:any)=>o.topic==='Other'?{...o,statement:'Different irrelevant conclusion'}:o),artifacts:[f.job]};
 const next=await exported(f,f.phase('content',{input:{job:f.job,research}}),f.cache+'/next');
 assert.notEqual(first.result.requestId,next.result.requestId);assert.notEqual(first.body.context.inputDigest,next.body.context.inputDigest);assert.ok(first.body.context.inputDigest);
}));
test('tampering selection or adding even self-digested unselected evidence cannot be accepted',()=>fixture(async f=>{
 const request=f.phase('content'),{body,result}=await exported(f,request);body.evidence.push(await f.reader.read('src/z/unrelated.ts',1));body.evidenceDigest=signature(body.evidence);await writeFile(result.requestPath,JSON.stringify(body));
 const responsePath=f.cache+'/response.json';await writeFile(responsePath,JSON.stringify({requestId:result.requestId,requestDigest:body.requestDigest,model:'fixture',data:{observations:[],unknowns:[]}}),{mode:0o600});
 await assert.rejects(()=>hostBackend({cacheRoot:f.cache,stageEvidence:true,responsePath}).run(request,f.reader),/evidence|selection|context|policy/i);
}));
test('unselected source changes still invalidate the full source fingerprint',()=>fixture(async f=>{
 const first=await exported(f,f.phase('content'),f.cache+'/first');await writeFile(f.root+'/src/z/unrelated.ts','Changed but still not task evidence.\n');const changed=await scanRepository(f.root,f.request.options);
 const next=await exported(f,{...f.phase('content'),fingerprint:changed.fingerprint},f.cache+'/next');assert.notEqual(first.result.requestId,next.result.requestId);assert.ok(!evidencePaths(next.body).includes('src/z/unrelated.ts'));
}));
test('invalid or missing stage output cannot fall back to exporting the whole project',()=>fixture(async f=>{
 for(const [kind,expectedOutput] of [['artifact-plan',undefined],['artifact-content',undefined],['artifact-content','plan'],['artifact-plan','content'],['analyze','content']] as const){
  await assert.rejects(()=>exported(f,{...f.phase('content'),kind,expectedOutput}),/stage|output|kind/i);
 }
}));
test('missing topic labels do not group unrelated records or discard scoped counterexamples',()=>fixture(async f=>{
 const observations=f.research.observations.map(({topic,...rest}:any)=>rest),research={...f.research,observations};
 const {body}=await exported(f,f.phase('content',{input:{job:f.job,research:{...research,artifacts:[f.job]}}}));
 assert.ok(!evidencePaths(body).includes('src/z/unrelated.ts'));assert.ok(evidencePaths(body).includes('src/b/counter.ts'));assert.ok(body.context.evidenceSelection.unavailable.some((s:string)=>s.includes('topic')));
}));
test('root and output-target scopes preserve explicit rules and unavailable guidance in both artifact stages',()=>fixture(async f=>{
 await writeFile(f.root+'/docs/policy.md','Policy\nRequired independent review.\n');f.reader=await repositoryReader(f.root,f.request.options);const ref=(await f.reader.read('docs/policy.md',1)).evidence;
 for(const stage of ['content','acceptance'])for(const scope of ['.','docs/rigup']){
  const observation={topic:'Applicable policy',statement:'Required review',classification:'explicit-rule',scope:[scope],supportingEvidence:[ref],counterEvidence:[],guidanceDisposition:'follow-existing'};
  const research={guidance:[{topic:'Unavailable authority',scope:[scope],coverageStatus:'unavailable',consumers:['reviewer'],gaps:['source missing']}],observations:[observation],unknowns:[],artifacts:[f.job]};
  const {body}=await exported(f,f.phase(stage,{input:{job:f.job,research,candidate:'Review'}}),f.cache+'/'+stage+'-'+signature(scope));
  assert.ok(evidencePaths(body).includes('docs/policy.md'));assert.equal(body.context.input.research.observations.length,1);assert.equal(body.context.input.research.guidance.length,1);
 }
}));
test('scope-applicable reusable and partial guidance need no duplicate observation or job reference',()=>fixture(async f=>{
 await writeFile(f.root+'/docs/policy.md','Before\nExisting authority\nScoped requirement\nAfter\n');f.reader=await repositoryReader(f.root,f.request.options);const ref=(await f.reader.read('docs/policy.md',2,3)).evidence;
 for(const stage of ['content','acceptance'])for(const status of ['reusable','partial']){
  const guidance={topic:'Existing API authority',sourceRef:ref,scope:['src/a'],coverageStatus:status,consumers:['API reviewer'],gaps:status==='partial'?['bounded gap']:[]};
  const {body}=await exported(f,f.phase(stage,{input:{job:f.job,research:{guidance:[guidance],observations:[],unknowns:[],artifacts:[f.job]},candidate:'Review'}}),f.cache+'/'+stage+'-'+status);
  assert.equal(body.context.input.research.guidance.length,1);assert.ok(body.evidence.some((e:any)=>e.evidence.path===ref.path&&e.evidence.digest===ref.digest));
 }
}));
test('authority scopes normalize directory paths and disclose unresolved scope instead of dropping its source',()=>fixture(async f=>{
 await writeFile(f.root+'/docs/policy.md','Authority needs scope review.\n');f.reader=await repositoryReader(f.root,f.request.options);const ref=(await f.reader.read('docs/policy.md',1)).evidence;
 for(const scope of ['src/a/','./','API contributors']){
  const guidance={topic:'Scoped authority',sourceRef:ref,scope:[scope],coverageStatus:'reusable',consumers:['API reviewer'],gaps:[]};
  const {body}=await exported(f,f.phase('content',{input:{job:f.job,research:{guidance:[guidance],observations:[],unknowns:[],artifacts:[f.job]}}}),f.cache+'/'+signature(scope));assert.ok(evidencePaths(body).includes('docs/policy.md'));
  if(scope==='API contributors')assert.ok(body.context.evidenceSelection.unavailable.some((s:string)=>s.includes('scope')));
 }
}));
