import {createProgressReporter,type RunProgressEvent} from './progress.js';
import {readFile} from 'node:fs/promises';
import {saveDurable} from './installer/state.js';
import {configurationCandidate} from './config.js';
import {validateResearch,ResearchFailure} from './analyzer/backend.js';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {runProjectChecks} from './integrations/tools/quality.js';
import type {SetupOptions,CheckKind} from './types.js';
import type {AnalysisBackend,ResearchResult} from './analyzer/backend.js';
import {scanRepository,repositoryReader} from './analyzer/repository.js';
import {hostBackend} from './analyzer/host.js';
import {nativeBackend} from './analyzer/anthropic.js';
import {codexBackend} from './analyzer/codex.js';
import {PROMPT_VERSION} from './analyzer/prompts.js';
import {READ_POLICY_VERSION} from './analyzer/read-policy.js';
import {generate,inventorySignature} from './generator/generate.js';
import {DOCUMENT_POLICY_VERSION} from './generator/document-policy.js';
import {TEMPLATE_VERSION} from './generator/render.js';
import {privateDirectory,signature,readCache,saveCache} from './generator/cache.js';
import {prepareIntegrations} from './integrations/registry.js';
import {loadManifest} from './installer/baseline.js';
import {acquireLock} from './installer/lock.js';
import {assertNoUnknownWriters} from './installer/operations.js';
import {preview} from './installer/preview.js';
import {readTarget,absentDigest} from './installer/preview.js';
import {digest} from './analyzer/evidence.js';
import {apply,restoreInterruptedPreview,type CheckResult} from './installer/apply.js';
export interface LifecycleFlags {dryRun?:boolean;yes?:boolean;review?:boolean;response?:string;request?:string;sessionsEnded?:boolean;resume?:boolean;continuation?:string;retireIds?:string[];runChecks?:CheckKind[];configure?:boolean}
export interface LifecycleServices {backend?:AnalysisBackend;credentials?:{apiKey?:string;model?:string};isTTY?:boolean;clock?:()=>number;cacheRoot?:string;stateRoot?:string;signal?:AbortSignal;runChecks?:()=>Promise<CheckResult[]>;report?:(value:Record<string,unknown>)=>void}
interface Run {root:string;options:SetupOptions;effectiveModel?:SetupOptions['model'];mode:LifecycleFlags;runId:string;research?:ResearchResult;spent:{calls:number;tokens:number|'unknown'};readSpent?:{calls:number;bytes:number};consent:string}
export async function executeLifecycle(root:string,options:SetupOptions,flags:LifecycleFlags,write:(s:string)=>void,services:LifecycleServices={}):Promise<number>{
 if(!options.agents.length){write('agents: choose at least one native host before research\n');services.report?.({phase:'preflight',installStatus:'pending',requiredInput:[{field:'agents',sources:['project configuration','selected profile','CLI overrides'],provide:'--agents codex (or another supported host)'}]});return 3;}
 const budget=options.researchBudget??{maxCalls:60,maxTokens:100000};
 const model=options.model?.model??services.credentials?.model??process.env.ANTHROPIC_MODEL;
 const effectiveModel:SetupOptions['model']=options.backend==='native'&&options.sdd&&model?{provider:'anthropic',model,apiKeyEnv:options.model?.apiKeyEnv??'ANTHROPIC_API_KEY'}:undefined;
 const lock=await acquireLock(root,{stateRoot:services.stateRoot,recover:flags.resume});
 const phases=[...(options.sdd?['research']:[]),'generation','preview',...(!flags.dryRun?['apply']:[])];
 const progress=createProgressReporter({runId:lock.id,phases,isTTY:!!services.isTTY,write,clock:services.clock});let active:RunProgressEvent={stage:phases[0],task:'bounded source scan',completed:0,next:'prepare selected integrations'};const emit=(event:RunProgressEvent)=>{active=event;progress.event(event);};emit(active);
 const heartbeat=setInterval(()=>progress.tick(),1000);heartbeat.unref();

 try {
  await assertNoUnknownWriters(root,lock.stateRoot);
  const base=await privateDirectory(services.cacheRoot??join(homedir(),'.cache','rigup'),root);
  const cache=await privateDirectory(join(base,'generation'),root);const requests=await privateDirectory(join(base,'host'),root);const previews=await privateDirectory(join(base,'previews'),root);const runs=await privateDirectory(join(base,'runs'),root);
  if(flags.resume){const interrupted=await restoreInterruptedPreview(root,options,previews,lock.stateRoot);if(interrupted){
   if(flags.dryRun||flags.review){services.report?.({phase:'preview',previewId:interrupted,installStatus:'pending',message:'Durable interrupted preview restored; resume without dry-run/review to apply'});return 3;}
   const installed=await apply(interrupted,{cacheRoot:previews,stateRoot:lock.stateRoot,lock,recover:true,signal:services.signal,onProgress:emit,runChecks:services.runChecks});services.report?.({phase:'apply',installStatus:installed.status,...installed});write('Resumed protected installation '+installed.status+'\n');return installed.exitCode;
  }}
 if(options.sdd&&options.backend==='native'&&!services.backend&&(!(options.model?.model??services.credentials?.model??process.env.ANTHROPIC_MODEL)||!(services.credentials?.apiKey??process.env[options.model?.apiKeyEnv??'ANTHROPIC_API_KEY']))){write('model: model ID and API-key environment reference required before research\n');services.report?.({phase:'preflight',installStatus:'pending',requiredInput:[{field:'model',sources:['effective configuration','ANTHROPIC_MODEL','API-key environment reference'],provide:'Configure model.model and model.apiKeyEnv; set the referenced variable outside project configuration'}]});return 3;}
  const profile=await scanRepository(root,options);const old=await loadManifest(root);profile.installedTools=old?.installedTools;
  profile.initializedTools=old?.initializedTools;
  const prepared=await prepareIntegrations(profile,options);
  const config=await readTarget(root,'.rigup/config.yaml');
  const consent=signature({root,options,effectiveModel,configDigest:config?digest(config):absentDigest,retireIds:flags.retireIds??[],runChecks:flags.runChecks??[],configure:!!flags.configure,executionMode:flags.dryRun?'dry-run':flags.review?'review':'continuous',versions:{prompt:PROMPT_VERSION,template:TEMPLATE_VERSION,document:DOCUMENT_POLICY_VERSION,read:READ_POLICY_VERSION},fingerprint:profile.fingerprint});
  if(flags.continuation&&flags.continuation!==consent)throw new Error('continuation input/configuration changed; restart preparation');
  const runPath=join(runs,consent+'.json');let run=await readCache<Run>(runPath);if(!run||run.consent!==consent)run={root,options,effectiveModel,mode:{dryRun:flags.dryRun,yes:flags.yes,review:flags.review,retireIds:flags.retireIds,runChecks:flags.runChecks,configure:flags.configure},runId:randomUUID(),spent:{calls:0,tokens:0},consent};
  await saveDurable(runPath,JSON.stringify(run));let responseConsumed=false;
  const quote=(s:string)=>"'"+s.replaceAll("'","'\"'\"'")+"'";
  const continuation=(requestPath:string)=>'rigup update '+quote(root)+' --continue '+consent+' --response '+quote(requestPath.replace(/(?:\.request)?\.json$/,'.response.json'));
  run.readSpent??={calls:0,bytes:0};const reader=await repositoryReader(root,options,{budget:run.readSpent,persist:()=>saveDurable(runPath,JSON.stringify(run)),expectedFingerprint:profile.fingerprint});
  const durableNative=!services.backend&&options.backend==='native';let activeNativeBase=run.spent;
  const rawBackend:AnalysisBackend=services.backend??(options.backend==='host'?{run:async(request,reader)=>{
   if(flags.response&&!responseConsumed){
    const response=JSON.parse(await readFile(flags.response,'utf8'));if(typeof response.requestId!=='string'||!/^[a-f0-9]{64}$/.test(response.requestId))throw new Error('host response request identity invalid');
    const original=await readCache<any>(join(requests,response.requestId+'.request.json'));if(!original)throw new Error('original host request missing');
    const common=(value:Record<string,unknown>)=>{const {kind,artifact,expectedOutput,input,spent,...rest}=value;return {...rest,promptVersion:PROMPT_VERSION,readPolicyVersion:READ_POLICY_VERSION};};
    if(signature(common(original.context))!==signature(common(request as unknown as Record<string,unknown>)))throw new Error('host response does not match current run context');
    const accepted=await readCache<any>(join(requests,response.requestId+'.accepted.json'));
    if(accepted){await hostBackend({cacheRoot:requests,responsePath:flags.response}).run(original.context,reader);responseConsumed=true;}
   }
   const result=await hostBackend({cacheRoot:requests,requestPath:responseConsumed?undefined:flags.request,responsePath:responseConsumed?undefined:flags.response}).run(request,reader);if(result.status==='complete'&&flags.response)responseConsumed=true;return result;
  }}:options.backend==='codex'?codexBackend({cacheRoot:join(base,'codex'),stateRoot:join(lock.stateRoot,'codex'),signal:services.signal,onUsage:async usage=>{run.spent=usage;await saveDurable(runPath,JSON.stringify(run));}}):nativeBackend({apiKey:services.credentials?.apiKey??process.env[options.model?.apiKeyEnv??'ANTHROPIC_API_KEY'],model:options.model?.model??services.credentials?.model??process.env.ANTHROPIC_MODEL,signal:services.signal,onUsage:async usage=>{run.spent={calls:activeNativeBase.calls+usage.calls,tokens:activeNativeBase.tokens==='unknown'||usage.tokens==='unknown'?'unknown':activeNativeBase.tokens+usage.tokens};await saveDurable(runPath,JSON.stringify(run));}}));
  const addUsage=async(usage:{calls:number|'unknown';tokens:number|'unknown'})=>{run.spent={calls:run.spent.calls+(typeof usage.calls==='number'?usage.calls:1),tokens:run.spent.tokens==='unknown'||usage.tokens==='unknown'?'unknown':run.spent.tokens+usage.tokens};await saveDurable(runPath,JSON.stringify(run));};
  const backend:AnalysisBackend=options.backend==='native'||options.backend==='codex'&&!!services.backend?{run:async(request,source)=>{
   if(run.spent.calls>=budget.maxCalls||run.spent.tokens==='unknown'||run.spent.tokens>=budget.maxTokens)throw new ResearchFailure('restored research budget exhausted or unknown');
   activeNativeBase=run.spent;
   try{const result=await rawBackend.run({...request,spent:run.spent},source);if(result.status==='complete'&&!durableNative)await addUsage(result.value.usage);return result;}
   catch(error){if(!durableNative&&error instanceof ResearchFailure&&error.usage)await addUsage(error.usage);throw error;}
  }}:rawBackend;
  const previousAssets=(old?.assets??[]).filter(a=>a.logicalId!=='rigup:configuration');
  const analysisPath=join(runs,signature({kind:'analysis',root,fingerprint:profile.fingerprint,options,effectiveModel,templates:signature(prepared.assets),prompt:PROMPT_VERSION,read:READ_POLICY_VERSION,template:TEMPLATE_VERSION,document:DOCUMENT_POLICY_VERSION})+'.analysis.json');
  if(options.sdd&&!run.research){const cached=await readCache<ResearchResult>(analysisPath);if(cached){try{await validateResearch(cached.data,reader);run.research=cached;write('Research: reuse accepted evidence for unchanged inputs\n');}catch{/* Invalidated accepted evidence is researched again. */}}}
  let newResearch=false;
  if(options.sdd&&!run.research){
   newResearch=true;write('Research: reading bounded project evidence\n');
   const result=await backend.run({kind:'analyze',runId:run.runId,root,fingerprint:profile.fingerprint,options,effectiveModel,versions:{prompt:PROMPT_VERSION,template:TEMPLATE_VERSION,document:DOCUMENT_POLICY_VERSION,read:READ_POLICY_VERSION},budget,previousInventoryDigest:inventorySignature(previousAssets),templateSourcesDigest:signature(prepared.assets)},reader);
   if(result.status==='pending-host'){emit({stage:'research',completed:0,status:'waiting',requiresUserAction:true,waiting:'host response',next:continuation(result.requestPath)});services.report?.({phase:'research',installStatus:'pending',pending:[result.requestId],requestPath:result.requestPath,nextCommand:continuation(result.requestPath)});write('Pending host research: '+result.requestPath+'\nResume: '+continuation(result.requestPath)+'\n');return 3;}
   run.research=result.value;await saveCache(analysisPath,JSON.stringify(result.value));if(options.backend==='host')run.spent={calls:typeof result.value.usage.calls==='number'?result.value.usage.calls:1,tokens:result.value.usage.tokens};await saveDurable(runPath,JSON.stringify(run));
  }
  if(options.sdd)emit({stage:'research',completed:1,total:1,status:newResearch?'complete':'reused',next:'generation'});
  profile.research=run.research;emit({stage:'generation',completed:0,task:'artifact planning and fixed assets',next:'preview',waiting:options.backend==='codex'?'local Codex research':options.backend==='native'?'provider research':'local preparation / host response'});write('Generate: assembling selected capabilities\n');
  const generated=await generate(profile,options,backend,previousAssets,{cacheRoot:cache,runId:run.runId,spent:run.spent,onProgress:emit,reader,effectiveModel});
  if(generated.status==='pending-host'){emit({...active,status:'waiting',requiresUserAction:true,waiting:'host response',next:continuation(generated.requestPath)});services.report?.({phase:'generation',installStatus:'pending',pending:[generated.requestId],requestPath:generated.requestPath,nextCommand:continuation(generated.requestPath)});write('Pending host generation: '+generated.requestPath+'\nResume: '+continuation(generated.requestPath)+'\n');return 3;}
  const oldConfiguration=old?.assets.find(a=>a.logicalId==='rigup:configuration');
  if(oldConfiguration)generated.value.dispositions.push({logicalId:oldConfiguration.logicalId,action:flags.configure?'update':'retain',reason:flags.configure?'Explicit configuration change':'Preserve configuration ownership and original baseline'});
  const resolutions:import('./installer/preview.js').PreviewResolution[]=[];
  if(flags.configure){const candidate=await configurationCandidate(root,options);generated.value.assets.push(candidate);const raw=await readTarget(root,candidate.target);resolutions.push({target:candidate.target,selector:candidate.ownership,observedDigest:raw?digest(raw):absentDigest,action:'replace'});}
  for(const id of flags.retireIds??[]){const disposition=generated.value.dispositions.find(d=>d.logicalId===id);if(!disposition)throw new Error('retirement id not in old inventory');if(generated.value.assets.some(a=>a.logicalId===id))throw new Error('retirement contradicts selected capability');disposition.action='retire';disposition.reason='Explicit retirement authorized before research';}
  for(const d of generated.value.dispositions)if(d.action==='retire'&&!flags.retireIds?.includes(d.logicalId))generated.value.requirements.push({integrationId:d.logicalId,reason:'Retirement is outside current consent; rerun with --retire '+d.logicalId});
  emit({stage:'generation',unit:'assets',task:'fixed assembly',completed:generated.value.assets.length,total:generated.value.assets.length,status:'complete',next:'preview'});emit({stage:'preview',completed:0,next:'apply or explicit review',waiting:'ownership and virtual-tree checks'});
  generated.value.runChecks=flags.runChecks??[];
  const result=await preview(generated.value,resolutions,{cacheRoot:previews});
  services.report?.({phase:'preview',installStatus:'not-installed',...result,pending:generated.value.requirements,conflicts:result.items.filter(i=>i.action==='conflict')});
  write('Preview '+result.previewId+'\n');for(const item of result.items){write(item.action+' '+item.target+'\n');if(item.before!==undefined)write('--- owned before (filtered, max 4000 chars)\n'+item.before+'\n');if(item.after!==undefined)write('+++ owned after (filtered, max 4000 chars)\n'+item.after+'\n');}for(const operation of result.operations)write('operation '+operation.id+' '+operation.version+' scope '+operation.declaredWrites.join(', ')+'\n');
  for(const blocker of result.blockers)write('Blocked: '+blocker+'\n');
  emit({stage:'preview',completed:result.items.length,total:result.items.length,status:result.executable?'complete':result.items.some(i=>i.action==='conflict')?'failed':'waiting',requiresUserAction:!result.executable,next:flags.dryRun?'dry-run preview finished; not installed':'apply'});
  if(!result.executable)return result.items.some(i=>i.action==='conflict')||!generated.value.requirements.length?1:3;
  if(flags.dryRun)return 0;
  const activeHost=!!(process.env.CODEX_THREAD_ID||process.env.CLAUDECODE||process.env.OPENCODE||process.env.PI_CODING_AGENT_DIR);
  const cwd=await import('node:fs/promises').then(fs=>fs.realpath(process.cwd()));const related=root===cwd||root.startsWith(cwd+'/')||cwd.startsWith(root+'/');
  if(flags.review||options.backend==='host'&&activeHost&&related&&!flags.sessionsEnded){emit({stage:'apply',completed:0,status:'waiting',requiresUserAction:true,waiting:'review / affected host session exit',next:'independent terminal apply'});services.report?.({phase:'handoff',installStatus:'pending',...result,pending:['End affected sessions / review the concrete preview'],nextCommand:'rigup update '+JSON.stringify(root)+' --apply '+result.previewId+' --sessions-ended'});write('Pending review/session handoff. End affected sessions, then run from an independent terminal:\nrigup update '+JSON.stringify(root)+' --apply '+result.previewId+' --sessions-ended\n');return 3;}
  const installed=await apply(result.previewId,{cacheRoot:previews,stateRoot:lock.stateRoot,lock,onProgress:emit,recover:flags.resume,signal:services.signal,runChecks:services.runChecks??(flags.runChecks?.length?async()=>runProjectChecks(await scanRepository(root,options),flags.runChecks!,services.signal):undefined)});
  services.report?.({phase:'apply',installStatus:installed.status,...installed});
  for(const warning of installed.warnings)write('Pending/note: '+warning+'\n');
  write('Install '+installed.status+'; written '+installed.written.length+'; checks '+installed.checks.map(c=>c.name+':'+c.status).join(', ')+'\n');return installed.exitCode;
 }catch(error){emit({...active,status:services.signal?.aborted?'waiting':'failed',requiresUserAction:!!services.signal?.aborted,waiting:services.signal?.aborted?'cancelled; writer exit reconciliation':'failure; inspect final report',next:'re-prepare with current inputs'});throw error;}finally{clearInterval(heartbeat);await lock.release();}
}

export async function loadContinuation(root:string,id:string,services:LifecycleServices={}):Promise<{options:SetupOptions;flags:LifecycleFlags}>{
 if(!/^[a-f0-9]{64}$/.test(id))throw new Error('continuation id invalid');
 const base=await privateDirectory(services.cacheRoot??join(homedir(),'.cache','rigup'),root);const run=await readCache<Run>(join(base,'runs',id+'.json'));
 if(!run||run.root!==root||run.consent!==id)throw new Error('continuation missing; restart preparation');return {options:run.options,flags:{...run.mode,continuation:id}};
}
