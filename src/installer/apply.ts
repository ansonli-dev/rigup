import type {RunProgressEvent} from '../progress.js';
import {prepareIntegrations} from '../integrations/registry.js';
import {loadUpstreamLock} from '../integrations/upstream.js';
import {verifyToolInstallReceipt} from '../integrations/tools/installed-state.js';
import {verifyToolInitializationReceipt} from '../integrations/tools/native-state.js';
import {PROMPT_VERSION} from '../analyzer/prompts.js';
import {READ_POLICY_VERSION} from '../analyzer/read-policy.js';
import {TEMPLATE_VERSION} from '../generator/render.js';
import {DOCUMENT_POLICY_VERSION} from '../generator/document-policy.js';
import {isRecord,readDurableRecord,saveDurable} from '../private-record.js';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {unlink} from 'node:fs/promises';
import {readFileState,readFileStates,matchesFileState} from './file-state.js';
import type {CommandSpec,SetupOptions,SetupPlan} from '../types.js';
import {loadPreview,readTarget,installationInput,absentDigest,type PreviewData} from './preview.js';
import {acquireLock,defaultStateRoot,type ProjectLock} from './lock.js';
import {assertNoUnknownWriters,operationExecutor,queryOperation,type OperationDependencies,type OperationResult} from './operations.js';
import {privateDirectory,signature,saveCache} from '../generator/cache.js';
import {digest} from '../analyzer/evidence.js';
import {scanRepository} from '../analyzer/repository.js';
import type {NativeDiscoveryOptions} from '../analyzer/native-sources.js';
import {atomicProjectWrite} from './manifest.js';
import {targetPath,ownedContent} from './ownership.js';
import {loadManifest,type Manifest} from './baseline.js';
import {runProjectChecks} from '../integrations/tools/quality.js';
import {quoteShell} from '../shell-command.js';
export interface CheckResult {status:'passed'|'failed'|'pending';name:string;message?:string;command?:CommandSpec;fingerprint?:string;commit?:string;startedAt?:string;finishedAt?:string;durationMs?:number;diagnostic?:{rule:string;path:string;relatedPath:string};environment?:{node:string;platform:string};exitCode?:number}
export interface InstallReport {projectRules?:SetupPlan['projectRules'];researchNextStep?:string;nextCommand?:string;status:'complete'|'failed'|'pending';exitCode:0|1|3|130;previewId:string;written:string[];operations:OperationResult[];checks:CheckResult[];warnings:string[]}
export interface ApplyDependencies {cacheRoot?:string;onProgress?:(event:RunProgressEvent)=>void;stateRoot?:string;lock?:ProjectLock;recover?:boolean;signal?:AbortSignal;hook?:(point:string)=>Promise<void>;runChecks?:()=>Promise<CheckResult[]>;operation?:OperationDependencies}
interface Transaction {previewId:string;installId:string;status:'prepared'|'complete';files:Record<string,{before:string;after:string;beforeMode?:number;afterMode?:number}>;checks?:CheckResult[];receipts:NonNullable<Manifest['installedTools']>;initialized?:NonNullable<Manifest['initializedTools']>;preview?:{digest:string;data:PreviewData};report?:InstallReport}
function readApplyRecord(path:string):Promise<Transaction|undefined>{
 return readDurableRecord<Transaction>(path,'Durable apply record',tx=>{
  if(!['prepared','complete'].includes(tx.status)||typeof tx.previewId!=='string'||!/^[a-f0-9]{64}$/.test(tx.previewId)||
   typeof tx.installId!=='string'||!/^[a-f0-9-]+$/.test(tx.installId)||!isRecord(tx.files)||!isRecord(tx.receipts)||
   tx.initialized!==undefined&&!isRecord(tx.initialized)||tx.checks!==undefined&&!Array.isArray(tx.checks))return false;
  if(!Object.values(tx.files).every(file=>isRecord(file)&&typeof file.before==='string'&&typeof file.after==='string'))return false;
  const report=tx.report;
  return tx.status!=='complete'||isRecord(report)&&report.previewId===tx.previewId&&report.status==='complete'&&
   [0,1,3].includes(report.exitCode)&&[report.written,report.operations,report.checks,report.warnings].every(Array.isArray);
 });
}
function previewFileTransitions(data:PreviewData):Transaction['files']{
 return Object.fromEntries(data.files.map(file=>{
  const after=file.next===undefined?absentDigest:digest(Buffer.from(file.next,file.encoding));
  return [file.target,{before:file.observedDigest,beforeMode:file.observedMode,after,afterMode:file.next===undefined?undefined:file.mode}];
 }));
}
function assertPreviewFileTransitions(tx:Transaction,data:PreviewData):void{
 if(signature(tx.files)!==signature(previewFileTransitions(data)))throw Error('Durable apply record differs from the approved preview; reconciliation required');
}
function unchangedInstallation(data:PreviewData,files:Transaction['files']):boolean{
 const old=data.oldManifest;
 if(!old||data.plan.operations.length||data.plan.runChecks?.length||old.projectRules!==data.plan.projectRules)return false;
 if(signature(old.options)!==signature(data.plan.options)||signature(old.versions)!==signature(data.plan.versions))return false;
 const assets=(items:Manifest['assets'])=>items.map(({baseline,...item})=>item).sort((a,b)=>a.logicalId.localeCompare(b.logicalId));
 return signature(assets(old.assets))===signature(assets(data.assets))&&
  Object.values(files).every(file=>file.before===file.after&&file.beforeMode===file.afterMode);
}
export async function interruptedApplyId(root:string,stateRoot:string):Promise<string|undefined>{
 const tx=await readApplyRecord(join(stateRoot,signature(root)+'.apply.json'));
 return tx?.status==='prepared'?tx.previewId:undefined;
}
function approvedInterruptedPreview(root:string,tx:Transaction):NonNullable<Transaction['preview']>{
 const stored=tx.preview;
 if(!stored?.data?.plan||!isRecord(stored.data.plan.options)||!Array.isArray(stored.data.plan.options.agents)||!Array.isArray(stored.data.files)||
  !stored.data.preview||stored.digest!==signature(stored.data)||stored.data.plan.root!==root||stored.data.preview.previewId!==tx.previewId||!stored.data.preview.executable)throw Error('Durable interrupted preview unavailable or corrupted; manual reconciliation required');
 assertPreviewFileTransitions(tx,stored.data);
 return stored;
}
export async function interruptedApplyOptions(root:string,stateRoot=defaultStateRoot()):Promise<SetupOptions|undefined>{
 const state=await privateDirectory(stateRoot,root);
 const tx=await readApplyRecord(join(state,signature(root)+'.apply.json'));
 if(tx?.status==='prepared')return approvedInterruptedPreview(root,tx).data.plan.options;
}
export async function restoreInterruptedPreview(root:string,options:SetupOptions,cacheRoot:string,stateRoot:string):Promise<string|undefined>{
 const tx=await readApplyRecord(join(stateRoot,signature(root)+'.apply.json'));
 if(tx?.status!=='prepared')return;
 const stored=approvedInterruptedPreview(root,tx);
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
 const report:InstallReport={...rules,status:'pending',exitCode:3,previewId,written:[],operations:[],checks:[],warnings:[...data.preview.warnings]};
 try {
  await assertNoUnknownWriters(root,lock.stateRoot);
  const statePath=join(lock.stateRoot,signature(root)+'.apply.json');let tx=await readApplyRecord(statePath);
  const restoringApproval=tx?.previewId===previewId&&tx.preview?.digest===signature(data);
  const versions={prompt:PROMPT_VERSION,read:READ_POLICY_VERSION,template:TEMPLATE_VERSION,document:DOCUMENT_POLICY_VERSION};
  for(const [key,value] of Object.entries(versions)){
   const approved=data.plan.versions[key];
   if(approved===undefined||approved===value)continue;
   // The string-array prompt revision does not change already approved writes.
   if(key==='prompt'&&approved==='10'&&restoringApproval)continue;
   throw new Error('implementation version changed; regenerate preview');
  }
  if(data.plan.assets.some(a=>['customer-template','customer-skill'].includes(a.source.kind))){const fresh=await prepareIntegrations(await scanRepository(root,data.plan.options),data.plan.options);for(const a of data.plan.assets.filter(a=>['customer-template','customer-skill'].includes(a.source.kind))){const current=fresh.assets.find(n=>n.logicalId===a.logicalId);if(!current||signature(current)!==signature(a))throw new Error('customer source/template changed since preview');}}
  if(tx&&tx.previewId!==previewId&&tx.status!=='complete'){if(!dependencies.recover)throw new Error('different interrupted installation requires reconciliation with a fresh preview and --resume');await saveDurable(statePath+'.reconciled-'+tx.previewId+'.json',JSON.stringify(tx));}
  if(tx?.previewId!==previewId)tx=undefined;
  if(tx){assertPreviewFileTransitions(tx,data);tx.initialized??={};}
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
    const expected:Manifest={...rules,schemaVersion:1,installId:tx.installId,assets:data.assets.map(a=>({...a,baseline:'.rigup/baseline/'+tx!.installId+'/'+signature(a.logicalId)})),options:data.plan.options,versions:data.plan.versions,installedTools:tx.receipts,...(Object.keys(tx.initialized!).length?{initializedTools:tx.initialized}:{})};
    if(signature(current)!==signature(expected))throw new Error('committed manifest differs from expected installation');
    for(const a of current.assets){const bytes=await readTarget(root,a.baseline!);if(!bytes||digest(bytes)!==a.digest)throw new Error('committed baseline unavailable');}
    await verifyInstalledTools(true);await verifyInitializedTools(true);tx.status='complete';tx.report={...report,...pendingRules,status:'complete',exitCode:tx.checks?.some(c=>c.status==='failed')?1:tx.checks?.some(c=>c.status==='pending')?3:0,checks:tx.checks??[]};
    await saveDurable(statePath,JSON.stringify(tx));
   }
  }
  if(tx?.status==='complete') {
   await verifyInstalledTools(true);
   await verifyInitializedTools(true);
   const m=await loadManifest(root);if(m?.installId!==tx.installId)throw new Error('completed manifest changed');
   for(const f of data.files){const actual=await readFileState(root,f.target);if(!matchesFileState(actual,tx.files[f.target].after,tx.files[f.target].afterMode))throw new Error('installed target content or mode changed; prepare a new update preview');}
   completed=total;step('verified completed installation','reused');return {...tx.report!,written:[]};
  }
  if((currentManifest?digest(currentManifest):absentDigest)!==data.manifestDigest)throw new Error('manifest changed since preview');
  let discovery:NativeDiscoveryOptions={};
  const managedTargets=data.inputSnapshotVersion===2?data.files.map(file=>file.target):undefined;
  if(await installationInput(root,data.plan,discovery,managedTargets)!==data.inputSnapshot){
   if(data.nativeDiscoveryVersion||data.plan.options.sdd!=='openspec')throw Error('source input changed since preview');
   // Older approvals never observed optional external OpenSpec entries.
   discovery={legacyOpenSpecDiscovery:true};
   if(await installationInput(root,data.plan,discovery,managedTargets)!==data.inputSnapshot)throw Error('source input changed since preview');
  }
  if(!tx) {
   if((await scanRepository(root,data.plan.options,discovery)).fingerprint!==data.plan.fingerprint)throw new Error('research input changed since generation');
   const files=previewFileTransitions(data);
   for(const f of data.files){
    const actual=await readFileState(root,f.target);
    if(!matchesFileState(actual,f.observedDigest,f.observedMode))throw new Error('stale preview: target content or mode changed');
   }
   if(!dependencies.runChecks&&unchangedInstallation(data,files)){
    for(const asset of data.oldManifest!.assets){const bytes=await readTarget(root,asset.baseline!);if(!bytes||digest(bytes)!==asset.digest)throw Error('installed baseline changed since preview');}
    completed=total;step('verified unchanged installation','reused');
    return {...report,...pendingRules,status:'complete',exitCode:0};
   }
   tx={previewId,installId:randomUUID(),status:'prepared',files,receipts:{...(data.oldManifest?.installedTools??{})},initialized:{...(data.oldManifest?.initializedTools??{})},preview:{digest:signature(data),data}};
   await saveDurable(statePath,JSON.stringify(tx));
  }else for(const f of data.files){const actual=await readFileState(root,f.target),expected=tx.files[f.target];if(!matchesFileState(actual,expected.before,expected.beforeMode)&&!matchesFileState(actual,expected.after,expected.afterMode))throw new Error('interrupted target content or mode changed; preserve local edits and re-preview');}
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
  for(const f of data.files){
   if(dependencies.signal?.aborted)return {...report,exitCode:130};
   const actual=await readFileState(root,f.target);const expected=tx.files[f.target];
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
  report.checks=tx.checks;await dependencies.hook?.('after-checks');await verifyFiles();await verifyInstalledTools(true);await verifyInitializedTools(true);if(dependencies.signal?.aborted)return {...report,exitCode:130};
  const assets=[];
  for(const asset of data.assets){const b=data.baselines.find(b=>b.logicalId===asset.logicalId);if(!b)throw new Error('required baseline unavailable');const baseline='.rigup/baseline/'+tx.installId+'/'+signature(asset.logicalId);await atomicProjectWrite(root,baseline,b.encoding==='base64'?Buffer.from(b.content,'base64'):Buffer.from(b.content),0o600);assets.push({...asset,baseline});}
  const manifest:Manifest={...rules,schemaVersion:1,installId:tx.installId,assets,options:data.plan.options,versions:data.plan.versions,installedTools:tx.receipts,...(Object.keys(tx.initialized!).length?{initializedTools:tx.initialized}:{})};
  await dependencies.hook?.('before-manifest');await verifyFiles();
  await atomicProjectWrite(root,'.rigup/manifest.json',Buffer.from(JSON.stringify(manifest,null,2)+'\n'),0o600,false,async()=>{
   const actual=await readFileState(root,'.rigup/manifest.json');
   if(actual.digest!==data.manifestDigest)throw Error('manifest changed during apply');
  });
  await dependencies.hook?.('after-manifest');
  if(data.plan.options.agents.length&&data.plan.assets.length)report.warnings.push('Native host loading/reload is unverified; configuration installation is separate from live host acceptance');
  report.status='complete';report.exitCode=report.checks.some(c=>c.status==='failed')?1:report.checks.some(c=>c.status==='pending')?3:0;
  completed=total;step('manifest committed',report.exitCode===1?'failed':'complete');
  tx.status='complete';Object.assign(report,pendingRules);tx.report=report;await saveDurable(statePath,JSON.stringify(tx));return report;
 }finally{await release();}
}
