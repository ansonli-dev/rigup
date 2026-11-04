import type {RunProgressEvent} from '../progress.js';
import {prepareIntegrations,loadUpstreamLock} from '../integrations/registry.js';
import {queryInstalledTool} from '../integrations/tools/installed-state.js';
import {PROMPT_VERSION} from '../analyzer/prompts.js';
import {READ_POLICY_VERSION} from '../analyzer/read-policy.js';
import {TEMPLATE_VERSION} from '../generator/render.js';
import {DOCUMENT_POLICY_VERSION} from '../generator/document-policy.js';
import {saveDurable} from './state.js';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {unlink,lstat,readFile} from 'node:fs/promises';
import type {CommandSpec,SetupOptions} from '../types.js';
import {initializationRecipe,type NativeTool} from '../integrations/tools/initialization.js';
import {loadPreview,readTarget,operationPrecondition,installationInput,absentDigest,type PreviewData} from './preview.js';
import {acquireLock,type ProjectLock} from './lock.js';
import {assertNoUnknownWriters,executeOperation,queryOperation,type OperationDependencies,type OperationResult} from './operations.js';
import {privateDirectory,signature,readCache,saveCache} from '../generator/cache.js';
import {digest} from '../analyzer/evidence.js';
import {scanRepository} from '../analyzer/repository.js';
import {atomicProjectWrite} from './manifest.js';
import {targetPath,ownedContent} from './ownership.js';
import {loadManifest,type Manifest} from './baseline.js';
import {runProjectChecks} from '../integrations/tools/quality.js';
export interface CheckResult {status:'passed'|'failed'|'pending';name:string;message?:string;command?:CommandSpec;fingerprint?:string;commit?:string;startedAt?:string;finishedAt?:string;environment?:{node:string;platform:string};exitCode?:number}
export interface InstallReport {status:'complete'|'failed'|'pending';exitCode:0|1|3|130;previewId:string;written:string[];operations:OperationResult[];checks:CheckResult[];warnings:string[]}
export interface ApplyDependencies {cacheRoot?:string;onProgress?:(event:RunProgressEvent)=>void;stateRoot?:string;lock?:ProjectLock;recover?:boolean;signal?:AbortSignal;hook?:(point:string)=>Promise<void>;runChecks?:()=>Promise<CheckResult[]>;operation?:OperationDependencies}
interface Transaction {previewId:string;installId:string;status:'prepared'|'complete';files:Record<string,{before:string;after:string}>;checks?:CheckResult[];receipts:NonNullable<Manifest['installedTools']>;initialized?:NonNullable<Manifest['initializedTools']>;preview?:{digest:string;data:PreviewData};report?:InstallReport}
export async function restoreInterruptedPreview(root:string,options:SetupOptions,cacheRoot:string,stateRoot:string):Promise<string|undefined>{
 const tx=await readCache<Transaction>(join(stateRoot,signature(root)+'.apply.json'));
 if(tx?.status!=='prepared')return;
 const stored=tx.preview;
 if(!stored||stored.digest!==signature(stored.data)||stored.data.plan.root!==root||stored.data.preview.previewId!==tx.previewId||!stored.data.preview.executable)throw Error('Durable interrupted preview unavailable or corrupted; manual reconciliation required');
 if(signature(stored.data.plan.options)!==signature(options))throw Error('Interrupted installation options changed; resume with the original selection');
 await privateDirectory(cacheRoot,root);await saveCache(join(cacheRoot,tx.previewId+'.json'),JSON.stringify(stored));return tx.previewId;
}
export async function apply(previewId:string,dependencies:ApplyDependencies={}):Promise<InstallReport>{
 const data=await loadPreview(previewId,dependencies.cacheRoot);if(!data.preview.executable)throw new Error('preview is blocked; prepare a new preview');
 const root=data.plan.root;const lock=dependencies.lock??await acquireLock(root,{stateRoot:dependencies.stateRoot,recover:dependencies.recover});
 if(lock.root!==root)throw new Error('execution lock root mismatch');
 const release=dependencies.lock?async()=>{}:()=>lock.release();
 let completed=0;const total=data.plan.operations.length+data.files.length+1;const step=(task:string,status:RunProgressEvent['status']='running')=>dependencies.onProgress?.({stage:'apply',unit:'steps',task,completed,total,status,next:'verify actual wiring and commit manifest'});step('preconditions');
 const report:InstallReport={status:'pending',exitCode:3,previewId,written:[],operations:[],checks:[],warnings:[...data.preview.warnings]};
 try {
  await assertNoUnknownWriters(root,lock.stateRoot);
  const versions={prompt:PROMPT_VERSION,read:READ_POLICY_VERSION,template:TEMPLATE_VERSION,document:DOCUMENT_POLICY_VERSION};
  for(const [key,value] of Object.entries(versions))if(data.plan.versions[key]!==undefined&&data.plan.versions[key]!==value)throw new Error('implementation version changed; regenerate preview');
  if(data.plan.assets.some(a=>['customer-template','customer-skill'].includes(a.source.kind))){const fresh=await prepareIntegrations(await scanRepository(root,data.plan.options),data.plan.options);for(const a of data.plan.assets.filter(a=>['customer-template','customer-skill'].includes(a.source.kind))){const current=fresh.assets.find(n=>n.logicalId===a.logicalId);if(!current||signature(current)!==signature(a))throw new Error('customer source/template changed since preview');}}
  const statePath=join(lock.stateRoot,signature(root)+'.apply.json');let tx=await readCache<Transaction>(statePath);
  if(tx&&tx.previewId!==previewId&&tx.status!=='complete'){if(!dependencies.recover)throw new Error('different interrupted installation requires reconciliation with a fresh preview and --resume');await saveDurable(statePath+'.reconciled-'+tx.previewId+'.json',JSON.stringify(tx));}
  if(tx?.previewId!==previewId)tx=undefined;
  if(tx)tx.initialized??={};
  const verifyInstalledTools=async(all=false)=>{
   const selected=(data.plan.options.tools??[]).filter(t=>(t.install||t.initialize)&&(all||!data.plan.operations.some(o=>o.kind==='install'&&o.integrationId===t.id)));
   if(!selected.length)return;const recipes=await loadUpstreamLock();
   for(const tool of selected){const receipt=tx?.receipts[tool.id]??data.oldManifest?.installedTools?.[tool.id];const recipe=recipes.find(r=>r.integrationId===tool.id);if(!receipt||!recipe||receipt.version!==recipe.version)throw new Error('selected installed tool lacks a compatible receipt; reconciliation required');const state=await queryInstalledTool(root,{prefix:'.rigup/tools/'+tool.id,id:tool.id,name:tool.id==='openwiki'?'openwiki':'@colbymchenry/codegraph',version:recipe.version,integrity:recipe.packageIntegrity,lockDigest:receipt.packageLockDigest});if(state.status!=='done')throw new Error('selected installed tool changed since preview; manual reconciliation required');}
  };
  const verifyInitializedTools=async(all=false)=>{
   const selected=(data.plan.options.tools??[]).filter(t=>t.initialize&&(all||!data.plan.operations.some(o=>o.kind==='initialize'&&o.integrationId===t.id)));
   if(!selected.length)return;const recipes=await loadUpstreamLock();
   for(const tool of selected){const receipt=tx?.initialized?.[tool.id]??data.oldManifest?.initializedTools?.[tool.id];const recipe=recipes.find(r=>r.integrationId===tool.id)!;const queried=await queryOperation(initializationRecipe(root,tool.id,recipe.version,recipe.packageIntegrity));if(!receipt||queried.status!=='done'||signature(queried.nativeReceipt)!==signature(receipt))throw Error('Selected native initialization changed; protected reconciliation required');}
  };
  await verifyInstalledTools();
  await verifyInitializedTools();
  const currentManifest=await readTarget(root,'.rigup/manifest.json');
  if(tx?.status==='prepared'&&currentManifest) {
   const current=await loadManifest(root);
   if(current?.installId===tx.installId) {
    const expected:Manifest={schemaVersion:1,installId:tx.installId,assets:data.assets.map(a=>({...a,baseline:'.rigup/baseline/'+tx!.installId+'/'+signature(a.logicalId)})),options:data.plan.options,versions:data.plan.versions,installedTools:tx.receipts,...(Object.keys(tx.initialized!).length?{initializedTools:tx.initialized}:{})};
    if(signature(current)!==signature(expected))throw new Error('committed manifest differs from expected installation');
    for(const a of current.assets){const bytes=await readTarget(root,a.baseline!);if(!bytes||digest(bytes)!==a.digest)throw new Error('committed baseline unavailable');}
    await verifyInstalledTools(true);await verifyInitializedTools(true);tx.status='complete';tx.report={...report,status:'complete',exitCode:tx.checks?.some(c=>c.status==='failed')?1:tx.checks?.some(c=>c.status==='pending')?3:0,checks:tx.checks??[]};
    await saveDurable(statePath,JSON.stringify(tx));
   }
  }
  if(tx?.status==='complete') {
   await verifyInstalledTools(true);
   await verifyInitializedTools(true);
   const m=await loadManifest(root);if(m?.installId!==tx.installId)throw new Error('completed manifest changed');
   for(const f of data.files){const actual=await readTarget(root,f.target);if((actual?digest(actual):absentDigest)!==tx.files[f.target].after)throw new Error('installed target changed; prepare a new update preview');}
   completed=total;step('verified completed installation','reused');return {...tx.report!,written:[]};
  }
  if((currentManifest?digest(currentManifest):absentDigest)!==data.manifestDigest)throw new Error('manifest changed since preview');
  if(await installationInput(root,data.plan)!==data.inputSnapshot)throw new Error('source input changed since preview');
  if(!tx) {
   if((await scanRepository(root,data.plan.options)).fingerprint!==data.plan.fingerprint)throw new Error('research input changed since generation');
   tx={previewId,installId:randomUUID(),status:'prepared',files:{},receipts:{...(data.oldManifest?.installedTools??{})},initialized:{...(data.oldManifest?.initializedTools??{})},preview:{digest:signature(data),data}};
   for(const f of data.files){const actual=await readTarget(root,f.target);if((actual?digest(actual):absentDigest)!==f.observedDigest)throw new Error('stale preview: target changed');tx.files[f.target]={before:f.observedDigest,after:f.next===undefined?absentDigest:digest(f.encoding==='base64'?Buffer.from(f.next,'base64'):f.next)};}
   await saveDurable(statePath,JSON.stringify(tx));
  }else for(const f of data.files){const actual=await readTarget(root,f.target);const hash=actual?digest(actual):absentDigest;if(![tx.files[f.target].before,tx.files[f.target].after].includes(hash))throw new Error('interrupted target changed; preserve local edits and re-preview');}
  if(dependencies.signal?.aborted)return {...report,exitCode:130};
  const completedOperations=new Set<string>();
  for(const operation of data.plan.operations){
   if(dependencies.signal?.aborted)return {...report,exitCode:130};
   if(operation.prerequisiteIds.some(id=>!completedOperations.has(id)))throw Error('Operation prerequisite not completed');
   const receipt=operation.kind==='initialize'?tx.initialized?.[operation.integrationId]:tx.receipts[operation.integrationId];
   if(receipt){const queried=await queryOperation(operation);const actual=operation.kind==='initialize'?queried.nativeReceipt:queried.receipt;if(queried.status!=='done'||signature(actual)!==signature(receipt))throw new Error('receipted external state changed');report.operations.push(queried);completedOperations.add(operation.id);completed++;step(operation.id,'reused');continue;}
   step(operation.id);
   // The durable operation record decides reuse; an unowned existing prefix alone never authorizes it.
   const result=await executeOperation(operation,{...dependencies.operation,authorizationRef:previewId,stateRoot:lock.stateRoot,signal:dependencies.signal});report.operations.push(result);
   if(result.status!=='done')return {...report,exitCode:dependencies.signal?.aborted?130:result.status==='failed'?1:3,status:result.status==='failed'?'failed':'pending'};
   if(operation.kind==='initialize'){if(!result.nativeReceipt)throw Error('native initialization lacks verifiable receipt');tx.initialized![operation.integrationId]=result.nativeReceipt;}
   else {if(!result.receipt)throw new Error('external operation lacks verifiable receipt');tx.receipts[operation.integrationId]=result.receipt;}
   completedOperations.add(operation.id);completed++;step(operation.id);await saveDurable(statePath,JSON.stringify(tx));await dependencies.hook?.('after-operation');
  }
  for(const f of data.files){
   if(dependencies.signal?.aborted)return {...report,exitCode:130};
   const actual=await readTarget(root,f.target);const current=actual?digest(actual):absentDigest;const expected=tx.files[f.target];
   if(current===expected.after){completed++;step(f.target,'reused');continue;}
   if(current!==expected.before)throw new Error('target changed before write');
   // Backups are private and preserve actual L, never become the generated baseline.
   if(actual){const backup=join(lock.stateRoot,signature(root)+'.'+tx.installId+'.'+signature(f.target)+'.backup.json');await saveDurable(backup,JSON.stringify({target:f.target,bytes:actual.toString('base64')}));}
   if(f.next===undefined){if(actual)await unlink(await targetPath(root,f.target));}
   else {const mode=f.mode??(actual?(await lstat(await targetPath(root,f.target))).mode&0o777:0o644);await atomicProjectWrite(root,f.target,f.encoding==='base64'?Buffer.from(f.next,'base64'):Buffer.from(f.next),mode);}
   completed++;step(f.target);report.written.push(f.target);await dependencies.hook?.('after-file');
  }
  if(dependencies.signal?.aborted)return {...report,exitCode:130};
  const verifyFiles=async()=>{for(const f of data.files){const actual=await readTarget(root,f.target);if((actual?digest(actual):absentDigest)!==tx!.files[f.target].after)throw new Error('written configuration differs from preview; baseline not committed');}};
  await verifyFiles();
  if(!tx.checks){tx.checks=dependencies.runChecks?await dependencies.runChecks():data.plan.runChecks?.length?await runProjectChecks(await scanRepository(root,data.plan.options),data.plan.runChecks,dependencies.signal):[];await saveDurable(statePath,JSON.stringify(tx));}
  report.checks=tx.checks;await dependencies.hook?.('after-checks');await verifyFiles();await verifyInstalledTools(true);await verifyInitializedTools(true);if(dependencies.signal?.aborted)return {...report,exitCode:130};
  const assets=[];
  for(const asset of data.assets){const b=data.baselines.find(b=>b.logicalId===asset.logicalId);if(!b)throw new Error('required baseline unavailable');const baseline='.rigup/baseline/'+tx.installId+'/'+signature(asset.logicalId);await atomicProjectWrite(root,baseline,b.encoding==='base64'?Buffer.from(b.content,'base64'):Buffer.from(b.content),0o600);assets.push({...asset,baseline});}
  const manifest:Manifest={schemaVersion:1,installId:tx.installId,assets,options:data.plan.options,versions:data.plan.versions,installedTools:tx.receipts,...(Object.keys(tx.initialized!).length?{initializedTools:tx.initialized}:{})};
  await dependencies.hook?.('before-manifest');await verifyFiles();
  await atomicProjectWrite(root,'.rigup/manifest.json',Buffer.from(JSON.stringify(manifest,null,2)+'\n'),0o600);
  await dependencies.hook?.('after-manifest');
  if(data.plan.options.agents.length&&data.plan.assets.length)report.warnings.push('Native host loading/reload is unverified; configuration installation is separate from live host acceptance');
  report.status='complete';report.exitCode=report.checks.some(c=>c.status==='failed')?1:report.checks.some(c=>c.status==='pending')?3:0;
  completed=total;step('manifest committed',report.exitCode===1?'failed':'complete');
  tx.status='complete';tx.report=report;await saveDurable(statePath,JSON.stringify(tx));return report;
 }finally{await release();}
}
