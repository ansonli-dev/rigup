import type {RunProgressEvent} from '../progress.js';
import {prepareIntegrations} from '../integrations/registry.js';
import {assertToolOperationRecipe,toolOperationIdentity,toolOperationPrerequisites,verifiedToolOperationForResume,type NativeTool} from '../integrations/tools/recipes.js';
import {readVerifiedToolInstall} from '../integrations/tools/installed-state.js';
import {verifyToolInitializationReceipt} from '../integrations/tools/native-state.js';
import {defaultNpmRegistry} from '../integrations/tools/npm-resolution.js';
import {openwikiInitializationGuide} from '../integrations/tools/openwiki.js';
import {PROMPT_VERSION} from '../analyzer/prompts.js';
import {READ_POLICY_VERSION} from '../analyzer/read-policy.js';
import {TEMPLATE_VERSION} from '../generator/render.js';
import {DOCUMENT_POLICY_VERSION} from '../generator/document-policy.js';
import {isRecord,saveDurable} from '../private-record.js';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {lstat,unlink} from 'node:fs/promises';
import {resolveAuthorityTarget} from './approved-input.js';
import {readFileState,readFileStates,matchesFileState,platformFileMode} from './file-state.js';
import type {CommandSpec,SetupOptions,SetupPlan} from '../types.js';
import {loadPreview,readTarget,approvalInputChange,verifyFreshPreview,unchangedInstallation,absentDigest,assertPreviewIdentity,LegacyPreviewError,type PreviewData} from './preview.js';
import {acquireLock,defaultStateRoot,type ProjectLock} from './lock.js';
import {assertNoUnknownWriters,operationExecutor,pendingOperations,queryOperation,type OperationDependencies,type OperationResult} from './operations.js';
import {privateDirectory,signature,saveCache} from '../generator/cache.js';
import {digest} from '../analyzer/evidence.js';
import {scanRepository} from '../analyzer/repository.js';
import {atomicProjectWrite,ExclusiveLinkError} from './manifest.js';
import {targetPath,ownedContent} from './ownership.js';
import {applyRecordPath,loadManifest,readApplyRecord,sourceReview,type Manifest,type SourceReview,type Transaction} from './baseline.js';
import {runProjectChecks,runResolvedProjectChecks} from '../integrations/tools/quality.js';
import {quoteShell} from '../shell-command.js';
import {conventionKey,isConventionScope,validateConventionReceipts} from '../project-conventions.js';
import {projectInput} from '../managed-input.js';
import {applyRuntimeInputs,operationNpmRegistry,type RuntimeSetupSummary} from '../runtime-inputs.js';
import {RIGUP_VERSION} from '../version.js';
import {normalizeNpmIntegrity} from '../npm-integrity.mjs';
import {queryGlobalNpmInstall} from '../integrations/tools/global-npm.js';
import {consumerPath,findProgram,programIdentity} from '../integrations/tools/global-npm-runtime.js';
export interface CheckResult {status:'passed'|'failed'|'pending';name:string;message?:string;command?:CommandSpec;fingerprint?:string;commit?:string;startedAt?:string;finishedAt?:string;durationMs?:number;diagnostic?:{rule:string;path:string;relatedPath:string};environment?:{node:string;platform:string};exitCode?:number}
export interface InstallReport {runtimeSetup?:RuntimeSetupSummary;projectRules?:SetupPlan['projectRules'];harness?:SetupPlan['harness'];sourceReview?:SourceReview;researchNextStep?:string;nextCommand?:string;status:'complete'|'failed'|'pending';exitCode:0|1|3|130;previewId:string;written:string[];operations:OperationResult[];checks:CheckResult[];warnings:string[]}
export interface ApplyDependencies {cacheRoot?:string;onProgress?:(event:RunProgressEvent)=>void;stateRoot?:string;lock?:ProjectLock;recover?:boolean;signal?:AbortSignal;hook?:(point:string)=>Promise<void>;runChecks?:()=>Promise<CheckResult[]>;operation?:OperationDependencies}
function previewFileTransitions(data:PreviewData):Transaction['files']{
 return Object.fromEntries(data.files.map(file=>{
  const after=file.next===undefined?absentDigest:digest(Buffer.from(file.next,file.encoding));
  return [file.target,{before:file.observedDigest,beforeMode:file.observedMode,after,afterMode:file.next===undefined?undefined:file.mode}];
 }));
}
const afterMode=(transition:Transaction['files'][string])=>transition.effectiveAfterMode??transition.afterMode;

function installedAsset(asset:Manifest['assets'][number],tx:Transaction){
 const effectiveMode=tx.files[asset.target]?.effectiveAfterMode;
 return {...asset,...(asset.mode!==undefined&&effectiveMode!==undefined?{effectiveMode}:{}),
  baseline:'.rigup/baseline/'+tx.installId+'/'+signature(asset.logicalId)};
}

async function provenSeed(root:string,target:string,stage:string|undefined){
 if(!stage)return false;
 try{
  const [file,staged]=await Promise.all([target,stage].map(async path=>lstat(await targetPath(root,path),{bigint:true})));
  return file.isFile()&&staged.isFile()&&file.ino!==0n&&file.ino===staged.ino&&file.dev===staged.dev;
 }catch{return false;}
}

async function seedApplied(root:string,target:string,tx:Transaction,actual:Awaited<ReturnType<typeof readFileState>>){
 const expected=tx.files[target],progress=tx.seedProgress?.[target],stage=tx.seedStages?.[target];
 if((!progress||progress==='started'&&tx.seedStages&&!stage)&&matchesFileState(actual,expected.before,expected.beforeMode))return false;
 if(matchesFileState(actual,expected.after,afterMode(expected))&&
    (progress==='written'||progress==='started'&&await provenSeed(root,target,stage)))return true;
 throw Error(seedReconciliation+' File: '+target);
}

function assertPreviewFileTransitions(tx:Transaction,data:PreviewData):void{
 const approved=Object.fromEntries(Object.entries(tx.files).map(([target,{effectiveAfterMode,...transition}])=>[target,transition]));
 if(signature(approved)!==signature(previewFileTransitions(data)))throw Error('Durable apply record differs from the approved preview; reconciliation required');
 if([...Object.keys(tx.seedProgress??{}),...Object.keys(tx.seedStages??{})].some(target=>!data.files.some(file=>file.target===target&&file.seed)))throw Error('Durable seed progress differs from the approved preview; reconciliation required');
}
export async function interruptedApplyId(root:string,stateRoot:string):Promise<string|undefined>{
 const tx=await readApplyRecord(applyRecordPath(root,stateRoot));
 return tx?.status==='prepared'?tx.previewId:undefined;
}
export async function interruptedSeedApplyId(root:string,stateRoot=defaultStateRoot()):Promise<string|undefined>{
 const tx=await readApplyRecord(applyRecordPath(root,stateRoot));
 return tx?.status==='prepared'&&Object.keys(tx.seedProgress??{}).length?tx.previewId:undefined;
}
export async function interruptedInstallApplyId(root:string,stateRoot=defaultStateRoot()):Promise<string|undefined>{
 const tx=await readApplyRecord(applyRecordPath(root,stateRoot));
 if(tx?.status==='prepared'&&tx.preview?.data.plan.operations.some(operation=>operation.global))return tx.previewId;
 const records=await pendingOperations(root,stateRoot);
 let owner:string|undefined;
 for(const record of records){
  if(record.operation.kind!=='install'||record.operation.integrationId==='openspec'||record.stage==='prepared'&&!record.installStage)continue;
  if(tx?.status==='prepared'&&record.authorizationRef===tx.previewId)owner=tx.previewId;
  else if(record.result?.status!=='done')throw Error('Unreconciled '+record.operation.id+' staging has no matching apply transaction; reconcile the protected tool scope.');
 }
 return owner;
}
const upgradeReconciliation='Implementation version changed. Resume or reconcile the original approved installation with its Rigup version before upgrading.';
const seedReconciliation='Customer document creation was interrupted. Resume the original approved preview or reconcile the customer document manually.';
function approvedInterruptedPreview(root:string,tx:Transaction):NonNullable<Transaction['preview']>{
 const stored=tx.preview;
 if(!stored?.data?.plan||!isRecord(stored.data.plan.options)||!Array.isArray(stored.data.plan.options.agents)||!Array.isArray(stored.data.files)||
  !stored.data.preview||stored.digest!==signature(stored.data)||stored.data.plan.root!==root||!stored.data.preview.executable)throw Error('Durable interrupted preview unavailable or corrupted; manual reconciliation required');
 try{assertPreviewIdentity(stored.data,tx.previewId);}catch(error){if(error instanceof LegacyPreviewError)throw Error(upgradeReconciliation);throw error;}
 assertPreviewFileTransitions(tx,stored.data);
 return stored;
}
export async function interruptedApplyOptions(root:string,stateRoot=defaultStateRoot()):Promise<SetupOptions|undefined>{
 const state=await privateDirectory(stateRoot,root);
 const tx=await readApplyRecord(applyRecordPath(root,state));
 if(tx?.status==='prepared')return approvedInterruptedPreview(root,tx).data.plan.options;
}
export async function restoreInterruptedPreview(root:string,options:SetupOptions,cacheRoot:string,stateRoot:string):Promise<string|undefined>{
 const tx=await readApplyRecord(applyRecordPath(root,stateRoot));
 if(tx?.status!=='prepared')return;
 const stored=approvedInterruptedPreview(root,tx);
 if(stored.data.inputSnapshotVersion!==3&&stored.data.inputSnapshotVersion!==4)throw Error(upgradeReconciliation);
 if(signature(stored.data.plan.options)!==signature(options))throw Error('Interrupted installation options changed; resume with the original selection');
 await privateDirectory(cacheRoot,root);await saveCache(join(cacheRoot,tx.previewId+'.json'),JSON.stringify(stored));return tx.previewId;
}
export async function apply(previewId:string,dependencies:ApplyDependencies={}):Promise<InstallReport>{
 const data=await loadPreview(previewId,dependencies.cacheRoot);if(data.modePolicyVersion!==1)throw Error('permission preview version changed; regenerate preview without discarding durable state');if(!data.preview.executable)throw new Error('preview is blocked; prepare a new preview');
 const root=data.plan.root;const lock=dependencies.lock??await acquireLock(root,{stateRoot:dependencies.stateRoot,recover:dependencies.recover});
 if(lock.root!==root)throw new Error('execution lock root mismatch');
 const release=dependencies.lock?async()=>{}:()=>lock.release();
 let completed=0;const total=data.plan.operations.length+data.files.length+1;const step=(task:string,status:RunProgressEvent['status']='running')=>dependencies.onProgress?.({stage:'apply',unit:'steps',task,completed,total,status,next:'verify actual wiring and commit manifest'});step('preconditions');
 const rules=data.plan.projectRules?{projectRules:data.plan.projectRules}:{};
 const pendingRules=data.plan.projectRules==='pending'?{nextCommand:'rigup update '+quoteShell(root)+' --review',
  ...(data.plan.options.projectRules?{researchNextStep:'Reload the project in a selected agent and call rigup_begin with the project root, or configure a CLI provider and run the review command.'}:{})}:{};
 const report:InstallReport={...rules,...(data.preview.harness?{harness:data.preview.harness}:{}),status:'pending',exitCode:3,previewId,written:[],operations:[],checks:[],warnings:[...data.preview.warnings]};
 const globalOperations=data.plan.operations.flatMap(operation=>operation.global?[operation.global]:[]);
 const completedGlobals=new Map<string,OperationResult>();
 const reportedOperations=()=>[
  ...[...completedGlobals.values()].filter(result=>!report.operations.some(item=>item.globalReceipt?.approval===result.globalReceipt?.approval)),
  ...report.operations,
 ];
 const resumeCommand='rigup update '+quoteShell(root)+' --apply '+previewId+' --resume';
 const verifyGlobalInstalls=async(all=false)=>{
  for(const approval of globalOperations){
   const prior=completedGlobals.get(signature(approval));
   if(!prior&&!all)continue;
   const result=await queryGlobalNpmInstall(approval,lock.stateRoot);
   const path=await consumerPath(root);
   const selected=await findProgram(approval.bin,root,path).catch(()=>undefined);
   const receipt=result.globalReceipt;
   const launcherMatches=selected&&receipt&&(receipt.launcher
    ?(selected.launcher??selected.file)===receipt.launcher
    :!!receipt.launcherIdentity&&await programIdentity(selected,root,path).catch(()=>undefined)===receipt.launcherIdentity);
   if(!prior||result.status!=='done'||signature(receipt)!==signature(prior.globalReceipt)||!launcherMatches)
    throw Error('Approved global '+approval.id+' installation or PATH launcher changed. Restore the approved installation before resuming.');
  }
 };
 try {
  const statePath=applyRecordPath(root,lock.stateRoot);let tx=await readApplyRecord(statePath);
  if(tx?.previewId===previewId&&tx.preview?.digest===signature(data)){
   for(const result of tx.report?.operations??[]){
    const approval=result.globalReceipt?.approval;
    if(result.status==='done'&&approval&&globalOperations.some(value=>signature(value)===approval))completedGlobals.set(approval,result);
   }
  }
  if(tx?.status==='prepared'&&tx.previewId===previewId)approvedInterruptedPreview(root,tx);
  const restoringApproval=tx?.previewId===previewId&&tx.preview?.digest===signature(data);
  const versions={rigup:RIGUP_VERSION,prompt:PROMPT_VERSION,read:READ_POLICY_VERSION,template:TEMPLATE_VERSION,document:DOCUMENT_POLICY_VERSION};
  for(const [key,value] of Object.entries(versions)){
   const approved=data.plan.versions[key];
   if(approved===undefined||approved===value)continue;
   // These prompt revisions preserve the writes in a matching durable approval.
   if(restoringApproval&&(key==='prompt'&&(approved==='10'||approved==='12')||
      (key==='rigup'&&approved==='0.8.0'||key==='read'&&approved==='7')&&data.inputSnapshotVersion===3))continue;
   throw new Error(restoringApproval&&tx?.status==='prepared'?upgradeReconciliation:'implementation version changed; regenerate preview');
  }
  const interruptedInstall=await interruptedInstallApplyId(root,lock.stateRoot);
  if(interruptedInstall&&interruptedInstall!==previewId)throw Error('Resume the original tool approval with rigup update '+quoteShell(root)+' --resume --review');
  await assertNoUnknownWriters(root,lock.stateRoot);
  const operations=data.plan.operations;
  for(const operation of operations){
   if(operation.kind==='initialize'&&operation.integrationId==='openwiki')throw Error(openwikiInitializationGuide);
   const prerequisites=toolOperationPrerequisites(operations,operation);
   if(restoringApproval)verifiedToolOperationForResume(root,operation,prerequisites);
   else assertToolOperationRecipe(root,operation,prerequisites);
  }
  await verifyGlobalInstalls();
  const installs=operations.filter(operation=>operation.kind==='install'&&!operation.global);
  if(!restoringApproval&&!dependencies.signal?.aborted)for(const operation of installs){
   const registry=await operationNpmRegistry(root,operation.query.name,dependencies.signal);
   if((operation.registry??defaultNpmRegistry)!==registry)throw Error('Npm registry changed since approval; prepare a new review before installing.');
  }
  if(tx?.status==='prepared'&&tx.previewId!==previewId){
   if(Object.keys(tx.seedProgress??{}).length)throw Error(seedReconciliation);
   if(tx.preview?.data&&(!tx.preview.data.approvalNonce||tx.preview.data.inputSnapshotVersion!==3&&tx.preview.data.inputSnapshotVersion!==4))throw Error(upgradeReconciliation);
  }
  if(data.inputSnapshotVersion!==3&&data.inputSnapshotVersion!==4)throw new Error('source snapshot version changed; regenerate preview without discarding durable state');
  const priorReport=tx?.report;
  if(data.plan.assets.some(a=>['customer-template','customer-skill'].includes(a.source.kind))){const fresh=await prepareIntegrations(await scanRepository(root,data.plan.options),data.plan.options);for(const a of data.plan.assets.filter(a=>['customer-template','customer-skill'].includes(a.source.kind))){const current=fresh.assets.find(n=>n.logicalId===a.logicalId);if(!current||signature(current)!==signature(a))throw new Error('customer source/template changed since preview');}}
  if(tx&&tx.previewId!==previewId&&tx.status!=='complete'){if(!dependencies.recover)throw new Error('different interrupted installation requires reconciliation with a fresh preview and --resume');await saveDurable(statePath+'.reconciled-'+tx.previewId+'.json',JSON.stringify(tx));}
  if(tx?.previewId!==previewId)tx=undefined;
  if(tx){assertPreviewFileTransitions(tx,data);tx.initialized??={};}
  const seededProjectDocuments=validateConventionReceipts([
   ...(data.oldManifest?.seededProjectDocuments??[]),...data.files.flatMap(file=>file.seed?[file.seed]:[]),
  ]).sort((left,right)=>conventionKey(left.topicId,left.scope).localeCompare(conventionKey(right.topicId,right.scope),'en'));
  const seedHistory=seededProjectDocuments.length?{seededProjectDocuments}:{};
  const managedTargets=data.files.map(file=>file.target);
  const authority:SourceReview['sources']=data.plan.harness?.guidance.flatMap(binding=>
   binding.sourceRef&&binding.scope.length&&['reusable','partial'].includes(binding.coverageStatus)?[{
    path:binding.sourceRef.path,topic:binding.topic,topicId:binding.topicId,scope:binding.scope,
   }]:[])??[];
  const authorityPaths=new Set(authority.map(source=>source.path));
  for(const {path} of authority){
   const actual=await resolveAuthorityTarget(root,path).catch(()=>undefined);
   if(actual)authorityPaths.add(actual);
  }
  const changedInput=async()=>approvalInputChange(root,data,lock.stateRoot).catch(error=>
   error instanceof Error&&!(error as NodeJS.ErrnoException).code?error.message:'recorded project inputs');
  const sourcesMatch=async()=>!await changedInput();
  const assertSources=async()=>{
   const changed=await changedInput();
   if(changed)throw Error('source input changed since preview: '+changed);
  };
  const markSourceReview=(result:InstallReport,review:SourceReview)=>{
   const warning='Approved rule sources changed. Review current sources before relying on project rules.';
   result.projectRules='pending';
   result.sourceReview=review;
   result.nextCommand='rigup update '+quoteShell(root)+' --review';
   if(!result.warnings.includes(warning))result.warnings.push(warning);
   if(result.exitCode===0)result.exitCode=3;
  };
  const managedAuthorityMatches=async()=>{
   for(const file of data.files.filter(item=>authorityPaths.has(item.target))){
    const ownership=data.assets.filter(asset=>asset.target===file.target).map(asset=>asset.ownership);
    const current=(await readTarget(root,file.target))?.toString('utf8');
    if(current===undefined||file.next===undefined||projectInput(current,ownership,true)!==projectInput(file.next,ownership,true))return false;
   }
   return true;
  };
  const recheckCommittedSources=async(result:InstallReport)=>{
   if(await sourcesMatch().catch(()=>false)&&await managedAuthorityMatches().catch(()=>false))return false;
   const selected=(data.plan.options.scope??[]).map(scope=>scope.replace(/\/+$/,''));
   const scopes=selected.length&&selected.every(isConventionScope)?selected:['.'];
   const prior=result.sourceReview;
   markSourceReview(result,{
    scopes:[...new Set([...(prior?.scopes??[]),...scopes])].sort(),
    sources:[...new Map([...(prior?.sources??[]),...authority].map(source=>[signature(source),source])).values()],
   });
   return true;
  };
  // Private inputs can change independently of the saved approval and check history.
  let checksRunThisApply=false;
  const finishCommitted=async(transaction:Transaction)=>{
   await verifyGlobalInstalls(true);
   const checks=transaction.checks??[];
   const runtime=await applyRuntimeInputs(root,data.plan.options,{configured:['*'],verified:checksRunThisApply?checks.filter(check=>check.status==='passed').map(check=>'customer:'+check.name):[]});
   if(report.runtimeSetup?.template.state==='written')runtime.template={...runtime.template,state:'written',imported:report.runtimeSetup.template.imported};
   report.runtimeSetup=runtime;
   const result:InstallReport={...report,...pendingRules,status:'complete',checks,exitCode:checks.some(c=>c.status==='failed')?1:checks.some(c=>c.status==='pending')||data.plan.pendingRuntimeTools?.length?3:0};
   if(data.sourceReview&&data.plan.projectRules==='pending')markSourceReview(result,data.sourceReview);
   await recheckCommittedSources(result);
   transaction.status='complete';
   transaction.report=result;
   await saveDurable(statePath,JSON.stringify(transaction));
   return result;
  };
  const installOperation=(id:NativeTool)=>installs.find(operation=>operation.integrationId===id);
  const installedIdentity=async(id:NativeTool)=>{
   const approved=installOperation(id);
   const receipt=approved?tx?.receipts[id]:data.oldManifest?.installedTools?.[id];
   if(!approved&&tx&&signature(tx.receipts[id]??null)!==signature(receipt??null))throw Error('Durable tool receipt differs from the approved preview');
   const identity=await readVerifiedToolInstall(root,id,receipt);
   if(!identity||approved&&signature(identity)!==signature(toolOperationIdentity(approved)))throw Error('Selected installed tool changed since preview; manual reconciliation required');
   return identity;
  };
  const verifyInstalledTools=async(all=false)=>{
   for(const tool of data.plan.options.tools??[]){
    const id=tool.id;
    if(!(tool.install||tool.initialize&&data.oldManifest?.installedTools?.[id]))continue;
    if(!all&&installOperation(id)||data.plan.pendingRuntimeTools?.includes(id)&&!data.oldManifest?.installedTools?.[id])continue;
    await installedIdentity(id);
   }
  };
  const verifyInitializedTools=async(all=false)=>{
   for(const tool of data.plan.options.tools??[]){
    const id=tool.id,approved=operations.find(operation=>operation.kind==='initialize'&&operation.integrationId===id);
    const previous=data.oldManifest?.initializedTools?.[id];
    if(!(id==='codegraph'&&tool.initialize&&(approved||previous)||id==='openwiki'&&previous))continue;
    if(!all&&approved||data.plan.pendingRuntimeTools?.includes(id)&&!previous)continue;
    const receipt=approved?tx?.initialized?.[id]:previous;
    if(!approved&&tx&&signature(tx.initialized?.[id]??null)!==signature(receipt??null))throw Error('Durable native receipt differs from the approved preview');
    const identity=await installedIdentity(id);
    if(!await verifyToolInitializationReceipt(root,id,identity,receipt))throw Error('Selected native initialization changed; protected reconciliation required');
   }
  };
  await verifyInstalledTools();
  await verifyInitializedTools();
  const currentManifest=await readTarget(root,'.rigup/manifest.json');
  if(tx?.status==='prepared'&&currentManifest) {
   const current=await loadManifest(root);
   if(current?.installId===tx.installId) {
    const expected:Manifest={...rules,...seedHistory,schemaVersion:1,installId:tx.installId,assets:data.assets.map(asset=>installedAsset(asset,tx!)),options:data.plan.options,versions:data.plan.versions,installedTools:tx.receipts,...(Object.keys(tx.initialized!).length?{initializedTools:tx.initialized}:{})};
    if(signature(current)!==signature(expected))throw new Error('committed manifest differs from expected installation');
    for(const a of current.assets){const bytes=await readTarget(root,a.baseline!);if(!bytes||digest(bytes)!==a.digest)throw new Error('committed baseline unavailable');}
    await verifyInstalledTools(true);await verifyInitializedTools(true);
    await finishCommitted(tx);
   }
  }
  if(tx?.status==='complete') {
   await verifyGlobalInstalls(true);
   await verifyInstalledTools(true);
   await verifyInitializedTools(true);
   const m=await loadManifest(root);if(m?.installId!==tx.installId)throw new Error('completed manifest changed');
   if(await recheckCommittedSources(tx.report!))await saveDurable(statePath,JSON.stringify(tx));
   for(const f of data.files){
    if(f.seed)continue;
    const actual=await readFileState(root,f.target),expected=tx.files[f.target];
    if(matchesFileState(actual,expected.after,afterMode(expected)))continue;
    if(tx.report?.sourceReview&&authorityPaths.has(f.target)&&actual.bytes&&f.next!==undefined&&actual.mode===platformFileMode(afterMode(expected))){
     const local=actual.bytes.toString('utf8'),approved=Buffer.from(f.next,f.encoding).toString('utf8');
     if(data.assets.filter(asset=>asset.target===f.target).every(asset=>ownedContent(local,asset.ownership)===ownedContent(approved,asset.ownership)))continue;
    }
    throw new Error('installed target content or mode changed; prepare a new update preview: '+f.target);
   }
   const runtimeSetup=report.runtimeSetup??await applyRuntimeInputs(root,data.plan.options,{configured:['*']});
   completed=total;step('verified completed installation','reused');return {...tx.report!,runtimeSetup,written:[]};
  }
  if((currentManifest?digest(currentManifest):absentDigest)!==data.manifestDigest)throw new Error('manifest changed since preview');
  if(signature(await sourceReview(root,data.oldManifest,lock.stateRoot)??null)!==signature(data.sourceReview??null))throw Error('effective project rules changed; prepare a new review');
  if(tx)for(const f of data.files){
   const actual=await readFileState(root,f.target),expected=tx.files[f.target];
   const before=matchesFileState(actual,expected.before,expected.beforeMode),after=matchesFileState(actual,expected.after,afterMode(expected));
   if(f.seed)await seedApplied(root,f.target,tx,actual);
   else if(!before&&!after)throw Error('interrupted target content or mode changed; preserve local edits and re-preview: '+f.target);
  }
  await assertSources();
  if(!tx) {
   const files=previewFileTransitions(data);
   for(const f of data.files){
    const actual=await readFileState(root,f.target);
    if(!matchesFileState(actual,f.observedDigest,f.observedMode))throw new Error('stale preview: target content or mode changed: '+f.target);
   }
   const blockers=await verifyFreshPreview(data,lock.stateRoot);
   if(blockers)return {...report,warnings:[...report.warnings,...blockers],nextCommand:'rigup update '+quoteShell(root)+' --review'};
   if(!dependencies.runChecks&&unchangedInstallation(data)){
    for(const asset of data.oldManifest!.assets){const bytes=await readTarget(root,asset.baseline!);if(!bytes||digest(bytes)!==asset.digest)throw Error('installed baseline changed since preview');}
    completed=total;step('verified unchanged installation','reused');
    return {...report,...pendingRules,runtimeSetup:await applyRuntimeInputs(root,data.plan.options,{configured:['*']}),status:'complete',exitCode:0};
   }
   tx={previewId,installId:randomUUID(),status:'prepared',files,receipts:{...(data.oldManifest?.installedTools??{})},initialized:{...(data.oldManifest?.initializedTools??{})},preview:{digest:signature(data),data},
    ...(data.sourceReview&&priorReport?{report:priorReport}:{})};
   await saveDurable(statePath,JSON.stringify(tx));
  }
  const cancelled=()=>({...report,operations:reportedOperations(),exitCode:130 as const,...(completedGlobals.size?{nextCommand:resumeCommand}:{})});
  if(dependencies.signal?.aborted)return cancelled();
  const completedOperations=new Set<string>();
  const execute=operationExecutor(data,{...dependencies.operation,stateRoot:lock.stateRoot,signal:dependencies.signal},restoringApproval);
  for(const operation of operations){
   if(dependencies.signal?.aborted)return cancelled();
   if(operation.prerequisiteIds.some(id=>!completedOperations.has(id)))throw Error('Operation prerequisite not completed');
   const receipt=operation.global?undefined:operation.kind==='initialize'?tx.initialized?.[operation.integrationId]:tx.receipts[operation.integrationId];
   if(receipt){
    const result=await queryOperation(operation);
    if(result.status!=='done')throw Error('receipted external state changed');
    if(operation.kind==='initialize'){
     if(signature(result.nativeReceipt)!==signature(receipt))throw Error('receipted external state changed');
    }else{
     const approved=tx.receipts[operation.integrationId],actual=result.receipt;
     if(!actual||actual.version!==approved.version||actual.packageLockDigest!==approved.packageLockDigest||
      approved.packageIntegrity!==undefined&&normalizeNpmIntegrity(approved.packageIntegrity)!==actual.packageIntegrity)
      throw Error('receipted external state changed');
    }
    report.operations.push(result);
    completedOperations.add(operation.id);completed++;
    step(operation.id,'reused');
    continue;
   }
   step(operation.id);
   let result:OperationResult;
   try{result=await execute(operation.id);}catch(error){
    if(!operations.some(operation=>operation.global))throw error;
    result={status:'failed',message:(error as Error).message};
   }
   report.operations.push(result);
   if(result.status!=='done')return {...report,nextCommand:resumeCommand,
    exitCode:dependencies.signal?.aborted?130:result.status==='failed'?1:3,status:result.status==='failed'?'failed':'pending'};
   completedOperations.add(operation.id);completed++;
   if(operation.global){
    const key=signature(operation.global);
    if(result.globalReceipt?.approval!==key)throw Error('Global installation lacks its approved receipt');
    completedGlobals.set(key,result);
    tx.report={...report};
   }else if(operation.kind==='initialize'){
    if(!result.nativeReceipt)throw Error('native initialization lacks verifiable receipt');
    tx.initialized![operation.integrationId]=result.nativeReceipt;
   }else{
    if(!result.receipt)throw Error('external operation lacks verifiable receipt');
    tx.receipts[operation.integrationId]=result.receipt;
   }
   step(operation.id);await saveDurable(statePath,JSON.stringify(tx));await dependencies.hook?.('after-operation');
  }
  await verifyGlobalInstalls(true);
  if(operations.length)await assertSources();
  for(const f of data.files){
   if(dependencies.signal?.aborted)return cancelled();
   const actual=await readFileState(root,f.target);const expected=tx.files[f.target];
   const recordMode=async(mode:number,stage?:string)=>{
    const effective=mode===platformFileMode(expected.afterMode)?undefined:mode;
    if(!stage&&effective===expected.effectiveAfterMode)return;
    expected.effectiveAfterMode=effective;
    if(stage)(tx!.seedStages??={})[f.target]=stage;
    await saveDurable(statePath,JSON.stringify(tx));
   };
   if(f.seed){
    const progress=tx.seedProgress??={};
    const written=async()=>{
     progress[f.target]='written';
     if(tx!.seedStages)delete tx!.seedStages[f.target];
     await saveDurable(statePath,JSON.stringify(tx));
    };
    if(await seedApplied(root,f.target,tx,actual)){
     const stage=tx.seedStages?.[f.target];
     if(progress[f.target]==='started'){
      await written();
      if(stage)await unlink(await targetPath(root,stage));
     }
     completed++;step(f.target,'reused');
     continue;
    }
    tx.seedStages??={};
    progress[f.target]='started';
    await saveDurable(statePath,JSON.stringify(tx));
    await dependencies.hook?.('before-seed');
    try{
     await atomicProjectWrite(root,f.target,Buffer.from(f.next!),expected.afterMode,true,undefined,recordMode,async()=>{
      await dependencies.hook?.('after-seed-link');
      await written();
     });
    }catch(error){
     if(error instanceof ExclusiveLinkError&&tx.seedStages?.[f.target]){
      delete tx.seedStages[f.target];
      await saveDurable(statePath,JSON.stringify(tx));
     }
     throw error;
    }
    completed++;step(f.target);report.written.push(f.target);await dependencies.hook?.('after-file');
    continue;
   }
   if(matchesFileState(actual,expected.after,afterMode(expected))){completed++;step(f.target,'reused');continue;}
   if(!matchesFileState(actual,expected.before,expected.beforeMode))throw new Error('target content or mode changed before write: '+f.target);
   const verifyCurrent=async()=>{if(!matchesFileState(await readFileState(root,f.target),expected.before,expected.beforeMode))throw Error('target content or mode changed during write: '+f.target);};
   // Backups are private and preserve actual L, never become the generated baseline.
   if(actual.bytes){const backup=join(lock.stateRoot,signature(root)+'.'+tx.installId+'.'+signature(f.target)+'.backup.json');await saveDurable(backup,JSON.stringify({target:f.target,bytes:actual.bytes.toString('base64'),mode:actual.mode}));}
   if(f.next===undefined){if(actual.bytes){await verifyCurrent();await unlink(await targetPath(root,f.target));}}
   else {await atomicProjectWrite(root,f.target,f.encoding==='base64'?Buffer.from(f.next,'base64'):Buffer.from(f.next),expected.afterMode,false,verifyCurrent,recordMode);}
   completed++;step(f.target);report.written.push(f.target);await dependencies.hook?.('after-file');
  }
  if(dependencies.signal?.aborted)return cancelled();
  const verifyFiles=async()=>{for await(const {target,state} of readFileStates(root,data.files.map(f=>f.target))){const expected=tx!.files[target];if(!matchesFileState(state,expected.after,afterMode(expected)))throw new Error('written configuration differs from preview (content or mode); baseline not committed');}};
  await verifyFiles();
  report.runtimeSetup=await applyRuntimeInputs(root,data.plan.options,{configured:['*']});
  if(!tx.checks){
   if(dependencies.runChecks||data.plan.runChecks?.length)await assertSources();
   if(dependencies.runChecks)tx.checks=await dependencies.runChecks();
   else if(data.plan.runChecks?.length){
    const profile=await scanRepository(root,data.plan.options);
    tx.checks=data.resolvedChecks?await runResolvedProjectChecks(profile,data.resolvedChecks,dependencies.signal,data.plan.options):
     await runProjectChecks(profile,data.plan.runChecks,dependencies.signal,data.plan.options);
   }else tx.checks=[];
   checksRunThisApply=true;await saveDurable(statePath,JSON.stringify(tx));
  }
  report.checks=tx.checks;await dependencies.hook?.('after-checks');await verifyFiles();await assertSources();await verifyInstalledTools(true);await verifyInitializedTools(true);if(dependencies.signal?.aborted)return cancelled();
  const assets=[];
  for(const asset of data.assets){
   const b=data.baselines.find(b=>b.logicalId===asset.logicalId);
   if(!b)throw Error('required baseline unavailable');
   const installed=installedAsset(asset,tx);
   await atomicProjectWrite(root,installed.baseline,b.encoding==='base64'?Buffer.from(b.content,'base64'):Buffer.from(b.content),0o600);
   assets.push(installed);
  }
  const manifest:Manifest={...rules,...seedHistory,schemaVersion:1,installId:tx.installId,assets,options:data.plan.options,versions:data.plan.versions,installedTools:tx.receipts,...(Object.keys(tx.initialized!).length?{initializedTools:tx.initialized}:{})};
  await dependencies.hook?.('before-manifest');await verifyFiles();await assertSources();
  await verifyGlobalInstalls(true);
  await atomicProjectWrite(root,'.rigup/manifest.json',Buffer.from(JSON.stringify(manifest,null,2)+'\n'),0o600,false,async()=>{
   const actual=await readFileState(root,'.rigup/manifest.json');
   if(actual.digest!==data.manifestDigest)throw Error('manifest changed during apply');
  });
  await dependencies.hook?.('after-manifest');
  if(data.plan.options.agents.length&&data.plan.assets.length)report.warnings.push('Native host loading/reload is unverified; configuration installation is separate from live host acceptance');
  const installed=await finishCommitted(tx);
  completed=total;step('manifest committed',installed.exitCode===1?'failed':'complete');
  return installed;
 }catch(error){
  if(!completedGlobals.size)throw error;
  return {...report,status:'failed',exitCode:1,operations:reportedOperations(),warnings:[...report.warnings,(error as Error).message],nextCommand:resumeCommand};
 }finally{await release();}
}
