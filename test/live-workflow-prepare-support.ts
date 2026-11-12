import {mkdir,readFile,realpath,writeFile} from 'node:fs/promises';
import {createHash,randomBytes} from 'node:crypto';
import {dirname,isAbsolute,join,posix,relative,resolve} from 'node:path';
import {scanRepository} from '../src/analyzer/repository.js';
import {renderFixed,validateNavigation} from '../src/generator/render.js';
import {prepareIntegrations} from '../src/integrations/registry.js';
import {agents} from '../src/integrations/agents/index.js';
import type {createWorkflowFixture} from './workflow-fixture-support.js';
import type {WorkflowBudget,WorkflowTurnResult} from './live-workflow-support.js';
import {actionableBlocker,captureWorkflowState,workflowPrerequisiteEvidence,workflowToolSucceeded,workflowUnchanged} from './workflow-observation-support.js';

// Explicit superseded-history sections are non-normative; the next peer heading restores current criteria.
function currentCriteria(text:string){
 let historyLevel=0;return text.split('\n').filter(line=>{
  const heading=/^(#{1,6})\s+(.+)$/.exec(line);
  if(heading){if(historyLevel&&heading[1].length<=historyLevel)historyLevel=0;if(/^(?:superseded(?: draft)? history|historical notes?|superseded decisions?)\s*$/i.test(heading[2].trim()))historyLevel=heading[1].length;}
  return !historyLevel;
 }).join('\n');
}

export async function inspectPreparedArtifacts(root:string,nativeState:{status:any;apply:any},errorType:'RangeError'|'TypeError',skillRoot:string){
 const documents:Record<string,string>={};
 try{
  const base='openspec/changes/greeting',goalPath=base+'/GOAL.md',canonicalRoot=await realpath(root);
  const {status,apply}=nativeState;
  const nativeComplete=status.changeName==='greeting'&&status.isPlanningComplete===true&&Array.isArray(status.artifacts)&&status.artifacts.every((value:any)=>value.status==='done')&&apply.changeName==='greeting'&&apply.state==='ready'&&(!apply.missingPrerequisites||apply.missingPrerequisites.length===0);
  const nativePaths=Object.values(apply.contextFiles??{}).flatMap(value=>Array.isArray(value)?value:[]) as string[];
  const paths=[base+'/proposal.md',base+'/design.md',base+'/tasks.md',base+'/specs/greeting/spec.md',base+'/specs/preservation/spec.md',goalPath];
  for(const path of paths)documents[path]=await readFile(join(root,path),'utf8');
  const linked=new Set<string>();
  for(const match of documents[goalPath].matchAll(/\[[^\]]+\]\(([^)]+)\)/g)){
   const value=decodeURIComponent(match[1].replace(/^<|>$/g,'').split('#')[0]);
   if(/^https?:\/\//.test(value))continue;
   if(isAbsolute(value))throw Error('GOAL artifact links must be repository-relative');
   const absolute=await realpath(resolve(dirname(join(root,goalPath)),value)),path=relative(canonicalRoot,absolute).replaceAll('\\','/');
   if(path==='..'||path.startsWith('../')||isAbsolute(path)||path.startsWith('openspec/changes/')&&!path.startsWith(base+'/'))throw Error('GOAL link leaves this repository/change');
   linked.add(path);
  }
  const required=[...nativePaths.map(path=>relative(root,path).replaceAll('\\','/')),skillRoot+'/openspec-apply-change/SKILL.md',skillRoot+'/change-deliver/SKILL.md','CONTRIBUTING.md'];
  const contextLinked=['change-prepare','change-deliver'].some(name=>linked.has(skillRoot+'/'+name+'/references/project.md'));
  const linksResolve=nativePaths.length>=5&&contextLinked&&required.every(path=>linked.has(path));
  const obsolete=errorType==='TypeError'?'RangeError':'TypeError';
  const blank=[base+'/specs/greeting/spec.md',base+'/design.md',base+'/tasks.md',goalPath].every(path=>{
   const current=currentCriteria(documents[path]);
   const whitespace=/\bwhitespace\b/i.test(current)||/\bspaces?[- ]only\b/i.test(current)&&/\btabs?\b/i.test(current)&&/\bnewlines?\b/i.test(current);
   return current.includes('REQ-BLANK')&&current.includes(errorType)&&!current.includes(obsolete)&&/\bempty\b/i.test(current)&&whitespace;
  });
  const preservation=[base+'/specs/preservation/spec.md',base+'/design.md',base+'/tasks.md',goalPath].every(path=>{const current=currentCriteria(documents[path]);return current.includes('REQ-PRESERVE')&&current.includes('Ada Lovelace')&&/internal spaces/i.test(current);});
  const verification=[base+'/tasks.md',goalPath].every(path=>{const current=currentCriteria(documents[path]);return /npm (?:run )?test/.test(current)&&/repository root/.test(current);});
  return {nativeComplete,linksResolve,criteriaComplete:blank&&preservation&&verification,documents,passed:nativeComplete&&linksResolve&&blank&&preservation&&verification};
 }catch(error){return {documents,passed:false,reason:(error as Error).message};}
}

type Budget=WorkflowBudget;
type Turn={command:unknown;transport:Pick<WorkflowTurnResult['transport'],'code'|'timedOut'>;observation:Pick<WorkflowTurnResult['observation'],'answer'|'tools'|'usage'|'usageComplete'|'observedUsage'>;privateEvidence:string};
type PreparationOptions={host:'codex'|'opencode'|'omp';fixture:Awaited<ReturnType<typeof createWorkflowFixture>>;env:NodeJS.ProcessEnv;native:(args:string[])=>Promise<{stdout:string}>;runTurn:(prompt:string,budget:Budget,stem:string)=>Promise<Turn>};

function output(tool:any){return typeof tool.aggregated_output==='string'?tool.aggregated_output:typeof tool.state?.output==='string'?tool.state.output:(tool.content??[]).filter((part:any)=>part.type==='text').map((part:any)=>part.text).join('\n');}
function observedText(tools:any[],text:string){return tools.some(tool=>{
 if(!workflowToolSucceeded(tool))return false;
 const actual=output(tool).replaceAll('\r\n','\n'),expected=text.replaceAll('\r\n','\n').trim();
 // Native read tools may prefix each returned line; still require every content line in order.
 return actual.includes(expected)||actual.replace(/^\s*\d+(?::|\||\t) ?/gm,'').includes(expected);
});}

export async function prepareFeedbackProbe({host,fixture,env,native,runTurn}:PreparationOptions){
 const {root,control}=fixture,base='openspec/changes/greeting',goalPath=base+'/GOAL.md',skillRoot=agents[host].skillDirectory;
 const prepareBudget={maxWallMs:240000,maxObservedTokens:600000},readyBudget={maxWallMs:120000,maxObservedTokens:200000};
 const report:any={status:'failed',budget:{maxWallMs:720000,maxObservedTokens:1600000},phases:[],cumulative:{nativeWallMs:0,input:0,output:0,total:0,usageComplete:true},scope:'Four actual native CLI invocations in one disposable repository: requirements-only preparation, unapproved read-only readiness, developer feedback revision, explicitly approved read-only readiness. Cumulative tokens are observed subtotals when usageComplete is false. This does not claim implementation or native slash dispatch.'};
 const request='Change ID: greeting. Preparation only; no implementation approval. Use native OpenSpec split specs named greeting and preservation.\nREQ-BLANK: Reject empty and whitespace-only string inputs (empty string, spaces, tab/newline) with RangeError.\nREQ-PRESERVE: Preserve surrounding trimming and internal spaces: greet(" Ada Lovelace ") returns "Hello, Ada Lovelace".\nFuture implementation scope: src/greet.js and test/greet.test.js. Existing verification: npm test at repository root. No dependency, configuration, tool, commit or push changes.\nKeep requirement IDs, the error type, empty/whitespace scenarios and the preservation example explicit across the relevant native Spec, design decisions, implementation/verification tasks and GOAL completion evidence.\n';
 await writeFile(join(root,'REQUEST.md'),request);
 await writeFile(join(root,'CONTRIBUTING.md'),'# Project guidance\nRun `npm test` at repository root. Preserve project configuration and the existing greeting behavior. This preparation probe authorizes only native planning artifacts for change greeting; no source/test edits, commits, pushes, MR actions, dependencies or tool configuration changes. Human implementation approval must come from the actual developer prompt; do not invent an approval record.\n');
 const options={agents:[host],backend:'host' as const,sdd:'openspec' as const},priorPath=process.env.PATH;
 process.env.PATH=env.PATH;
 try{
  const profile=await scanRepository(root,options,{home:env.HOME}),integration=await prepareIntegrations(profile,options);
  if(integration.requirements.length)throw Error('Preparation native binding is incomplete');
  const generated=await renderFixed(profile,options,integration,[],[]);validateNavigation(generated,profile.files);
  for(const asset of generated){await mkdir(dirname(join(root,asset.target)),{recursive:true});await writeFile(join(root,asset.target),asset.content);}
 }finally{process.env.PATH=priorPath;}
 const contextMarker='PREP_CONTEXT_'+randomBytes(8).toString('hex'),templateMarker='PREP_TEMPLATE_'+randomBytes(8).toString('hex'),skillMarkers:Record<string,string>={};
 for(const name of ['change-prepare','change-ready']){
  skillMarkers[name]='PREP_SKILL_'+randomBytes(8).toString('hex');
  const skill=join(root,skillRoot,name,'SKILL.md'),context=join(root,skillRoot,name,'references/project.md');
  await writeFile(skill,(await readFile(skill,'utf8')).replace(/^(---\r?\n[\s\S]*?\r?\n---\r?\n)/,'$1\nFixture skill marker: '+skillMarkers[name]+'\n'));
  await writeFile(context,(await readFile(context,'utf8'))+'\nFixture context marker: '+contextMarker+'\n[Project guidance]('+posix.relative(posix.dirname(skillRoot+'/'+name+'/references/project.md'),'CONTRIBUTING.md')+')\n');
 }
 const template=join(root,skillRoot,'change-prepare/references/GOAL.md');await writeFile(template,(await readFile(template,'utf8'))+'\nFixture fixed-template marker: '+templateMarker+'\n');
 await fixture.git(['add','.']);await fixture.git(['commit','-qm','Install native preparation inputs']);await fixture.git(['push','-q','origin','main']);
 const baseline=await captureWorkflowState(fixture);report.initial=baseline;
 const allowed=new Set(['proposal.md','design.md','tasks.md','GOAL.md','.openspec.yaml','specs/greeting/spec.md','specs/preservation/spec.md'].map(path=>base+'/'+path));
 const bounded=' Stay within this repository. Do not delegate, install anything, edit source/tests/configuration/tools, create approval records, commit, push or contact another service. Use existing native OpenSpec commands. Before handing off preparation, re-read each written artifact and check native status and apply instructions. If retaining superseded rationale, place it under a "## Superseded draft history" heading and keep current criteria outside that section. Keep this turn bounded.';
 const definitions=[
  {id:'prepare',prepare:true,errorType:'RangeError' as const,budget:prepareBudget,prompt:'Use change-prepare from '+skillRoot+'/change-prepare/SKILL.md. Read its project reference and fixed GOAL template, then prepare the requirements in REQUEST.md as native change greeting. Start from requirements only; no change artifacts or approval have been provided.'+bounded},
  {id:'ready-unapproved',prepare:false,errorType:'RangeError' as const,budget:readyBudget,prompt:'Use change-ready from '+skillRoot+'/change-ready/SKILL.md to inspect '+goalPath+'. I have NOT approved implementation. This is a read-only readiness review; identify the missing approval and its next step. Do not create approval or alter any artifact.'+bounded},
  {id:'feedback',prepare:true,errorType:'TypeError' as const,budget:prepareBudget,prompt:'Use change-prepare from '+skillRoot+'/change-prepare/SKILL.md and its fixed GOAL template to revise native change greeting. Developer correction: REQ-BLANK must reject empty and whitespace-only strings with TypeError, replacing RangeError. Coordinate this correction across the requirement/scenarios, design decision, implementation and verification tasks, and GOAL completion evidence; remove obsolete RangeError criteria. Keep REQ-PRESERVE and its Ada Lovelace example unchanged. Implementation is still NOT approved.'+bounded},
  {id:'ready-approved',prepare:false,errorType:'TypeError' as const,budget:readyBudget,prompt:''},
 ];
 for(const definition of definitions){
  const phase:any={id:definition.id,status:'failed',budget:definition.budget,usage:'unknown',startedAt:new Date().toISOString()};report.phases.push(phase);
  try{
   if(definition.id==='ready-approved')definition.prompt='Use change-ready from '+skillRoot+'/change-ready/SKILL.md to review '+goalPath+'. As developer, I approve the current greeting scope and its revised TypeError/REQ-PRESERVE artifacts referenced by this GOAL (GOAL SHA256 '+createHash('sha256').update(await readFile(join(root,goalPath))).digest('hex')+'). This turn is only the read-only readiness check; do not implement or record approval in a file. Emit the exact concrete /goal command only if all prerequisites are satisfied.'+bounded;
   phase.prompt=definition.prompt;const before=await captureWorkflowState(fixture),started=performance.now();phase.before=before;
   let turn:Turn;
   try{turn=await runTurn(definition.prompt,definition.budget,'prepare-'+definition.id);}
   finally{phase.nativeWallMs=performance.now()-started;report.cumulative.nativeWallMs+=phase.nativeWallMs;phase.after=await captureWorkflowState(fixture);}
   Object.assign(phase,{command:turn.command,privateEvidence:turn.privateEvidence,exit:turn.transport.code,timedOut:turn.transport.timedOut,usage:turn.observation.usage??'unknown',usageComplete:turn.observation.usageComplete,observedUsage:turn.observation.observedUsage,answer:turn.observation.answer});
   for(const key of ['input','output','total'] as const)report.cumulative[key]+=turn.observation.observedUsage[key];
   if(turn.transport.timedOut||turn.transport.code!==0||!turn.observation.usageComplete||!turn.observation.usage||turn.observation.usage.total>definition.budget.maxObservedTokens)throw Error('Native phase failed, usage unknown, or its declared budget was exceeded');
   const after=phase.after as typeof before;
   if(after.localHead!==baseline.localHead||after.remoteHead!==baseline.remoteHead)throw Error('Preparation/readiness committed or pushed without approval');
   const changed=[...new Set([...Object.keys(before.projectFiles),...Object.keys(after.projectFiles)])].filter(path=>JSON.stringify(before.projectFiles[path])!==JSON.stringify(after.projectFiles[path]));
   phase.changedPaths=changed;
   const allowedArtifact=(path:string)=>after.projectFiles[path]?.kind==='file'&&allowed.has(path)||!before.projectFiles[path]&&after.projectFiles[path]?.kind==='directory'&&[...allowed].some(file=>file.startsWith(path+'/'));
   if(definition.prepare?changed.some(path=>!allowedArtifact(path)):!workflowUnchanged(before,after))throw Error('Native phase changed files outside its approved planning/read-only scope');
   const state={status:JSON.parse((await native(['status','--change','greeting','--json'])).stdout),apply:JSON.parse((await native(['instructions','apply','--change','greeting','--json'])).stdout)};
   phase.nativeState=state;phase.artifacts=await inspectPreparedArtifacts(root,state,definition.errorType,skillRoot);
   if(!phase.artifacts.passed)throw Error('Native planning, same-change links, corrected criteria, preservation or verification evidence is incomplete');
   const name=definition.prepare?'change-prepare':'change-ready',evidence=workflowPrerequisiteEvidence(turn.observation.tools,{skill:skillMarkers[name],context:contextMarker,goal:'UNUSED_GOAL_MARKER'},'greeting');phase.observedPrerequisites=evidence;
   if(!evidence.loadedSkill||!evidence.loadedContext||!evidence.nativeStatus||!evidence.nativeApply)throw Error('Actual selected skill/context/native prerequisites were not observed');
   if(definition.prepare){
    if(!observedText(turn.observation.tools,templateMarker)||!Object.values(phase.artifacts.documents).every(value=>observedText(turn.observation.tools,value as string)))throw Error('Actual fixed-template use and read-back review of every artifact were not observed');
   }else{
    if(!observedText(turn.observation.tools,phase.artifacts.documents[goalPath]))throw Error('Actual GOAL read was not observed');
    if(definition.id==='ready-unapproved'&&!actionableBlocker(turn.observation.answer,'missing-approval'))throw Error('Unapproved readiness did not return an actionable approval blocker');
    if(definition.id==='ready-approved'&&(!turn.observation.answer.includes('Ready for implementation')||!turn.observation.answer.includes('/goal Implement the reviewed change in "'+goalPath+'" and verify every completion criterion in that file.')))throw Error('Approved readiness did not emit the exact goal handoff');
   }
   phase.status='passed';
  }catch(error){phase.reason=(error as Error).message;report.reason=definition.id+': '+phase.reason;}
  finally{if(!phase.usageComplete||phase.usage==='unknown')report.cumulative.usageComplete=false;phase.finishedAt=new Date().toISOString();await writeFile(join(control,'prepare-'+definition.id+'.result.json'),JSON.stringify(phase,null,2),{mode:0o600});}
  if(phase.status!=='passed')return report;
 }
 report.status='passed';return report;
}
