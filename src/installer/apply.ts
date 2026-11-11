import type {RunProgressEvent} from '../progress.js';
import {prepareIntegrations} from '../integrations/registry.js';
import {loadUpstreamLock} from '../integrations/upstream.js';
import {verifyToolInstallReceipt} from '../integrations/tools/installed-state.js';
import {verifyToolInitializationReceipt} from '../integrations/tools/native-state.js';
import {PROMPT_VERSION} from '../analyzer/prompts.js';
import {READ_POLICY_VERSION} from '../analyzer/read-policy.js';
import {TEMPLATE_VERSION} from '../generator/render.js';
import {DOCUMENT_POLICY_VERSION} from '../generator/document-policy.js';
import {isRecord,saveDurable} from '../private-record.js';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {unlink} from 'node:fs/promises';
import {readFileState,readFileStates,matchesFileState,platformFileMode} from './file-state.js';
import type {CommandSpec,SetupOptions,SetupPlan} from '../types.js';
import {loadPreview,readTarget,installationInput,unchangedInstallation,absentDigest,type PreviewData} from './preview.js';
import {acquireLock,defaultStateRoot,type ProjectLock} from './lock.js';
import {assertNoUnknownWriters,operationExecutor,queryOperation,type OperationDependencies,type OperationResult} from './operations.js';
import {privateDirectory,signature,saveCache} from '../generator/cache.js';
import {digest} from '../analyzer/evidence.js';
import {scanRepository} from '../analyzer/repository.js';
import {atomicProjectWrite} from './manifest.js';
import {targetPath,ownedContent} from './ownership.js';
import {applyRecordPath,loadManifest,readApplyRecord,sourceReview,type Manifest,type SourceReview,type Transaction} from './baseline.js';
import {runProjectChecks} from '../integrations/tools/quality.js';
import {quoteShell} from '../shell-command.js';
import {conventionKey,isConventionScope,validateConventionReceipts} from '../project-conventions.js';
import {projectInput} from '../managed-input.js';
export interface CheckResult {status:'passed'|'failed'|'pending';name:string;message?:string;command?:CommandSpec;fingerprint?:string;commit?:string;startedAt?:string;finishedAt?:string;durationMs?:number;diagnostic?:{rule:string;path:string;relatedPath:string};environment?:{node:string;platform:string};exitCode?:number}
export interface InstallReport {projectRules?:SetupPlan['projectRules'];harness?:SetupPlan['harness'];sourceReview?:SourceReview;researchNextStep?:string;nextCommand?:string;status:'complete'|'failed'|'pending';exitCode:0|1|3|130;previewId:string;written:string[];operations:OperationResult[];checks:CheckResult[];warnings:string[]}
export interface ApplyDependencies {cacheRoot?:string;onProgress?:(event:RunProgressEvent)=>void;stateRoot?:string;lock?:ProjectLock;recover?:boolean;signal?:AbortSignal;hook?:(point:string)=>Promise<void>;runChecks?:()=>Promise<CheckResult[]>;operation?:OperationDependencies}
function previewFileTransitions(data:PreviewData):Transaction['files']{
 return Object.fromEntries(data.files.map(file=>{
  const after=file.next===undefined?absentDigest:digest(Buffer.from(file.next,file.encoding));
  return [file.target,{before:file.observedDigest,beforeMode:file.observedMode,after,afterMode:file.next===undefined?undefined:file.mode}];
 }));
}
function assertPreviewFileTransitions(tx:Transaction,data:PreviewData):void{
 if(signature(tx.files)!==signature(previewFileTransitions(data)))throw Error('Durable apply record differs from the approved preview; reconciliation required');
 if(Object.keys(tx.seedProgress??{}).some(target=>!data.files.some(file=>file.target===target&&file.seed)))throw Error('Durable seed progress differs from the approved preview; reconciliation required');
}
export async function interruptedApplyId(root:string,stateRoot:string):Promise<string|undefined>{
 const tx=await readApplyRecord(applyRecordPath(root,stateRoot));
 return tx?.status==='prepared'?tx.previewId:undefined;
}
export async function interruptedSeedApplyId(root:string,stateRoot=defaultStateRoot()):Promise<string|undefined>{
 const tx=await readApplyRecord(applyRecordPath(root,stateRoot));
 return tx?.status==='prepared'&&Object.keys(tx.seedProgress??{}).length?tx.previewId:undefined;
}
const upgradeReconciliation='Implementation version changed. Resume or reconcile the original approved installation with its Rigup version before upgrading.';
const seedReconciliation='Customer document creation was interrupted. Resume the original approved preview or reconcile the customer document manually.';
function approvedInterruptedPreview(root:string,tx:Transaction):NonNullable<Transaction['preview']>{
 const stored=tx.preview;
 if(!stored?.data?.plan||!isRecord(stored.data.plan.options)||!Array.isArray(stored.data.plan.options.agents)||!Array.isArray(stored.data.files)||
  !stored.data.preview||stored.digest!==signature(stored.data)||stored.data.plan.root!==root||stored.data.preview.previewId!==tx.previewId||!stored.data.preview.executable)throw Error('Durable interrupted preview unavailable or corrupted; manual reconciliation required');
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
 if(stored.data.inputSnapshotVersion!==3)throw Error(upgradeReconciliation);
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
 try {
  await assertNoUnknownWriters(root,lock.stateRoot);
  const statePath=applyRecordPath(root,lock.stateRoot);let tx=await readApplyRecord(statePath);
  if(tx?.status==='prepared'&&tx.previewId!==previewId){
   if(Object.keys(tx.seedProgress??{}).length)throw Error(seedReconciliation);
   if(tx.preview?.data&&tx.preview.data.inputSnapshotVersion!==3)throw Error(upgradeReconciliation);
  }
  const restoringApproval=tx?.previewId===previewId&&tx.preview?.digest===signature(data);
  const versions={prompt:PROMPT_VERSION,read:READ_POLICY_VERSION,template:TEMPLATE_VERSION,document:DOCUMENT_POLICY_VERSION};
  for(const [key,value] of Object.entries(versions)){
   const approved=data.plan.versions[key];
   if(approved===undefined||approved===value)continue;
   // The string-array prompt revision does not change already approved writes.
   if(key==='prompt'&&approved==='10'&&restoringApproval)continue;
   throw new Error(restoringApproval&&tx?.status==='prepared'?upgradeReconciliation:'implementation version changed; regenerate preview');
  }
  if(data.inputSnapshotVersion!==3)throw new Error('source snapshot version changed; regenerate preview without discarding durable state');
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
  const authorityPaths=new Set(data.plan.harness?.guidance.flatMap(binding=>
   binding.sourceRef&&['reusable','partial'].includes(binding.coverageStatus)?[binding.sourceRef.path]:[]));
  const sourcesMatch=async()=>await installationInput(root,data.plan,managedTargets)===data.inputSnapshot;
  const assertSources=async()=>{if(!await sourcesMatch().catch(()=>false))throw Error('source input changed since preview or cannot be verified');};
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
    sources:[...new Set([...(prior?.sources??[]),...authorityPaths])].sort(),
   });
   return true;
  };
  const finishCommitted=async(transaction:Transaction)=>{
   const checks=transaction.checks??[];
   const result:InstallReport={...report,...pendingRules,status:'complete',checks,exitCode:checks.some(c=>c.status==='failed')?1:checks.some(c=>c.status==='pending')?3:0};
   if(data.sourceReview&&data.plan.projectRules==='pending')markSourceReview(result,data.sourceReview);
   await recheckCommittedSources(result);
   transaction.status='complete';
   transaction.report=result;
   await saveDurable(statePath,JSON.stringify(transaction));
   return result;
  };
  const verifyInstalledTools=async(all=false)=>{
   const selected=(data.plan.options.tools??[]).filter(t=>(t.install||t.initialize&&(t.id==='codegraph'||!!data.oldManifest?.installedTools?.[t.id]))&&(all||!data.plan.operations.some(o=>o.kind==='install'&&o.integrationId===t.id)));
   if(!selected.length)return;const recipes=await loadUpstreamLock();
   for(const tool of selected){const receipt=tx?.receipts[tool.id]??data.oldManifest?.installedTools?.[tool.id];const recipe=recipes.find(r=>r.integrationId===tool.id);if(!receipt||!recipe||receipt.version!==recipe.version)throw new Error('selected installed tool lacks a compatible receipt; reconciliation required');if(!await verifyToolInstallReceipt(root,tool.id,recipe,receipt))throw new Error('selected installed tool changed since preview; manual reconciliation required');}
  };
  const verifyInitializedTools=async(all=false)=>{
   const selected=(data.plan.options.tools??[]).filter(t=>(t.id==='codegraph'&&t.initialize||t.id==='openwiki'&&!!(tx?.initialized?.[t.id]??data.oldManifest?.initializedTools?.[t.id]))&&(all||!data.plan.operations.some(o=>o.kind==='initialize'&&o.integrationId===t.id)));
   if(!selected.length)return;const recipes=await loadUpstreamLock();
   for(const tool of selected){const receipt=tx?.initialized?.[tool.id]??data.oldManifest?.initializedTools?.[tool.id];const recipe=recipes.find(r=>r.integrationId===tool.id)!;if(!await verifyToolInitializationReceipt(root,tool.id,recipe,receipt))throw Error('Selected native initialization changed; protected reconciliation required');}
  };
  await verifyInstalledTools();
  await verifyInitializedTools();
  const currentManifest=await readTarget(root,'.rigup/manifest.json');
  if(tx?.status==='prepared'&&currentManifest) {
   const current=await loadManifest(root);
   if(current?.installId===tx.installId) {
    const expected:Manifest={...rules,...seedHistory,schemaVersion:1,installId:tx.installId,assets:data.assets.map(a=>({...a,baseline:'.rigup/baseline/'+tx!.installId+'/'+signature(a.logicalId)})),options:data.plan.options,versions:data.plan.versions,installedTools:tx.receipts,...(Object.keys(tx.initialized!).length?{initializedTools:tx.initialized}:{})};
    if(signature(current)!==signature(expected))throw new Error('committed manifest differs from expected installation');
    for(const a of current.assets){const bytes=await readTarget(root,a.baseline!);if(!bytes||digest(bytes)!==a.digest)throw new Error('committed baseline unavailable');}
    await verifyInstalledTools(true);await verifyInitializedTools(true);
    await finishCommitted(tx);
   }
  }
  if(tx?.status==='complete') {
   await verifyInstalledTools(true);
   await verifyInitializedTools(true);
   const m=await loadManifest(root);if(m?.installId!==tx.installId)throw new Error('completed manifest changed');
   if(await recheckCommittedSources(tx.report!))await saveDurable(statePath,JSON.stringify(tx));
   for(const f of data.files){
    if(f.seed)continue;
    const actual=await readFileState(root,f.target),expected=tx.files[f.target];
    if(matchesFileState(actual,expected.after,expected.afterMode))continue;
    if(tx.report?.sourceReview&&authorityPaths.has(f.target)&&actual.bytes&&f.next!==undefined&&actual.mode===platformFileMode(expected.afterMode)){
     const local=actual.bytes.toString('utf8'),approved=Buffer.from(f.next,f.encoding).toString('utf8');
     if(data.assets.filter(asset=>asset.target===f.target).every(asset=>ownedContent(local,asset.ownership)===ownedContent(approved,asset.ownership)))continue;
    }
    throw new Error('installed target content or mode changed; prepare a new update preview');
   }
   completed=total;step('verified completed installation','reused');return {...tx.report!,written:[]};
  }
  if((currentManifest?digest(currentManifest):absentDigest)!==data.manifestDigest)throw new Error('manifest changed since preview');
  if(signature(await sourceReview(root,data.oldManifest,lock.stateRoot)??null)!==signature(data.sourceReview??null))throw Error('effective project rules changed; prepare a new review');
  if(tx)for(const f of data.files){
   const actual=await readFileState(root,f.target),expected=tx.files[f.target];
   const before=matchesFileState(actual,expected.before,expected.beforeMode),after=matchesFileState(actual,expected.after,expected.afterMode);
   if(f.seed){if(!(tx.seedProgress?.[f.target]?after:before))throw Error(seedReconciliation);}
   else if(!before&&!after)throw new Error('interrupted target content or mode changed; preserve local edits and re-preview');
  }
  await assertSources();
  if(!tx) {
   if((await scanRepository(root,data.plan.options)).fingerprint!==data.plan.fingerprint)throw new Error('research input changed since generation');
   const files=previewFileTransitions(data);
   for(const f of data.files){
    const actual=await readFileState(root,f.target);
    if(!matchesFileState(actual,f.observedDigest,f.observedMode))throw new Error('stale preview: target content or mode changed');
   }
   if(!dependencies.runChecks&&unchangedInstallation(data)){
    for(const asset of data.oldManifest!.assets){const bytes=await readTarget(root,asset.baseline!);if(!bytes||digest(bytes)!==asset.digest)throw Error('installed baseline changed since preview');}
    completed=total;step('verified unchanged installation','reused');
    return {...report,...pendingRules,status:'complete',exitCode:0};
   }
   tx={previewId,installId:randomUUID(),status:'prepared',files,receipts:{...(data.oldManifest?.installedTools??{})},initialized:{...(data.oldManifest?.initializedTools??{})},preview:{digest:signature(data),data},
    ...(data.sourceReview&&priorReport?{report:priorReport}:{})};
   await saveDurable(statePath,JSON.stringify(tx));
  }
  if(dependencies.signal?.aborted)return {...report,exitCode:130};
  const completedOperations=new Set<string>();
  const execute=operationExecutor(root,{...dependencies.operation,authorizationRef:previewId,restoringApproval,stateRoot:lock.stateRoot,signal:dependencies.signal});
  const operations=data.plan.operations;
  for(let index=0;index<operations.length;){
   if(dependencies.signal?.aborted)return {...report,exitCode:130};
   const first=operations[index],next=operations[index+1];
   const batch=first.kind==='install'&&next?.kind==='install'&&first.integrationId!==next.integrationId?[first,next]:[first];
   index+=batch.length;
   const reused=new Map<string,OperationResult>();
   for(const operation of batch){
    if(operation.prerequisiteIds.some(id=>!completedOperations.has(id)))throw Error('Operation prerequisite not completed');
    const receipt=operation.kind==='initialize'?tx.initialized?.[operation.integrationId]:tx.receipts[operation.integrationId];
    if(!receipt)continue;
    const result=await queryOperation(operation);
    const actual=operation.kind==='initialize'?result.nativeReceipt:result.receipt;
    if(result.status!=='done'||signature(actual)!==signature(receipt))throw new Error('receipted external state changed');
    reused.set(operation.id,result);
   }
   // Wait for every operation in the batch before releasing the lock or starting initialization.
   const outcomes=await Promise.allSettled(batch.map(async operation=>{
    const result=reused.get(operation.id);
    if(result)return result;
    step(operation.id);
    return execute(operation);
   }));
   const results=outcomes.map(outcome=>{if(outcome.status==='rejected')throw outcome.reason;return outcome.value;});
   report.operations.push(...results);
   for(const [i,operation] of batch.entries()){
    const result=results[i];
    if(result.status!=='done')continue;
    completedOperations.add(operation.id);completed++;
    if(reused.has(operation.id)){step(operation.id,'reused');continue;}
    if(operation.kind==='initialize'){if(!result.nativeReceipt)throw Error('native initialization lacks verifiable receipt');tx.initialized![operation.integrationId]=result.nativeReceipt;}
    else {if(!result.receipt)throw Error('external operation lacks verifiable receipt');tx.receipts[operation.integrationId]=result.receipt;}
    step(operation.id);await saveDurable(statePath,JSON.stringify(tx));await dependencies.hook?.('after-operation');
   }
   const incomplete=results.find(result=>result.status!=='done');
   if(incomplete)return {...report,exitCode:dependencies.signal?.aborted?130:incomplete.status==='failed'?1:3,status:incomplete.status==='failed'?'failed':'pending'};
  }
  if(operations.length)await assertSources();
  for(const f of data.files){
   if(dependencies.signal?.aborted)return {...report,exitCode:130};
   const actual=await readFileState(root,f.target);const expected=tx.files[f.target];
   if(f.seed){
    const progress=tx.seedProgress??={};
    if(progress[f.target]){
     if(!matchesFileState(actual,expected.after,expected.afterMode))throw Error(seedReconciliation);
     completed++;step(f.target,'reused');
     continue;
    }
    if(!matchesFileState(actual,expected.before,expected.beforeMode))throw Error(seedReconciliation);
    progress[f.target]='started';
    await saveDurable(statePath,JSON.stringify(tx));
    await dependencies.hook?.('before-seed');
    await atomicProjectWrite(root,f.target,Buffer.from(f.next!),expected.afterMode,true);
    progress[f.target]='written';
    await saveDurable(statePath,JSON.stringify(tx));
    completed++;step(f.target);report.written.push(f.target);await dependencies.hook?.('after-file');
    continue;
   }
   if(matchesFileState(actual,expected.after,expected.afterMode)){completed++;step(f.target,'reused');continue;}
   if(!matchesFileState(actual,expected.before,expected.beforeMode))throw new Error('target content or mode changed before write');
   const verifyCurrent=async()=>{if(!matchesFileState(await readFileState(root,f.target),expected.before,expected.beforeMode))throw Error('target content or mode changed during write');};
   // Backups are private and preserve actual L, never become the generated baseline.
   if(actual.bytes){const backup=join(lock.stateRoot,signature(root)+'.'+tx.installId+'.'+signature(f.target)+'.backup.json');await saveDurable(backup,JSON.stringify({target:f.target,bytes:actual.bytes.toString('base64'),mode:actual.mode}));}
   if(f.next===undefined){if(actual.bytes){await verifyCurrent();await unlink(await targetPath(root,f.target));}}
   else {await atomicProjectWrite(root,f.target,f.encoding==='base64'?Buffer.from(f.next,'base64'):Buffer.from(f.next),expected.afterMode,false,verifyCurrent);}
   completed++;step(f.target);report.written.push(f.target);await dependencies.hook?.('after-file');
  }
  if(dependencies.signal?.aborted)return {...report,exitCode:130};
  const verifyFiles=async()=>{for await(const {target,state} of readFileStates(root,data.files.map(f=>f.target))){const expected=tx!.files[target];if(!matchesFileState(state,expected.after,expected.afterMode))throw new Error('written configuration differs from preview (content or mode); baseline not committed');}};
  await verifyFiles();
  if(!tx.checks){tx.checks=dependencies.runChecks?await dependencies.runChecks():data.plan.runChecks?.length?await runProjectChecks(await scanRepository(root,data.plan.options),data.plan.runChecks,dependencies.signal):[];await saveDurable(statePath,JSON.stringify(tx));}
  report.checks=tx.checks;await dependencies.hook?.('after-checks');await verifyFiles();await assertSources();await verifyInstalledTools(true);await verifyInitializedTools(true);if(dependencies.signal?.aborted)return {...report,exitCode:130};
  const assets=[];
  for(const asset of data.assets){const b=data.baselines.find(b=>b.logicalId===asset.logicalId);if(!b)throw new Error('required baseline unavailable');const baseline='.rigup/baseline/'+tx.installId+'/'+signature(asset.logicalId);await atomicProjectWrite(root,baseline,b.encoding==='base64'?Buffer.from(b.content,'base64'):Buffer.from(b.content),0o600);assets.push({...asset,baseline});}
  const manifest:Manifest={...rules,...seedHistory,schemaVersion:1,installId:tx.installId,assets,options:data.plan.options,versions:data.plan.versions,installedTools:tx.receipts,...(Object.keys(tx.initialized!).length?{initializedTools:tx.initialized}:{})};
  await dependencies.hook?.('before-manifest');await verifyFiles();await assertSources();
  await atomicProjectWrite(root,'.rigup/manifest.json',Buffer.from(JSON.stringify(manifest,null,2)+'\n'),0o600,false,async()=>{
   const actual=await readFileState(root,'.rigup/manifest.json');
   if(actual.digest!==data.manifestDigest)throw Error('manifest changed during apply');
  });
  await dependencies.hook?.('after-manifest');
  if(data.plan.options.agents.length&&data.plan.assets.length)report.warnings.push('Native host loading/reload is unverified; configuration installation is separate from live host acceptance');
  const installed=await finishCommitted(tx);
  completed=total;step('manifest committed',installed.exitCode===1?'failed':'complete');
  return installed;
 }finally{await release();}
}
