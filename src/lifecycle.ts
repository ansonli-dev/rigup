import {createProgressReporter,type RunProgressEvent} from './progress.js';
import {readFile,readdir} from 'node:fs/promises';
import {readDurableRecord,saveDurable} from './private-record.js';
import {configurationCandidate} from './config.js';
import {validateResearch,ResearchFailure} from './analyzer/backend.js';
import {CodexTokenLimit,researchBudget} from './analyzer/budget.js';
import {quoteShell as quote} from './shell-command.js';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import type {SetupOptions,CheckKind,SetupPlan} from './types.js';
import type {AnalysisBackend,ResearchResult} from './analyzer/backend.js';
import {scanRepository,repositoryReader} from './analyzer/repository.js';
import {hostBackend} from './analyzer/host.js';
import {nativeBackend} from './analyzer/anthropic.js';
import {openAICompatibleBackend} from './analyzer/openai-compatible.js';
import type {ResearchProvider} from './research/provider-settings.js';
import {codexBackend} from './analyzer/codex.js';
import {PROMPT_VERSION} from './analyzer/prompts.js';
import {READ_POLICY_VERSION} from './analyzer/read-policy.js';
import {generate,generateFoundation,inventorySignature,prepareGeneration} from './generator/generate.js';
import {sourceGuidance} from './generator/harness.js';
import {STAGE_EVIDENCE_POLICY} from './analyzer/stage-context.js';
import {DOCUMENT_POLICY_VERSION} from './generator/document-policy.js';
import {TEMPLATE_VERSION} from './generator/render.js';
import {privateDirectory,signature,readCache,saveCache} from './generator/cache.js';
import {applyRecordPath,loadManifest,readApplyRecord,sourceReview} from './installer/baseline.js';
import {acquireLock,defaultStateRoot} from './installer/lock.js';
import {assertNoUnknownWriters} from './installer/operations.js';
import {installationInput,preview,loadPreview,restoredReviewMatches,type Preview,type PreviewData} from './installer/preview.js';
import {sessionHandoffRequired} from './installer/session.js';
import {readTarget,absentDigest} from './installer/preview.js';
import {digest} from './analyzer/evidence.js';
import {apply,interruptedApplyId,interruptedSeedApplyId,restoreInterruptedPreview,type CheckResult} from './installer/apply.js';
export interface LifecycleFlags {deferResearch?:boolean;foundationOnly?:boolean;dryRun?:boolean;yes?:boolean;review?:boolean;response?:string;request?:string;sessionsEnded?:boolean;resume?:boolean;continuation?:string;retireIds?:string[];runChecks?:CheckKind[];configure?:boolean;researchTokens?:number}
export interface LifecycleServices {backend?:AnalysisBackend;credentials?:{apiKey?:string;model?:string};provider?:ResearchProvider;isTTY?:boolean;clock?:()=>number;cacheRoot?:string;stateRoot?:string;signal?:AbortSignal;runChecks?:()=>Promise<CheckResult[]>;confirmPreview?:()=>Promise<boolean>;report?:(value:Record<string,unknown>)=>void;researchSessionId?:string;expectedFingerprint?:string}
interface Run {root:string;options:SetupOptions;effectiveModel?:SetupOptions['model'];mode:LifecycleFlags;runId:string;research?:ResearchResult;researchTokens?:number;spent:{calls:number;tokens:number|'unknown'};readSpent?:{calls:number;bytes:number};consent:string;versions?:SetupPlan['versions']}
async function readRun(path:string,root:string,consent:string):Promise<Run|undefined>{
 const run=await readDurableRecord<Run>(path,'Durable research run');
 if(!run)return;
 if(run.root!==root||run.consent!==consent||typeof run.runId!=='string'||!run.runId||!run.spent||!Number.isSafeInteger(run.spent.calls)||run.spent.calls<0||run.spent.tokens!=='unknown'&&(!Number.isSafeInteger(run.spent.tokens)||run.spent.tokens<0))throw Error('durable research run invalid; reconciliation required');
 if(run.researchTokens!==undefined&&(!Number.isSafeInteger(run.researchTokens)||run.researchTokens<1))throw Error('Durable research token limit invalid; reconciliation required');
 return run;
}
export async function executeLifecycle(root:string,options:SetupOptions,flags:LifecycleFlags,write:(s:string)=>void,services:LifecycleServices={}):Promise<number>{
 if(!options.agents.length){write('agents: choose at least one native host before research\n');services.report?.({phase:'preflight',installStatus:'pending',requiredInput:[{field:'agents',sources:['project configuration','selected profile','CLI overrides'],provide:'--agents codex (or another supported host)'}]});return 3;}
 const wantsRules=options.projectRules??!!options.sdd;
 const foundationOnly=flags.deferResearch||flags.foundationOnly;
 const needsResearch=wantsRules&&!foundationOnly;
 if(foundationOnly&&(!wantsRules||flags.request||flags.response||flags.continuation))throw Error('Deferred research requires initial setup for project rules');
 const budget=researchBudget(options);
 const backendKind=services.researchSessionId?'host':services.provider?'native':options.backend;
 const providerKind=services.provider?.identity.provider??options.model?.provider??'anthropic';
 const openAI=providerKind==='openai-compatible';
 const apiKeyEnv=services.provider?.identity.apiKeyEnv??options.model?.apiKeyEnv??(openAI?'OPENAI_API_KEY':'ANTHROPIC_API_KEY');
 const model=services.provider?.identity.model??options.model?.model??services.credentials?.model??process.env[openAI?'OPENAI_MODEL':'ANTHROPIC_MODEL'];
 const apiKey=services.provider?.apiKey??services.credentials?.apiKey??process.env[apiKeyEnv];
 const baseURL=services.provider?.baseURL??(openAI?process.env.OPENAI_BASE_URL:undefined);
 const effectiveModel:SetupOptions['model']=backendKind==='native'&&needsResearch&&model?{provider:providerKind,model,apiKeyEnv}:undefined;
 const researchSessionId=services.researchSessionId??(services.provider?signature({baseURL}):undefined);
 const lock=await acquireLock(root,{stateRoot:services.stateRoot,recover:flags.resume});
 const phases=[...(needsResearch?['research']:[]),'generation','preview',...(!flags.dryRun?['apply']:[])];
 const progress=createProgressReporter({runId:lock.id,phases,isTTY:!!services.isTTY,write,clock:services.clock});let active:RunProgressEvent={stage:phases[0],task:'bounded source scan',completed:0,next:'prepare selected integrations'};const emit=(event:RunProgressEvent)=>{active=event;progress.event(event);};emit(active);
 const heartbeat=setInterval(()=>progress.tick(),1000);heartbeat.unref();
 let review=flags.review||flags.deferResearch;
 let researchResumeId:string|undefined;
 const handoff=async(result:Preview,interrupted=false):Promise<boolean>=>{
  const affected=await sessionHandoffRequired(root,flags.sessionsEnded);
  if(!interrupted&&!affected&&(!review||await services.confirmPreview?.()))return false;
  const nextCommand='rigup update '+quote(root)+' --apply '+result.previewId+' --sessions-ended'+(flags.resume?' --resume':'');
  emit({stage:'apply',completed:0,status:'waiting',requiresUserAction:true,waiting:'review / affected host session exit',next:'independent terminal apply'});services.report?.({phase:'handoff',installStatus:'pending',...result,pending:['End affected sessions / review the concrete preview'],nextCommand});write('Pending review/session handoff. End affected sessions, then run from an independent terminal:\n'+nextCommand+'\n');return true;
 };

 try {
  await assertNoUnknownWriters(root,lock.stateRoot);
  const seedApply=await interruptedSeedApplyId(root,lock.stateRoot);
  if(seedApply&&(!flags.resume||flags.continuation||flags.researchTokens!==undefined||services.researchSessionId)){
   const nextCommand='rigup update '+quote(root)+' --resume --review';
   const message='Reconcile the interrupted customer document creation using the original approval.';
   services.report?.({phase:'preflight',installStatus:'pending',reason:'interrupted-install',interruptedPreviewId:seedApply,pending:[message],nextCommand});
   write(message+'\n'+nextCommand+'\n');
   return 3;
  }
  const base=await privateDirectory(services.cacheRoot??join(homedir(),'.cache','rigup'),root);
  const cache=await privateDirectory(join(base,'generation'),root);const requests=await privateDirectory(join(base,'host'),root);const previews=await privateDirectory(join(base,'previews'),root);const runs=await privateDirectory(join(lock.stateRoot,'runs'),root);
  if(flags.continuation||flags.researchTokens!==undefined){
   const interrupted=await interruptedApplyId(root,lock.stateRoot);
   if(interrupted){
    const message='Finish or reconcile interrupted installation '+interrupted+' with its original approval before continuing research';
    emit({...active,status:'waiting',requiresUserAction:true,waiting:'interrupted installation',next:'reconcile the approved apply'});
    services.report?.({phase:'preflight',installStatus:'pending',reason:'interrupted-install',interruptedPreviewId:interrupted,pending:[message]});
    write(message+'\n');return 3;
   }
  }else if(flags.resume){
   if(services.researchSessionId&&await interruptedApplyId(root,lock.stateRoot))throw Error('Resume the interrupted installation from the CLI before starting research');
   const interrupted=await restoreInterruptedPreview(root,options,previews,lock.stateRoot);if(interrupted){
   const restored=(await loadPreview(interrupted,previews)).preview;
   if(flags.deferResearch&&restored.projectRules!=='pending')throw Error('Interrupted preview belongs to full setup; resume without --defer-research');
   if(restored.projectRules==='pending'||(await loadManifest(root))?.projectRules==='pending')review=true;
   if(flags.dryRun){services.report?.({phase:'preview',...restored,installStatus:'pending',message:'Durable interrupted preview restored. Run resume with --review for the apply command.'});return 3;}
   if(await handoff(restored,!!flags.review))return 3;
   const installed=await apply(interrupted,{cacheRoot:previews,stateRoot:lock.stateRoot,lock,recover:true,signal:services.signal,onProgress:emit,runChecks:services.runChecks});
   services.report?.({phase:'apply',installStatus:installed.status,...installed});
   if(installed.nextCommand)write((installed.researchNextStep??'Project rules pending.')+'\n'+installed.nextCommand+'\n');
   write('Resumed protected installation '+installed.status+'\n');
   return installed.exitCode;
  }}
  if(needsResearch&&backendKind==='native'&&!services.backend&&(!model||!apiKey)){write('model: model ID and API-key environment reference required before research\n');services.report?.({phase:'preflight',installStatus:'pending',requiredInput:[{field:'model',sources:['effective configuration','provider model environment variable','API-key environment reference'],provide:'Configure a model ID and set the referenced variable outside project configuration'}]});return 3;}
  const [profile,old,config]=await Promise.all([scanRepository(root,options),loadManifest(root),readTarget(root,'.rigup/config.yaml')]);
  if(services.expectedFingerprint&&profile.fingerprint!==services.expectedFingerprint)throw Error('Project source changed. Begin a new research run.');
  profile.installedTools=old?.installedTools;
  profile.initializedTools=old?.initializedTools;
  if(flags.deferResearch&&old)throw Error('Deferred research is available for initial setup only');
  const authorityReview=await sourceReview(root,old,lock.stateRoot);
  if(old?.projectRules==='pending'||authorityReview)review=true;
  const prepared=await prepareGeneration(profile,options);
  const recovery=prepared.integration.requirements.find(requirement=>requirement.nextCommand);
  const nativeSetup=recovery?.nextCommand?{nativeSetupCommand:recovery.nextCommand,nativeRequirements:prepared.integration.requirements}:{};
  if(needsResearch&&!services.backend&&backendKind!=='host'&&recovery){
   emit({...active,status:'waiting',requiresUserAction:true,waiting:'native workflow setup',next:recovery.nextCommand});
   services.report?.({phase:'preflight',installStatus:'pending',pending:prepared.integration.requirements,nextCommand:recovery.nextCommand});
   write('Blocked: '+recovery.reason+'\nInitialize the native workflow, then repeat the Rigup command:\n'+recovery.nextCommand+'\n');return 3;
  }
  if(needsResearch&&backendKind==='host'&&recovery)write('Native workflow must be initialized before apply:\n'+recovery.nextCommand+'\n');
  let plan:SetupPlan;
 let restoredReview:PreviewData|undefined;
  if(foundationOnly){
   emit({stage:'generation',completed:0,task:'assemble project workflow',next:'preview'});
   const previousAssets=(old?.assets??[]).filter(asset=>asset.logicalId!=='rigup:configuration');
   const preserveWorkflowContext=old?.projectRules==='ready'&&old.options?.sdd===options.sdd&&signature(old.options?.agents??[])===signature(options.agents)&&signature(old.options?.customSkills??[])===signature(options.customSkills??[]);
   let previousGuidance:import('./generator/project-rules.js').GuidanceBinding[]=[];
   if(preserveWorkflowContext&&signature(old?.options??null)===signature(options)){
    const tx=await readApplyRecord(applyRecordPath(root,lock.stateRoot)),approved=tx?.preview;
    if(tx?.status==='complete'&&tx.installId===old?.installId&&approved&&approved.digest===signature(approved.data)){
     const {data}=approved;
     const targets=data.files.map(file=>file.target);
     const versions={prompt:PROMPT_VERSION,template:TEMPLATE_VERSION,document:DOCUMENT_POLICY_VERSION,read:READ_POLICY_VERSION};
     const reusable=data.inputSnapshotVersion===3&&(authorityReview?
      data.plan.projectRules==='ready'&&signature(data.plan.versions)===signature(versions)&&await restoredReviewMatches(root,data).catch(()=>false):
      await installationInput(root,data.plan,targets).catch(()=>undefined)===data.inputSnapshot);
     if(reusable){
      if(authorityReview)restoredReview=data;
      previousGuidance=tx.report?.harness?.guidance.filter(binding=>binding.sourceRef&&!targets.includes(binding.sourceRef.path)&&
       ['reusable','partial','conflicting','unavailable'].includes(binding.coverageStatus))??[];
     }
    }
   }
   plan=await generateFoundation(profile,options,prepared,previousAssets,preserveWorkflowContext,previousGuidance);
   if(authorityReview&&!restoredReview)plan.projectRules='pending';
  }else{
   const authority=sourceGuidance(profile,options);
   const scopedAuthority=authority.length?{sourceGuidance:authority}:{};
   const input={root,options,...scopedAuthority,effectiveModel,configDigest:config?digest(config):absentDigest,retireIds:flags.retireIds??[],runChecks:flags.runChecks??[],configure:!!flags.configure,executionMode:flags.dryRun?'dry-run':review?'review':'continuous',fingerprint:profile.fingerprint,researchSessionId};
   const versions={prompt:PROMPT_VERSION,template:TEMPLATE_VERSION,document:DOCUMENT_POLICY_VERSION,read:READ_POLICY_VERSION};
   const consent=signature({...input,versions});
   if(flags.continuation&&flags.continuation!==consent)throw new Error('continuation input/configuration changed; restart preparation');
   const savedRun=async(id:string)=>await readRun(join(runs,id+'.json'),root,id)??await readRun(join(base,'runs',id+'.json'),root,id);
   const runPath=join(runs,consent+'.json');let run=await savedRun(consent);
   if(!run&&flags.resume&&options.sdd){
    // Older evidence and discovery contracts use different consent keys for the same project.
    const priorContracts=[
     {versions:{prompt:'7',template:'2',document:'1',read:'6'},label:'single-document evidence contract',build:'the previous Rigup build'},
     {versions:{prompt:'8',template:'2',document:'1',read:'6'},label:'previous topic evidence contract',build:'the previous Rigup build'},
     {versions:{prompt:'9',template:'2',document:'1',read:'6'},label:'previous evidence and template contract',build:'the previous Rigup build'},
     {versions:{prompt:'10',template:'3',document:'1',read:'6'},label:'v0.2.0 evidence and template contract',build:'v0.2.0'},
     {versions:{prompt:'10',template:'4',document:'1',read:'6'},label:'v0.2.1 evidence and template contract',build:'v0.2.1'},
     {versions:{...versions,prompt:'10'},label:'v0.2.4 research prompt',build:'v0.2.4'},
    ];
    const priorFingerprint=options.sdd==='openspec'?(await scanRepository(root,options,{requiredOpenSpecEntriesOnly:true})).fingerprint:input.fingerprint;
    const candidates=priorFingerprint===input.fingerprint?[input]:[input,{...input,fingerprint:priorFingerprint}];
    for(const previousInput of candidates){
     for(const previous of priorContracts){
      if(await savedRun(signature({...previousInput,versions:previous.versions})))throw Error('Saved research uses the '+previous.label+'. Resume or reconcile it with '+previous.build+', or explicitly start a new preview without --resume.');
     }
    }
    if(priorFingerprint!==input.fingerprint&&await savedRun(signature({...input,fingerprint:priorFingerprint,versions})))throw Error('Saved research uses the previous OpenSpec discovery contract. Resume or reconcile it with the previous Rigup build, or explicitly start a new preview without --resume.');
   }
   if(!run&&flags.resume&&needsResearch&&!services.researchSessionId){
    for(const directory of new Set([runs,join(base,'runs')])){
     const entries=await readdir(directory).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
     for(const file of entries.filter(name=>/^[a-f0-9]{64}\.json$/.test(name))){
      const prior=await readDurableRecord<Run>(join(directory,file),'Durable research run').catch(()=>undefined);
      if(prior?.root!==root||!prior.options||signature(prior.options)!==signature(options)||!prior.spent?.calls)continue;
      if(signature(prior.versions??null)!==signature(versions))throw Error('Saved research uses an earlier evidence contract. Resume with its original Rigup version or explicitly start a new review without --resume.');
     }
    }
   }
   if(!run)run={root,options,effectiveModel,mode:{dryRun:flags.dryRun,yes:!review&&flags.yes,review,retireIds:flags.retireIds,runChecks:flags.runChecks,configure:flags.configure},runId:randomUUID(),spent:{calls:0,tokens:0},consent,versions};
   if(signature(run.options)!==signature(options))throw Error('durable research options changed; reconciliation required');
   if(flags.researchTokens!==undefined)run.researchTokens=flags.researchTokens;
   await saveDurable(runPath,JSON.stringify(run));researchResumeId=consent;let responseConsumed=false;
   const continuation=(requestPath:string)=>'rigup update '+quote(root)+' --continue '+consent+' --response '+quote(requestPath.replace(/(?:\.request)?\.json$/,'.response.json'));
   run.readSpent??={calls:0,bytes:0};const reader=await repositoryReader(root,options,{budget:run.readSpent,persist:()=>saveDurable(runPath,JSON.stringify(run)),expectedFingerprint:profile.fingerprint});
   const durableNative=!services.backend&&backendKind==='native';let activeNativeBase=run.spent;
   const providerBackend=openAI?openAICompatibleBackend:nativeBackend;
   const rawBackend:AnalysisBackend=services.backend??(backendKind==='host'?{artifactContextVersion:STAGE_EVIDENCE_POLICY,run:async(request,reader)=>{
    if(flags.response&&!responseConsumed){
     const response=JSON.parse(await readFile(flags.response,'utf8'));if(typeof response.requestId!=='string'||!/^[a-f0-9]{64}$/.test(response.requestId))throw new Error('host response request identity invalid');
     const original=await readCache<any>(join(requests,response.requestId+'.request.json'));if(!original)throw new Error('original host request missing');
     const common=(value:Record<string,unknown>)=>{const {kind,artifact,expectedOutput,input,spent,...rest}=value;return {...rest,promptVersion:PROMPT_VERSION,readPolicyVersion:READ_POLICY_VERSION};};
     if(signature(common(original.context))!==signature(common(request as unknown as Record<string,unknown>)))throw new Error('host response does not match current run context');
     const accepted=await readCache<any>(join(requests,response.requestId+'.accepted.json'));
     if(accepted){await hostBackend({cacheRoot:requests,responsePath:flags.response}).run(original.context,reader);responseConsumed=true;}
    }
    const result=await hostBackend({cacheRoot:requests,requestPath:responseConsumed?undefined:flags.request,responsePath:responseConsumed?undefined:flags.response}).run(request,reader);if(result.status==='complete'&&flags.response)responseConsumed=true;return result;
   }}:backendKind==='codex'?codexBackend({cacheRoot:join(base,'codex'),stateRoot:join(lock.stateRoot,'codex'),nativeEntryPaths:prepared.integration.bindings.flatMap(binding=>binding.projectSources??[]),signal:services.signal,tokenLimit:run.researchTokens,onDispatch:stage=>emit({...active,task:stage==='analyze'?'project evidence analysis':active.task,waiting:'Codex model response',next:'validate '+stage+' result'}),onUsage:async usage=>{run.spent=usage;await saveDurable(runPath,JSON.stringify(run));}}):providerBackend({apiKey,model,baseURL,signal:services.signal,onUsage:async usage=>{run.spent={calls:activeNativeBase.calls+usage.calls,tokens:activeNativeBase.tokens==='unknown'||usage.tokens==='unknown'?'unknown':activeNativeBase.tokens+usage.tokens};await saveDurable(runPath,JSON.stringify(run));}}));
   const addUsage=async(usage:{calls:number|'unknown';tokens:number|'unknown'})=>{run.spent={calls:run.spent.calls+(typeof usage.calls==='number'?usage.calls:1),tokens:run.spent.tokens==='unknown'||usage.tokens==='unknown'?'unknown':run.spent.tokens+usage.tokens};await saveDurable(runPath,JSON.stringify(run));};
   const backend:AnalysisBackend=backendKind==='native'||backendKind==='codex'&&!!services.backend?{artifactContextVersion:rawBackend.artifactContextVersion,topicEvidence:rawBackend.topicEvidence,run:async(request,source)=>{
    if(run.spent.calls>=budget.maxCalls||run.spent.tokens==='unknown'||run.spent.tokens>=budget.maxTokens)throw new ResearchFailure('restored research budget exhausted or unknown');
    activeNativeBase=run.spent;
    try{const result=await rawBackend.run({...request,spent:run.spent},source);if(result.status==='complete'&&!durableNative)await addUsage(result.value.usage);return result;}
    catch(error){if(!durableNative&&error instanceof ResearchFailure&&error.usage)await addUsage(error.usage);throw error;}
   }}:rawBackend;
   const previousAssets=(old?.assets??[]).filter(a=>a.logicalId!=='rigup:configuration');
   const analysisPath=join(runs,signature({kind:'analysis',root,fingerprint:profile.fingerprint,options,...scopedAuthority,effectiveModel,templates:signature(prepared.integration.assets),prompt:PROMPT_VERSION,read:READ_POLICY_VERSION,template:TEMPLATE_VERSION,document:DOCUMENT_POLICY_VERSION,researchSessionId})+'.analysis.json');
   if(needsResearch&&!run.research){const cached=await readCache<ResearchResult>(analysisPath);if(cached){try{await validateResearch(cached.data,reader);run.research=cached;write('Research: reuse accepted evidence for unchanged inputs\n');}catch{/* Invalidated accepted evidence is researched again. */}}}
   let newResearch=false;
   if(needsResearch&&!run.research){
    newResearch=true;write('Research: reading bounded project evidence\n');
    if(backendKind!=='codex'||services.backend)emit({...active,task:'project evidence analysis',waiting:backendKind==='host'?'host research exchange':'provider response or evidence requests',next:'validate analysis result'});
    const result=await backend.run({kind:'analyze',runId:run.runId,root,fingerprint:profile.fingerprint,options,...scopedAuthority,effectiveModel,versions:{prompt:PROMPT_VERSION,template:TEMPLATE_VERSION,document:DOCUMENT_POLICY_VERSION,read:READ_POLICY_VERSION},budget,previousInventoryDigest:inventorySignature(previousAssets),templateSourcesDigest:signature(prepared.integration.assets)},reader);
    if(result.status==='pending-host'){emit({stage:'research',completed:0,status:'waiting',requiresUserAction:true,waiting:'host response',next:continuation(result.requestPath)});services.report?.({phase:'research',installStatus:'pending',pending:[result.requestId],requestPath:result.requestPath,nextCommand:continuation(result.requestPath),...nativeSetup});write('Pending host research: '+result.requestPath+'\nResume: '+continuation(result.requestPath)+'\n');return 3;}
    run.research=result.value;await saveCache(analysisPath,JSON.stringify(result.value));if(backendKind==='host')run.spent={calls:typeof result.value.usage.calls==='number'?result.value.usage.calls:1,tokens:result.value.usage.tokens};await saveDurable(runPath,JSON.stringify(run));
   }
   if(needsResearch)emit({stage:'research',completed:1,total:1,status:newResearch?'complete':'reused',next:'generation'});
   profile.research=run.research;emit({stage:'generation',completed:0,task:'artifact planning and fixed assets',next:'preview',waiting:backendKind==='codex'?'local Codex research':backendKind==='native'?'provider research':'local preparation / host response'});write('Generate: assembling selected capabilities\n');
   const generationRoot=services.researchSessionId?join(lock.stateRoot,'mcp-generation',services.researchSessionId):researchSessionId?join(cache,researchSessionId):cache;
   const generated=await generate(profile,options,backend,previousAssets,{cacheRoot:generationRoot,save:services.researchSessionId?saveDurable:undefined,runId:run.runId,spent:run.spent,onProgress:emit,reader,effectiveModel,prepared});
   if(generated.status==='pending-host'){emit({...active,status:'waiting',requiresUserAction:true,waiting:'host response',next:continuation(generated.requestPath)});services.report?.({phase:'generation',installStatus:'pending',pending:[generated.requestId],requestPath:generated.requestPath,nextCommand:continuation(generated.requestPath),...nativeSetup});write('Pending host generation: '+generated.requestPath+'\nResume: '+continuation(generated.requestPath)+'\n');return 3;}
   plan=generated.value;
  }
  const oldConfiguration=old?.assets.find(a=>a.logicalId==='rigup:configuration');
  if(oldConfiguration)plan.dispositions.push({logicalId:oldConfiguration.logicalId,action:flags.configure?'update':'retain',reason:flags.configure?'Explicit configuration change':'Preserve configuration ownership and original baseline'});
  const resolutions:import('./installer/preview.js').PreviewResolution[]=[];
  if(flags.configure){const candidate=await configurationCandidate(root,options);plan.assets.push(candidate);const raw=await readTarget(root,candidate.target);resolutions.push({target:candidate.target,selector:candidate.ownership,observedDigest:raw?digest(raw):absentDigest,action:'replace'});}
  for(const id of flags.retireIds??[]){const disposition=plan.dispositions.find(d=>d.logicalId===id);if(!disposition)throw new Error('retirement id not in old inventory');if(plan.assets.some(a=>a.logicalId===id))throw new Error('retirement contradicts selected capability');disposition.action='retire';disposition.reason='Explicit retirement authorized before research';}
  for(const d of plan.dispositions)if(d.action==='retire'&&!flags.retireIds?.includes(d.logicalId))plan.requirements.push({integrationId:d.logicalId,reason:'Retirement is outside current consent; rerun with --retire '+d.logicalId});
  emit({stage:'generation',unit:'assets',task:'fixed assembly',completed:plan.assets.length,total:plan.assets.length,status:'complete',next:'preview'});emit({stage:'preview',completed:0,waiting:'ownership and virtual-tree checks'});
  plan.runChecks=flags.runChecks??[];
  if(authorityReview&&profile.truncated)plan.projectRules='pending';
  const result=await preview(plan,resolutions,{cacheRoot:previews,stateRoot:lock.stateRoot,skipUnchanged:!!flags.review&&!flags.dryRun&&!services.runChecks&&!await interruptedApplyId(root,lock.stateRoot),reviewEntryBlocks:!!old&&!!flags.review,restoredReview});
  if(plan.gitlabReviewRequired)for(const warning of result.warnings)if(warning.startsWith('GitLab wiring'))write(warning+'\n');
  if(result.noChanges){
   emit({stage:'preview',completed:result.items.length,total:result.items.length,status:'complete'});
   const {previewId,...summary}=result;
   if(options.projectRules&&result.projectRules==='pending'){
    const message='Open the project in a selected agent and call rigup_begin, or configure a CLI provider and retry with --review.';
    services.report?.({...summary,phase:'research',installStatus:'pending',researchNextStep:message});
    write(message+'\n');
    return 3;
   }
   services.report?.({...summary,phase:'preview',installStatus:'up-to-date'});
   write('Installation is up to date.\n');
   return 0;
  }
  const conflicts=result.items.filter(i=>i.action==='conflict');
  const failed=!result.executable&&(conflicts.length>0||!plan.requirements.length);
  const reviewCommand=old&&conflicts.length?'rigup update '+quote(root)+' --review':undefined;
  const nextCommand=reviewCommand??recovery?.nextCommand;
  const installStatus=conflicts.length?'conflict':failed?'failed':result.executable?'not-installed':'pending';
  services.report?.({phase:'preview',installStatus,...result,pending:plan.requirements,conflicts,nextCommand:nextCommand??null,...(failed?{error:result.blockers.join('\n')}:{})});
  write('Preview '+result.previewId+'\n');for(const item of result.items){write(item.action+' '+item.target+(item.reason?' — '+item.reason:'')+'\n');if(item.beforeMode!==item.afterMode){const format=(value:number|undefined)=>value===undefined?'absent':value.toString(8).padStart(4,'0');write('mode '+format(item.beforeMode)+' -> '+format(item.afterMode)+'\n');}if(item.before!==undefined)write('--- owned before (filtered, max 4000 chars)\n'+item.before+'\n');if(item.after!==undefined)write('+++ owned after (filtered, max 4000 chars)\n'+item.after+'\n');}for(const operation of result.operations)write('operation '+operation.id+' '+operation.version+' scope '+operation.declaredWrites.join(', ')+'\n');
  for(const document of result.projectDocuments??[])write(document.action+' '+document.target+' — '+document.reason+'\n');
  for(const blocker of result.blockers)write('Blocked: '+blocker+'\n');
  for(const requirement of plan.requirements)if(requirement.nextCommand)write('Initialize the native workflow, then repeat the Rigup command:\n'+requirement.nextCommand+'\n');
  if(reviewCommand)write('After resolving the conflicts, run:\n'+reviewCommand+'\n');
  if(!result.executable){
   emit({stage:'preview',completed:result.items.length,total:result.items.length,status:failed?'failed':'waiting',requiresUserAction:true,next:'resolve blockers and review again'});
   return failed?1:3;
  }
  emit({stage:'preview',completed:result.items.length,total:result.items.length,status:'complete',next:flags.dryRun?'dry-run preview finished; not installed':'apply'});
  if(flags.dryRun)return 0;
  if(await handoff(result))return 3;
  const installed=await apply(result.previewId,{cacheRoot:previews,stateRoot:lock.stateRoot,lock,onProgress:emit,recover:flags.resume,signal:services.signal,runChecks:services.runChecks});
  services.report?.({phase:'apply',installStatus:installed.status,...installed});
  for(const warning of installed.warnings)write('Pending/note: '+warning+'\n');
  if(installed.nextCommand)write((installed.researchNextStep??'工作流已可用。重开 agent 后用 change-prepare 发起提案。可选的项目规则生成命令：')+'\n'+installed.nextCommand+'\n');
  write('Install '+installed.status+'; written '+installed.written.length+'; checks '+installed.checks.map(c=>c.name+':'+c.status).join(', ')+'\n');return installed.exitCode;
 }catch(error){
  if(error instanceof CodexTokenLimit&&researchResumeId){
   const suggestedLimit=Math.max(budget.maxTokens,error.suggestedLimit);
   const nextCommand='rigup update '+quote(root)+' --continue '+researchResumeId+' --research-tokens '+suggestedLimit;
   emit({...active,status:'waiting',requiresUserAction:true,waiting:'research budget approval',next:nextCommand});
   services.report?.({phase:active.stage,installStatus:'pending',error:error.message,reason:'research-token-budget',researchBudget:{spentTokens:error.spent,limit:error.limit,estimatedNextTokens:error.estimatedNext,suggestedLimit},nextCommand});
   write(error.message+'\nReview the suggested cumulative limit and continue this same run:\n'+nextCommand+'\n');return 3;
  }
  emit({...active,status:services.signal?.aborted?'waiting':'failed',requiresUserAction:!!services.signal?.aborted,waiting:services.signal?.aborted?'cancelled; writer exit reconciliation':'failure; inspect final report',next:'re-prepare with current inputs'});throw error;}finally{clearInterval(heartbeat);await lock.release();}
}

export async function loadContinuation(root:string,id:string,services:LifecycleServices={}):Promise<{options:SetupOptions;flags:LifecycleFlags}>{
 if(!/^[a-f0-9]{64}$/.test(id))throw new Error('continuation id invalid');
 const state=await privateDirectory(services.stateRoot??defaultStateRoot(),root);const base=await privateDirectory(services.cacheRoot??join(homedir(),'.cache','rigup'),root);const run=await readRun(join(state,'runs',id+'.json'),root,id)??await readRun(join(base,'runs',id+'.json'),root,id);
 if(!run||run.root!==root||run.consent!==id)throw new Error('continuation missing; restart preparation');return {options:run.options,flags:{...run.mode,continuation:id}};
}
