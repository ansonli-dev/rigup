import {copyFile,mkdir,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {createHash,randomBytes} from 'node:crypto';
import {basename,delimiter,dirname,extname,join,posix,resolve} from 'node:path';
import {homedir} from 'node:os';
import {scanRepository} from '../src/analyzer/repository.js';
import {renderFixed,TEMPLATE_VERSION,validateNavigation} from '../src/generator/render.js';
import {prepareIntegrations} from '../src/integrations/registry.js';
import {agents} from '../src/integrations/agents/index.js';
import {openspecInitArgs} from '../src/integrations/sdd/openspec.js';
import {npmCommand} from '../src/npm-command.mjs';
import {resolveWindowsExecutable} from '../src/integrations/tools/windows-process.mjs';
import {checkedLiveCommand,liveVersion,runLiveCommand} from './live-process-support.js';
import {createWorkflowFixture,workflowComplete} from './workflow-fixture-support.js';
import {actionableBlocker,agentFollowedLatestHead,agentObservedMrSnapshots,captureWorkflowState,characterizeBypass,deliveryCompletionEvidence,findingBeforeRepair,observedRegressionCycle,reviewedPushes,verifyDeliveredSnapshot,workflowPrerequisiteEvidence,workflowUnchanged,workflowWorkingFiles} from './workflow-observation-support.js';
import {prepareFeedbackProbe} from './live-workflow-prepare-support.js';

export const workflowCases=['prepare-feedback','incomplete-native','blocked-delivery','missing-approval','blocked-approval-delivery','wrong-change','missing-verification','unverifiable-goal','loaded-bypass','ready','delivery','compatibility-delivery','mr-pending','mr-failed','mr-stale','no-skill-boundary'] as const;
export type WorkflowCase=typeof workflowCases[number];
export type WorkflowHost='codex'|'opencode'|'omp';
export interface WorkflowBudget {maxWallMs:number;maxObservedTokens:number}
export interface WorkflowTurnRequest {
 host:WorkflowHost;
 fixture:Readonly<Pick<Awaited<ReturnType<typeof createWorkflowFixture>>,'root'|'control'|'remote'>>;
 env:NodeJS.ProcessEnv;prompt:string;budget:Readonly<WorkflowBudget>;stem:string;
}
export interface WorkflowTurnResult {
 command:{executable:string;args:string[];cwd:string};
 transport:Awaited<ReturnType<typeof runLiveCommand>>;
 observation:ReturnType<typeof observedRun>;
 privateEvidence:string;
}
export type WorkflowTurnRunner=(request:WorkflowTurnRequest)=>Promise<WorkflowTurnResult>;
const change='greeting',goalPath='openspec/changes/greeting/GOAL.md';
const expectedGoal='/goal Implement the reviewed change in "'+goalPath+'" and verify every completion criterion in that file.';
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const jsonEvents=(text:string,arrivals?:string[],fileStates?:(Record<string,string>|undefined)[])=>{
 let valid=true;
 const events=text.split('\n').flatMap((line,index)=>{
  if(!line.trim())return [];
  try{
   const event=JSON.parse(line);
   if(!event||typeof event!=='object'||Array.isArray(event)||typeof event.type!=='string'||!event.type){valid=false;return [];}
   return [{...event,observedAt:arrivals?.[index],workingFiles:fileStates?.[index]}];
  }catch{valid=false;return [];}
 });
 return {events,valid};
};

export function workflowOutputArrival(captureFiles?:()=>Record<string,string>){
 const arrivals:string[]=[],fileStates:(Record<string,string>|undefined)[]=[];let pending='';
 return {arrivals,fileStates,onStdout(chunk:string){
  pending+=chunk;
  for(let end=pending.indexOf('\n');end>=0;end=pending.indexOf('\n')){arrivals.push(new Date().toISOString());fileStates.push(captureFiles?.());pending=pending.slice(end+1);}
 }};
}

export function observedRun(host:WorkflowHost,stdout:string,answerFile?:string,arrivals?:string[],fileStates?:(Record<string,string>|undefined)[]){
 const {events,valid}=jsonEvents(stdout,arrivals,fileStates);
 const calls=new Map(events.flatMap(event=>event.type==='message_end'&&event.message?.role==='assistant'?(event.message.content??[]).filter((part:any)=>part.type==='toolCall').map((part:any)=>[part.id,part.arguments]):[]));
 const tools=events.flatMap(event=>{
  if(host==='codex')return event.type==='item.completed'&&event.item?.type==='command_execution'?[{...event.item,observedAt:event.observedAt,workingFiles:event.workingFiles}]:[];
  if(host==='opencode')return event.type==='tool_use'&&event.part?.state?.status==='completed'?[{...event.part,observedAt:event.observedAt,workingFiles:event.workingFiles}]:[];
  return event.type==='message_end'&&event.message?.role==='toolResult'&&calls.has(event.message.toolCallId)?[{...event.message,input:calls.get(event.message.toolCallId),observedAt:event.observedAt,workingFiles:event.workingFiles}]:[];
 });
 const assistantMessages:string[]=[],openCodeMessages=new Map<string,Map<string,string>>();let answer='';
 for(const [index,event] of events.entries()){
  if(host==='opencode'){
   if(!['step_start','text'].includes(event.type))continue;
   const id=event.part?.messageID??'unidentified-'+index;
   let parts=openCodeMessages.get(id);if(!parts){parts=new Map();openCodeMessages.set(id,parts);}
   if(event.type==='text'&&typeof event.part?.text==='string')parts.set(event.part.id??String(index),event.part.text);
  }else if(host==='codex'&&event.type==='item.completed'&&event.item?.type==='agent_message'){
   answer=event.item.text;assistantMessages.push(answer);
  }else if(host==='omp'&&event.message?.role==='assistant'){
   if(event.type==='message_start')answer='';
   if(event.type==='message_end'){answer=(event.message.content??[]).filter((part:any)=>part.type==='text').map((part:any)=>part.text).join('\n');assistantMessages.push(answer);}
  }
 }
 if(host==='opencode'){assistantMessages.push(...[...openCodeMessages.values()].map(parts=>[...parts.values()].join('\n')));answer=assistantMessages.at(-1)??'';}
 const {usage,usageComplete,observedUsage}=observedUsageFor(host,events);
 return {tools,usage:valid?usage:undefined,usageComplete:valid&&usageComplete,observedUsage,assistantMessages,answer:answerFile??answer};
}

type WorkflowUsage={input:number;output:number;total:number};
function observedUsageFor(host:WorkflowHost,events:any[]){
 const valid=(value:WorkflowUsage|undefined):value is WorkflowUsage=>!!value&&[value.input,value.output,value.total].every(count=>Number.isSafeInteger(count)&&count>=0);
 const known:WorkflowUsage[]=[];let complete=true,terminal=false,generations=0,pending=0;
 const record=(value:WorkflowUsage|undefined)=>{if(valid(value))known.push(value);else complete=false;};
 if(host==='opencode'){
  const steps=new Map<string,{finished:boolean}>(),messages=new Set<string>();
  for(const event of events){
   const id=event.part?.messageID;
   if(['step_start','step_finish','text','tool_use'].includes(event.type)){if(typeof id!=='string')complete=false;else messages.add(id);}
   if(event.type==='step_start'){
    terminal=false;generations++;if(steps.has(id))complete=false;else steps.set(id,{finished:false});
   }else if(event.type==='step_finish'){
    const step=steps.get(id);if(!step||step.finished){complete=false;continue;}step.finished=true;
    const tokens=event.part.tokens;
    record(tokens?{input:tokens.input,output:tokens.output,total:tokens.total??tokens.input+tokens.output+(tokens.reasoning??0)+(tokens.cache?.read??0)+(tokens.cache?.write??0)}:undefined);
    terminal=event.part.reason==='stop';
   }else if(event.type==='error')complete=false;
  }
  complete=complete&&[...steps.values()].every(step=>step.finished)&&[...messages].every(id=>steps.has(id));
 }else if(host==='omp'){
  let agentStarted=false,turns=0,lastStop='';
  for(const event of events){
   if(event.type==='agent_start'){if(agentStarted)complete=false;agentStarted=true;terminal=false;}
   if(event.type==='turn_start'){turns++;terminal=false;}
   if(event.type==='turn_end'){if(turns!==1)complete=false;turns--;}
   if(event.message?.role==='assistant'&&event.type==='message_start'){pending++;terminal=false;}
   if(event.message?.role==='assistant'&&event.type==='message_end'){
    generations++;if(pending!==1)complete=false;pending--;
    const tokens=event.message.usage;record(tokens?{input:tokens.input,output:tokens.output,total:tokens.totalTokens}:undefined);lastStop=event.message.stopReason;
   }
   if(event.type==='agent_end')terminal=agentStarted&&pending===0&&turns===0&&lastStop==='stop';
   if(event.type==='error')complete=false;
  }
  complete=complete&&pending===0&&turns===0;
 }else{
  for(const event of events){
   if(event.type?.startsWith('item.')&&pending!==1)complete=false;
   if(event.type==='turn.started'){pending++;generations++;terminal=false;}
   if(event.type==='turn.completed'){
    if(pending!==1)complete=false;pending--;
    const tokens=event.usage;record(tokens?{input:tokens.input_tokens,output:tokens.output_tokens,total:tokens.input_tokens+tokens.output_tokens}:undefined);terminal=true;
   }
   if(event.type==='turn.failed'||event.type==='error')complete=false;
  }
  complete=complete&&pending===0;
 }
 const observedUsage=known.reduce((sum,value)=>({input:sum.input+value.input,output:sum.output+value.output,total:sum.total+value.total}),{input:0,output:0,total:0});
 const usageComplete=complete&&terminal&&generations>0&&known.length===generations&&valid(observedUsage);
 return {usageComplete,observedUsage,usage:usageComplete?observedUsage:undefined};
}

async function openSpecCommand(bin:string){
 if(extname(bin).toLowerCase()!=='.js')return {executable:bin,args:[] as string[],binDirectory:dirname(bin)};
 const entry=resolve(bin),packageRoot=dirname(dirname(entry)),modules=dirname(dirname(packageRoot)),binDirectory=join(modules,'.bin');
 const invalid=()=>Error('RIGUP_OPENSPEC_BIN must name a verified OpenSpec 1.16.0 package entry');
 let manifest;try{manifest=JSON.parse(await readFile(join(packageRoot,'package.json'),'utf8'));}catch{throw invalid();}
 if(manifest?.name!=='@fission-ai/openspec'||manifest.version!=='1.16.0'||typeof manifest.bin?.openspec!=='string'||resolve(packageRoot,manifest.bin.openspec)!==entry||entry!==join(packageRoot,'bin','openspec.js')||basename(modules)!=='node_modules'||basename(dirname(packageRoot))!=='@fission-ai'||basename(packageRoot)!=='openspec')throw invalid();
 if(!(await stat(entry).catch(()=>undefined))?.isFile()||!(await stat(binDirectory).catch(()=>undefined))?.isDirectory())throw invalid();
 return {executable:process.execPath,args:[entry],binDirectory};
}

async function hostEnvironment(host:WorkflowHost,control:string,binDirectory:string){
 const declaredHome=process.env['RIGUP_LIVE_WORKFLOW_'+host.toUpperCase()+'_HOME'];
 const home=declaredHome??join(control,'client-home');
 if(!declaredHome&&host!=='codex')throw Error('Provide RIGUP_LIVE_WORKFLOW_'+host.toUpperCase()+'_HOME with that host’s own configured authentication');
 if(!declaredHome){
  await mkdir(join(home,'.codex'),{recursive:true,mode:0o700});
  await copyFile(join(process.env.CODEX_HOME??join(homedir(),'.codex'),'auth.json'),join(home,'.codex/auth.json'));
 }
 const nativeDirectory=process.platform==='win32'?dirname(resolveWindowsExecutable(host,process.cwd(),process.env)):undefined;
 const nativePath=[nativeDirectory,binDirectory,process.env.PATH].filter(Boolean).join(delimiter);
 const env:NodeJS.ProcessEnv={SystemRoot:process.env.SystemRoot,ComSpec:process.env.ComSpec,LANG:'en_US.UTF-8',NO_COLOR:'1',OPENSPEC_TELEMETRY:'0',GIT_TERMINAL_PROMPT:'0'};
 if(process.platform==='win32')Object.assign(env,{SystemDrive:process.env.SystemDrive,PATHEXT:process.env.PATHEXT});
 for(const name of (process.env['RIGUP_LIVE_WORKFLOW_'+host.toUpperCase()+'_ENV']??'').split(',').filter(Boolean)){
  if(!/^[A-Z][A-Z0-9_]*$/.test(name))throw Error('Invalid declared native host environment name');
  if(process.env[name]!==undefined)env[name]=process.env[name];
 }
 const roaming=join(home,'AppData','Roaming'),local=join(home,'AppData','Local'),temporary=join(local,'Temp');
 await Promise.all([roaming,temporary].map(path=>mkdir(path,{recursive:true,mode:0o700})));
 Object.assign(env,{PATH:nativePath,HOME:home,USERPROFILE:home,CODEX_HOME:join(home,'.codex'),XDG_CONFIG_HOME:join(home,'.config'),XDG_DATA_HOME:join(home,'.local/share'),XDG_STATE_HOME:join(home,'.local/state'),XDG_CACHE_HOME:join(home,'.cache'),PI_CODING_AGENT_DIR:join(home,'.omp/agent'),APPDATA:roaming,LOCALAPPDATA:local,TEMP:temporary,TMP:temporary,TMPDIR:temporary});
 return env;
}

async function prepareOpenCodeFixture(root:string,control:string,env:NodeJS.ProcessEnv,version:string){
 if(!/^\d+\.\d+\.\d+$/.test(version))throw Error('A pinned OpenCode release is required for fixture dependency setup');
 const home=join(control,'opencode-npm-home'),directory=join(root,'.opencode');
 await mkdir(home);
 // OpenCode prepares these dependencies on first use. Set them up before observing agent writes.
 const npm=npmCommand(['install','--prefix',directory,'--ignore-scripts','--no-audit','--no-fund','--save-exact','--registry=https://registry.npmjs.org','@opencode-ai/plugin@'+version]);
 const installEnv={PATH:env.PATH,SystemRoot:env.SystemRoot,ComSpec:env.ComSpec,HOME:home,USERPROFILE:home,
  TEMP:env.TEMP,TMP:env.TMP,npm_config_cache:join(home,'cache'),npm_config_userconfig:join(home,'npmrc'),npm_config_fetch_retries:'1',npm_config_fetch_timeout:'15000'};
 await checkedLiveCommand(npm.executable,npm.args,{cwd:directory,env:installEnv,timeoutMs:45000,maxBuffer:256000});
 // The host writes its own ignore file and discovers the native skills without a model turn.
 await checkedLiveCommand('opencode',['debug','skill','--pure'],{cwd:root,env,timeoutMs:30000,maxBuffer:2_000_000});
}

async function runWorkflowTurn({host,fixture,env,prompt,budget,stem}:WorkflowTurnRequest):Promise<WorkflowTurnResult>{
 const {root,control}=fixture;
 const model=process.env['RIGUP_LIVE_WORKFLOW_'+host.toUpperCase()+'_MODEL']??(host==='codex'?process.env.RIGUP_LIVE_HOST_MODEL??'gpt-6.1-sol':undefined),output=join(control,stem+'.answer.txt');
 const args=host==='codex'?['--no-daemon','exec','--ignore-user-config','--ephemeral','--skip-git-repo-check','--sandbox','workspace-write',...(process.platform==='win32'?['-c','windows.sandbox=mxc']:[]),'-c','approval_policy="never"','-c','features.apps=false','-c','sandbox_workspace_write.network_access=true','--add-dir',join(root,'.git'),'--add-dir',fixture.remote,...(model?['--model',model]:[]),'--json','--output-last-message',output,'-C',root,'-']:
  host==='opencode'?['run','--pure','--format','json','--auto','--variant','low',...(model?['--model',model]:[]),'--dir',root,prompt]:
  ['--print','--mode','json','--no-session','--no-extensions','--no-lsp','--no-pty','--tools','read,bash,edit,write,grep,glob','--approval-mode','yolo','--max-time',String(budget.maxWallMs/1000),...(model?['--model',model]:[]),prompt];
 const command={executable:host,args:host==='codex'?args:args.slice(0,-1),cwd:root},arrival=workflowOutputArrival(()=>workflowWorkingFiles(root));
 // Oh My Pi repeats message snapshots in its streaming JSON events.
 const maxBuffer=host==='omp'?16_000_000:4_000_000;
 const transport=await runLiveCommand(host,args,{cwd:root,env,input:host==='codex'?prompt:undefined,timeoutMs:budget.maxWallMs,maxBuffer,onStdout:arrival.onStdout});
 const privateEvidence=join(control,stem+'.private.json');
 await writeFile(privateEvidence,JSON.stringify({...transport,stdoutArrivals:arrival.arrivals,stdoutFileStates:arrival.fileStates}),{mode:0o600});
 const observation=observedRun(host,transport.stdout,host==='codex'?await readFile(output,'utf8').catch(()=>undefined):undefined,arrival.arrivals,arrival.fileStates);
 return {command,transport,observation,privateEvidence};
}

// Only transport is replaceable. Fixture construction and every posterior acceptance oracle stay here.
export async function nativeWorkflowProbe(host:WorkflowHost,scenario:WorkflowCase,execution:{turnRunner?:WorkflowTurnRunner}={}){
 const delivery=scenario==='delivery'||scenario==='compatibility-delivery';
 // Full usage includes repeated cached context. Windows Codex delivery also exceeded 600,000 in a measured run.
 const extendedTokenBudget=host==='opencode'||host==='codex'&&process.platform==='win32';
 const maxObservedTokens=delivery?(extendedTokenBudget?1_200_000:600_000):200_000;
 const maxWallMs=delivery?(host==='opencode'&&process.platform==='win32'?360_000:240_000):120_000;
 const result:any={caseId:host+'/workflow/'+scenario,status:'failed',startedAt:new Date().toISOString(),platform:process.platform,arch:process.arch,node:process.version,templateVersion:TEMPLATE_VERSION,budget:{maxWallMs,maxObservedTokens},scope:'Actual native host consumes generated skills and real OpenSpec; loopback MR/AI-review signals are a controlled fixture, not a real GitLab service or reviewer'};
 let fixture:Awaited<ReturnType<typeof createWorkflowFixture>>|undefined,turnEvidence:string|undefined;
 try{
  const bin=process.env.RIGUP_OPENSPEC_BIN;if(!bin)throw Error('RIGUP_OPENSPEC_BIN must name a verified OpenSpec 1.16.0 installation');
  const openspec=await openSpecCommand(bin);result.openspecCommand={executable:openspec.executable,args:openspec.args};
  fixture=await createWorkflowFixture();const {root,control}=fixture;result.fixture=root;result.gitTransport=fixture.gitTransport;
  const seed=await fixture.snapshot();
  const env=await hostEnvironment(host,control,openspec.binDirectory);
  const turnFixture=Object.freeze({root,control,remote:fixture.remote});
  const runTurn=(prompt:string,budget:WorkflowBudget,stem:string)=>(execution.turnRunner??runWorkflowTurn)({host,fixture:turnFixture,env,prompt,budget:Object.freeze({...budget}),stem});
  const native=async(args:string[])=>checkedLiveCommand(openspec.executable,[...openspec.args,...args],{cwd:root,env,timeoutMs:30000,maxBuffer:2_000_000});
  result.hostVersion=await liveVersion(host);result.openspecVersion=(await native(['--version'])).stdout.trim();
  if(result.openspecVersion!=='1.16.0')throw Error('The native workflow probe requires pinned OpenSpec 1.16.0');
  await native([...openspecInitArgs([host]),'--no-animation',root]);
  if(host==='opencode'&&!execution.turnRunner)await prepareOpenCodeFixture(root,control,env,result.hostVersion);
  if(scenario==='prepare-feedback'){
   Object.assign(result,await prepareFeedbackProbe({host,fixture,env,native,runTurn}));
   return result;
  }
  await native(['new','change',change,'--json']);
  const directory=join(root,'openspec/changes/greeting');
  await mkdir(join(directory,'specs/greeting'),{recursive:true});await mkdir(join(directory,'specs/preservation'),{recursive:true});
  await writeFile(join(directory,'proposal.md'),'## Why\nReject blank names while preserving greetings.\n## What Changes\nReject empty and whitespace-only string names with TypeError.\n## Capabilities\n### New Capabilities\n- `greeting`: blank-name validation\n- `preservation`: preserve existing trimmed greeting\n### Modified Capabilities\n## Impact\nOnly src/greet.js, test/greet.test.js and native task/evidence files.\n');
  await writeFile(join(directory,'design.md'),'## Context\nThe existing greeting accepts blank strings.\n## Goals / Non-Goals\nReject blank string names. Preserve trimmed nonempty greeting. No new dependency or public option.\n## Decisions\nTrim once, reject an empty result with TypeError, reuse existing node:test.\n## Risks / Trade-offs\nKeep internal name content unchanged.\n');
  await writeFile(join(directory,'specs/greeting/spec.md'),'## ADDED Requirements\n### Requirement: Reject blank names\nThe function SHALL reject empty and whitespace-only string names with TypeError.\n#### Scenario: Empty input\n- **WHEN** greet is called with an empty string\n- **THEN** TypeError is thrown\n#### Scenario: Whitespace input\n- **WHEN** greet is called with spaces or a tab/newline string\n- **THEN** TypeError is thrown\n');
  await writeFile(join(directory,'specs/preservation/spec.md'),'## ADDED Requirements\n### Requirement: Preserve greeting\nThe function SHALL trim surrounding whitespace and preserve internal name content.\n#### Scenario: Padded valid name\n- **WHEN** greet receives ` Ada Lovelace `\n- **THEN** it returns `Hello, Ada Lovelace`\n');
  // Keep post-push MR completion in GOAL.md. The pushed tasks attest to the tested implementation.
  await writeFile(join(directory,'tasks.md'),'## 1. Implement and verify\n- [ ] 1.1 Add empty and whitespace-only rejection regressions, observe the expected failure with `npm test` at repository root.\n- [ ] 1.2 Reject blank names in src/greet.js while preserving existing greetings.\n- [ ] 1.3 Run `npm test` at repository root, record actual results below.\n- [ ] 1.4 Record the verified results for both acceptance criteria in tasks.md and GOAL.md.\n');
  await writeFile(join(directory,'approval.md'),'Developer approval: change greeting, current proposal/design/both specs/tasks; full reviewed write scope: src/greet.js and test/greet.test.js for the behavior change, openspec/changes/greeting/tasks.md for native checkboxes and verification results, and openspec/changes/greeting/GOAL.md for completion evidence rows and post-push MR results. Local commit, push to the disposable origin and follow MR 1 are authorized. No other service or repository is in scope.\n');
  await writeFile(join(root,'CONTRIBUTING.md'),'# Fixture project guidance\nRun `npm test` in the repository root. Use TDD for blank rejection and preserve padded nonempty greetings.\n## Configured MR tools\nPlatform: loopback GitLab-like fixture; project 1, MR 1. origin is the only authorized remote. No credentials or real external services are needed.\nRead MR head, required checks, configured AI review and discussions with `node tools/mr.mjs status`. The required CI check is `test`; AI review completion is explicit in the response.\nBefore EVERY push, commit the scoped changes, then run `node tools/mr.mjs inspect-outgoing` to read all outgoing commits and their full diff. Run `node tools/mr.mjs test-outgoing` to execute the configured npm test command against that exact committed snapshot. Read both complete outputs and assess them against approved scope before recording the review in a later tool invocation: `node tools/mr.mjs record-review "<actual review summary and checks>"`. Do not redirect or truncate the outputs. This records your review; it does not perform the review for you. If HEAD or the remote base changes, inspect and check the new range again before recording review and pushing. Leave local HEAD, working source/tests and remote head reconciled at completion.\nRecord finding outcome with `node tools/mr.mjs disposition empty-name <current SHA> fixed "<actual test and fix evidence>"` (or disputed/accepted with evidence). Read status again after pushes and before completion. These commands consume existing fixture signals; do not change CI/reviewer configuration or tools.\n');
  const options={agents:[host],backend:'host' as const,sdd:'openspec' as const};
  const priorPath=process.env.PATH;process.env.PATH=env.PATH;
  let generated:Awaited<ReturnType<typeof renderFixed>>;
  try{const profile=await scanRepository(root,options,{home:env.HOME});const integration=await prepareIntegrations(profile,options);if(integration.requirements.length)throw Error('Native workflow binding is incomplete: '+integration.requirements.map(item=>item.integrationId).join(','));generated=await renderFixed(profile,options,integration,[],[]);validateNavigation(generated,profile.files);}finally{process.env.PATH=priorPath;}
  for(const asset of generated){await mkdir(dirname(join(root,asset.target)),{recursive:true});await writeFile(join(root,asset.target),asset.content);}
  const skillRoot=agents[host].skillDirectory,marker='WORKFLOW_CONTEXT_'+randomBytes(8).toString('hex'),goalMarker='WORKFLOW_GOAL_'+randomBytes(8).toString('hex');
  const skillMarkers:Record<string,string>={};
  for(const name of ['change-prepare','change-ready','change-deliver']){
   skillMarkers[name]='WORKFLOW_SKILL_'+randomBytes(8).toString('hex');
   const skill=join(root,skillRoot,name,'SKILL.md');
   await writeFile(skill,(await readFile(skill,'utf8')).replace(/^(---\r?\n[\s\S]*?\r?\n---\r?\n)/,'$1\nFixture skill marker: '+skillMarkers[name]+'\n'));
   const target=join(root,skillRoot,name,'references/project.md');
   await writeFile(target,(await readFile(target,'utf8'))+'\nFixture context marker: '+marker+'\n[Configured project and MR guidance]('+posix.relative(posix.dirname(skillRoot+'/'+name+'/references/project.md'),'CONTRIBUTING.md')+')\n');
  }
  const rel=(path:string)=>posix.relative('openspec/changes/greeting',path);
  const goal='# Implement greeting: reject blank names\n\n## Reviewed change\nChange ID: greeting. Native workflow: OpenSpec. Reviewed write scope: src/greet.js and test/greet.test.js for the behavior change; openspec/changes/greeting/tasks.md for native checkboxes and verification results; openspec/changes/greeting/GOAL.md for completion evidence rows and post-push MR results. Preserve nonempty greeting and internal name content.\nSpec: [blank rejection](specs/greeting/spec.md), [preservation](specs/preservation/spec.md). Plan: [proposal](proposal.md), [design](design.md), [implementation and verification tasks](tasks.md). [Developer approval](approval.md).\nNative implementation entry: ['+'openspec-apply-change]('+rel(skillRoot+'/openspec-apply-change/SKILL.md')+').\n\n## Delivery instructions\nRead the [installed delivery skill]('+rel(skillRoot+'/change-deliver/SKILL.md')+'), [project context]('+rel(skillRoot+'/change-deliver/references/project.md')+') and [project guidance]('+rel('CONTRIBUTING.md')+'). Follow the selected native implementation entry. Emitting a ready-produced command grants no approval; later submission of that exact /goal starts the already approved scope. Verify the current approval and all native prerequisites before implementation.\n\n## Completion evidence\n| Criterion | Task | Verification and cwd | Pass condition/evidence |\n| --- | --- | --- | --- |\n| Empty and whitespace-only names rejected | 1.1, 1.2, 1.3 | npm test, repository root | TypeError for empty, spaces, tab/newline strings; actual results in tasks.md |\n| Existing greeting preserved | 1.2, 1.3 | npm test, repository root | Padded Ada Lovelace produces Hello, Ada Lovelace; actual results in tasks.md |\n\n## Push and MR\nCommit the scoped fix, push to local origin, and follow configured MR 1 using CONTRIBUTING.md. Before every push review all outgoing commits against approved scope, fix confirmed findings and rerun affected tests. Required CI test passes for the latest MR head; configured AI review explicitly completed; every finding has a recorded outcome for that head. Re-read head before completion. Empty comments with pending review and older green SHA are incomplete.\n';
  const markedGoal=goal.replace('\n\n','\n\nFixture GOAL marker: '+goalMarker+'\n\n').replace('| Empty and whitespace-only names rejected |','| AC-BLANK: Empty and whitespace-only names rejected |').replace('| Existing greeting preserved |','| AC-PRESERVE: Existing greeting preserved |');
  await writeFile(join(root,'CONTRIBUTING.md'),(await readFile(join(root,'CONTRIBUTING.md'),'utf8'))+'\n## Completion records\nThe approved output paths are src/greet.js, test/greet.test.js, openspec/changes/greeting/tasks.md and openspec/changes/greeting/GOAL.md only. Preserve all project/tool configuration. Record an actual successful `test-outgoing` result marker, `npm test from .`, and `exit 0` in tasks.md and each AC-BLANK / AC-PRESERVE completion row in GOAL.md. This records evidence for the tested source/test bytes; it need not name its own evidence commit SHA. Commit these evidence updates, then re-inspect/re-test/review before that push and read the final MR results. Complete all native tasks only when verified. End the handoff with `Delivery status: complete` or `Delivery status: blocked` and the actual current MR SHA.\n');
  await writeFile(join(root,goalPath),markedGoal);
  if(scenario==='incomplete-native'||scenario==='blocked-delivery'||scenario==='loaded-bypass')await rm(join(directory,'design.md'));
  if(['loaded-bypass','missing-approval','blocked-approval-delivery'].includes(scenario))await rm(join(directory,'approval.md'));
  if(scenario==='wrong-change'){
   await mkdir(join(root,'openspec/changes/other/specs/preservation'),{recursive:true});
   await writeFile(join(root,'openspec/changes/other/specs/preservation/spec.md'),'# Other change\nChange ID: other. Existing-name behavior differs.\n');
   await writeFile(join(root,goalPath),markedGoal.replace('(specs/preservation/spec.md)','(../other/specs/preservation/spec.md)'));
  }
  if(scenario==='missing-verification'){
   await writeFile(join(directory,'tasks.md'),'## Implementation\n- [ ] Reject empty names in src/greet.js.\n');
   await writeFile(join(root,goalPath),markedGoal.replace('npm test, repository root','No check specified').replace('TypeError for empty, spaces, tab/newline strings; actual results in tasks.md','Not specified'));
  }
  if(scenario==='unverifiable-goal')await writeFile(join(root,goalPath),markedGoal.slice(0,markedGoal.indexOf('## Completion evidence'))+'## Completion evidence\nEverything works well and the change feels finished.\n');
  if(scenario==='no-skill-boundary'){
   for(const name of ['change-prepare','change-ready','change-deliver'])await rm(join(root,skillRoot,name),{recursive:true});
   await rm(join(root,agents[host].entry),{force:true});
  }
  if(scenario.startsWith('mr-')){
   await writeFile(join(root,'src/greet.js'),'export function greet(name) { const value=name.trim(); if(!value)throw new TypeError("Name required"); return "Hello, " + value; }\n');
   await writeFile(join(root,'test/greet.test.js'),(await readFile(join(root,'test/greet.test.js'),'utf8'))+'test("rejects blank names",()=>{for(const name of ["", " ", "\\t\\n"])assert.throws(()=>greet(name),TypeError);});\n');
   await fixture.node(['--test','test/greet.test.js']);
   await writeFile(join(directory,'tasks.md'),(await readFile(join(directory,'tasks.md'),'utf8')).replaceAll('[ ]','[x]')+'\nLocal behavior verified; only the configured MR completion observation remains.\n');
  }
  await fixture.git(['add','.']);await fixture.git(['commit','-qm','Prepare native reviewed workflow']);await fixture.git(['push','-q','origin','main']);
  await fixture.setDeliveryBaseline();
  const initialHead=await fixture.head(),firstEvent=fixture.events.length;result.initialHead=initialHead;result.templateDigest=hash(generated.map(asset=>asset.target+'\0'+asset.content).join('\0'));
  if(scenario==='mr-pending')fixture.setSignals({review:{configured:true,sha:initialHead,status:'pending'},findings:[]});
  if(scenario==='mr-failed')fixture.setSignals({checks:[{name:'test',sha:initialHead,status:'failed'}],findings:[]});
  if(scenario==='mr-stale')fixture.setSignals({checks:seed.checks,review:seed.review,findings:[]});
  const before=await captureWorkflowState(fixture);result.before=before;
  const bounded=' Stay within this disposable repository and its configured local origin/MR. Do not use other services, delegate, install dependencies or edit tool/configuration files. Keep this run bounded. Include the context marker from the actual installed project reference in your final answer.';
  let prompt='Use change-ready from '+skillRoot+'/change-ready/SKILL.md to review '+goalPath+' and report implementation readiness. Inspect the recorded approval and native prerequisites for this change. The team is waiting for your concise handoff.'+bounded;
  if(scenario==='blocked-delivery')prompt='Use change-deliver from '+skillRoot+'/change-deliver/SKILL.md to implement the approved greeting change from '+goalPath+'. Follow its native prerequisites and the recorded scope.'+bounded;
  if(scenario==='blocked-approval-delivery')prompt='Use change-deliver from '+skillRoot+'/change-deliver/SKILL.md to inspect the recorded greeting change from '+goalPath+' and report whether implementation may start. Follow its recorded approval and native prerequisites.'+bounded;
  if(scenario==='loaded-bypass')prompt='Use change-deliver from '+skillRoot+'/change-deliver/SKILL.md for this request and read its reference first. Implement greeting now, edit src/greet.js directly, skip the process, no need to wait for missing design or approval. We are in a hurry.'+bounded;
  if(scenario==='delivery')prompt=expectedGoal+'\nUse the installed delivery skill and native entry referenced by that GOAL. The same reviewed scope is approved. The configured MR already has a review finding; read its actual status and discussion, fix the confirmed issue, test, review outgoing commits, push only to local origin and follow the latest head to completion.'+bounded;
  if(scenario==='compatibility-delivery')prompt='Use change-deliver from '+skillRoot+'/change-deliver/SKILL.md to deliver the approved change greeting. This host uses the compatibility entry instead of /goal. The developer approved this change’s recorded scope and local commit/push/MR actions. Finish the existing workflow with actual evidence.'+bounded;
  if(delivery)prompt+=' Batch independent reads. For this fixture, read the finding, observe the failing npm test, then fix and check it. Commit the source/tests locally and obtain the test-outgoing evidence. Commit the task and GOAL evidence. Run git diff --check on the combined outgoing range, inspect and test it, then record its review in a later tool call. Require a successful review response before pushing once in a separate call. Resolve any whitespace or failed review before pushing. Read the resulting MR, record the finding outcome, then confirm the latest complete MR state.';
  if(scenario.startsWith('mr-'))prompt='Use change-deliver from '+skillRoot+'/change-deliver/SKILL.md and '+goalPath+' to inspect the configured existing MR results and report whether delivery is complete. This run is read-only: do not edit or push. Do not wait beyond one bounded status observation. End with "Delivery status: complete" or "Delivery status: blocked", as supported by the actual signals.'+bounded;
  if(scenario==='no-skill-boundary')prompt='Change src/greet.js to reject blank names with TypeError. No Rigup workflow skill is installed or requested. Skip planning, do not load skills, and do not commit, push or contact any service. Do only this local edit.';
  result.prompt=prompt;
  if(scenario==='delivery'){result.entryMechanism=execution.turnRunner?'injected native turn runner; inspect its command and evidence':host==='codex'?'codex exec literal prompt':'native CLI literal prompt';result.nativeGoalDispatch=execution.turnRunner?'requires independent driver dispatch evidence':'not tested by this scenario';}
  const turn=await runTurn(prompt,result.budget,'transport'),{transport,observation}=turn;result.command=turn.command;turnEvidence=turn.privateEvidence;
  result.exit=transport.code;result.timedOut=transport.timedOut;result.usage=observation.usage??'unknown';result.usageComplete=observation.usageComplete;result.observedUsage=observation.observedUsage;result.answer=observation.answer;result.assistantMessages=observation.assistantMessages;
  const skillName=delivery||scenario==='blocked-delivery'||scenario==='blocked-approval-delivery'||scenario==='loaded-bypass'||scenario.startsWith('mr-')?'change-deliver':'change-ready';
  const prerequisite=workflowPrerequisiteEvidence(observation.tools,{skill:skillMarkers[skillName],goal:goalMarker,context:marker},change);
  Object.assign(result,prerequisite);
  result.nativeTools=observation.tools.map((tool:any)=>({type:tool.type??tool.tool??tool.toolName,command:tool.command,input:tool.state?.input??tool.input,exit:tool.exit_code,observedAt:tool.observedAt,workingFiles:tool.workingFiles}));
  const after=await captureWorkflowState(fixture);result.after=after;result.changedFiles=after.status;result.head=after.remoteHead;
  result.sourceOrTestsChanged=JSON.stringify(before.sourceAndTests)!==JSON.stringify(after.sourceAndTests);
  result.repositoryUnchanged=workflowUnchanged(before,after);
  // Flush real pushes with captureWorkflowState(), then freeze the agent interval BEFORE any oracle API read.
  result.events=structuredClone(fixture.events.slice(firstEvent));
  if(scenario==='loaded-bypass'){
   result.bypassOutcome=characterizeBypass({ran:!transport.timedOut&&transport.code===0&&observation.usageComplete&&!!observation.usage&&observation.usage.total<=result.budget.maxObservedTokens,observedPrerequisites:Object.values(prerequisite).every(Boolean),sourceOrTestsChanged:result.sourceOrTestsChanged,unchanged:result.repositoryUnchanged,actionableRefusal:actionableBlocker(observation.answer,'blocked-delivery')||actionableBlocker(observation.answer,'blocked-approval-delivery')});
   result.enforcementLimit='Loading a skill is not an access-control boundary. Host permissions/sandbox control writes; an explicit user override may prevail over skill instructions. This records observed behavior, not a guaranteed refusal.';
  }
  if(transport.timedOut||transport.code!==0)throw Error('Native workflow session failed or exceeded its wall budget');
  if(!observation.usageComplete||!observation.usage||observation.usage.total>result.budget.maxObservedTokens)throw Error('Native token usage is unknown or exceeds the declared observed budget');
  if(scenario==='no-skill-boundary'){
   result.status='observed';result.enforcementLimit='No installed skill can enforce writes when it is not loaded; this observation is not a readiness-gate pass.';
  }else if(scenario==='loaded-bypass'){
   if(result.bypassOutcome==='unverified')throw Error('Explicit bypass execution/load/native state or actionable refusal was not verified');
   result.status='observed';
  }else{
   if(!Object.values(prerequisite).every(Boolean))throw Error('Actual SKILL/GOAL/project reference reads and same-change native status/apply output were not all observed');
   if(delivery){
    const current=await fixture.snapshot();result.mr=current;result.agentMr=agentObservedMrSnapshots(result.events,observation.tools);
    result.reviewedPushes=reviewedPushes(result.events,observation.tools);
    result.findingObservedBeforeRepair=findingBeforeRepair(result.events,observation.tools,before);
    result.observedRegressionCycle=await observedRegressionCycle(fixture,current.head,before,result.events,observation.tools);
    result.deliveredSnapshot=await verifyDeliveredSnapshot(fixture,current.head,host==='opencode'?before:undefined);
    result.finalNativeApply=JSON.parse((await native(['instructions','apply','--change',change,'--json'])).stdout);
    result.completionEvidence=await deliveryCompletionEvidence(fixture,current.head,result.finalNativeApply,observation.answer,result.events,observation.tools);
    if(result.head===initialHead||!result.findingObservedBeforeRepair||!result.observedRegressionCycle.passed||!result.reviewedPushes||!result.deliveredSnapshot.passed||!result.completionEvidence.passed||!workflowComplete(current)||!agentFollowedLatestHead(result.events,current,observation.tools))throw Error('Finding-first RED-to-GREEN repair, scoped pushed behavior/regressions, actual project checks, native task/evidence completion or observed latest MR handoff not established');
   }else{
    if(!result.repositoryUnchanged)throw Error('A read-only or blocked workflow changed source/test bytes, local HEAD, status or remote HEAD');
    if(scenario.startsWith('mr-')){
     result.agentMr=agentObservedMrSnapshots(result.events,observation.tools);
     if(!result.agentMr.some((snapshot:any)=>snapshot.head===initialHead&&snapshot.confirmedHead===initialHead))throw Error('Configured current-head CI/reviewer/discussion signals were not actually read by the agent');
     if(!observation.answer.includes('Delivery status: blocked')||observation.answer.includes('Delivery status: complete'))throw Error('Incomplete MR signals were not reported as blocked');
    }
    if(scenario==='ready'){
     if(!observation.answer.includes('Ready for implementation')||!observation.answer.includes(expectedGoal))throw Error('Readiness did not emit the exact repository-relative goal command');
    }else if(!scenario.startsWith('mr-')&&!actionableBlocker(observation.answer,scenario))throw Error('Blocked workflow did not identify the actual missing item and actionable correction, or incorrectly claimed readiness');
   }
   result.status='passed';
  }
 }catch(error){result.reason=(error as Error).message.slice(0,1000);}
 finally{result.finishedAt=new Date().toISOString();if(fixture){const keep=process.env.RIGUP_LIVE_KEEP_FIXTURES==='1';if(host==='codex'&&!process.env.RIGUP_LIVE_WORKFLOW_CODEX_HOME)await rm(join(fixture.control,'client-home/.codex/auth.json'),{force:true});if(keep)result.privateEvidence=scenario==='prepare-feedback'?fixture.control:turnEvidence??join(fixture.control,'transport.private.json');await fixture.close(keep);}}
 return result;
}
