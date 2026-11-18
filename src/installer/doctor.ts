import {realpath,access,constants,stat,lstat} from 'node:fs/promises';
import {delimiter,join} from 'node:path';
import {makeReason,reasonDetail,reasonFallback,reasonFromError,type ReasonInput,type WithReasonDetail} from '../i18n/reasons.js';
import type {CheckKind,SetupOptions} from '../types.js';
import {interruptedApplyId,interruptedSeedApplyId,type InstallReport} from './apply.js';
import {quoteShell} from '../shell-command.js';
import {loadManifest,sourceReview,trustedBaseline,type SourceReview} from './baseline.js';
import {equalOwnedContent,LinkedRigupDirectoryError,ownedContent,targetPath} from './ownership.js';
import {readTarget} from './preview.js';
import {readFileState,platformFileMode} from './file-state.js';
import {scanRepository} from '../analyzer/repository.js';
import {runProjectChecks} from '../integrations/tools/quality.js';
import {planHarness} from '../generator/harness.js';
import {assertNoUnknownWriters} from './operations.js';
import {acquireLock,defaultStateRoot} from './lock.js';
import {agents} from '../integrations/agents/index.js';
import {readVerifiedToolInstall} from '../integrations/tools/installed-state.js';
import {verifyToolInitializationReceipt} from '../integrations/tools/native-state.js';
import {openwikiInitializationGuide} from '../integrations/tools/openwiki.js';
import {probeClaudeProjectMcp} from '../integrations/agents/claude-health.js';
import {runtimeDestination,runtimeSetupSummary} from '../runtime-inputs.js';
import {probeRigupProjectMcp} from '../integrations/agents/rigup-health.js';
import {RIGUP_VERSION} from '../version.js';
import {checkHostNode,consumerPath} from '../npm-command.mjs';
import {detectExternalTool} from '../integrations/tools/global-npm.js';
export interface DoctorOptions {checkHost?:'claude';runChecks?:CheckKind[];stateRoot?:string;signal?:AbortSignal}
export const diagnosticTarget:unique symbol=Symbol('diagnosticTarget');
export interface Diagnostic extends WithReasonDetail {[diagnosticTarget]?:string;category:'config'|'environment'|'host'|'tools'|'tests'|'eval';id:string;state:'configured'|'available'|'initialized'|'reload-required'|'passed'|'failed'|'pending';reason:string}

async function hostExecutableAvailable(name:string):Promise<boolean>{
 const extensions=process.platform==='win32'
  ? [...(process.env.PATHEXT??'.COM;.EXE;.BAT;.CMD').split(';').filter(ext=>/^\.[a-z\d]+$/i.test(ext)),'.ps1']
  : [''];
 for(const entry of (process.env.PATH??'').split(delimiter)){
  const directory=entry.replace(/^"(.*)"$/,'$1');
  if(!directory)continue;
  for(const extension of extensions){
   const candidate=join(directory,name+extension);
   try{if(!(await stat(candidate)).isFile())continue;await access(candidate,constants.X_OK);return true;}catch{}
  }
 }
 return false;
}

async function completedOpenWikiBaseline(root:string):Promise<boolean>{
 try{
  const marker=await readTarget(root,'openwiki/.last-update.json');
  if(!marker||JSON.parse(marker.toString('utf8'))?.status!=='complete')return false;
  for(const target of ['openwiki/index.md','openwiki/quickstart.md']){
   const info=await lstat(await targetPath(root,target));
   if(!info.isFile()||!info.size)return false;
  }
  return true;
 }catch{return false;}
}

export async function doctor(root:string,options:DoctorOptions={}):Promise<InstallReport&{diagnostics:Diagnostic[]}>{
 root=await realpath(root);const diagnostics:Diagnostic[]=[];const report:InstallReport&{diagnostics:Diagnostic[]}={status:'pending',exitCode:3,previewId:'doctor',written:[],operations:[],checks:[],warnings:[],diagnostics};
 const add=(category:Diagnostic['category'],id:string,state:Diagnostic['state'],reason:ReasonInput,target?:string)=>{
  diagnostics.push({category,id,state,reason:reasonFallback(reason),[reasonDetail]:reason,[diagnosticTarget]:target});
 };
 let manifest:Awaited<ReturnType<typeof loadManifest>>;
 try{manifest=await loadManifest(root);}catch(error){
  add('config','manifest','failed',error instanceof LinkedRigupDirectoryError?reasonFromError(error):makeReason('doctor.manifestDamaged'));
  return {...report,status:'failed',exitCode:1};
 }
 let interrupted:string|undefined;
 let pendingReview:SourceReview|undefined;
 const stateRoot=options.stateRoot??defaultStateRoot();
 try{interrupted=await interruptedApplyId(root,stateRoot);pendingReview=await sourceReview(root,manifest,stateRoot);}
 catch{add('config','installation','failed',makeReason('doctor.recoveryDamaged'));return {...report,status:'failed',exitCode:1};}
 if(interrupted){
  add('config','installation','pending',makeReason('doctor.interrupted'));
  report.nextCommand='rigup update '+quoteShell(root)+' --resume --review';
 }
 if(!manifest){add('config','manifest','pending',makeReason('doctor.manifestMissing'));return report;}
 add('config','manifest','configured',makeReason('doctor.manifestReadable'));const selected:SetupOptions=manifest.options??{agents:[],backend:'native'};
 if(pendingReview){
  report.projectRules='pending';
  report.sourceReview=pendingReview;
  report.nextCommand??='rigup update '+quoteShell(root)+' --review';
  add('config','project-rules','pending',makeReason('result.reviewWait'));
 }else if(manifest.projectRules){
  report.projectRules=manifest.projectRules;
  if(manifest.projectRules==='pending')add('config','project-rules','pending',makeReason('doctor.rulesPending'));
 }
 if(!manifest.options)add('config','selection','pending',makeReason('doctor.selectionMissing'));
 for(const asset of manifest.assets){
  const addAsset=(state:Diagnostic['state'],reason:ReasonInput)=>add('config',asset.logicalId,state,reason,asset.target);
  const baseline=await trustedBaseline(root,asset);if(baseline===undefined){addAsset('failed',makeReason('doctor.baselineMissing'));continue;}
  try{
   const actual=await readFileState(root,asset.target);
   const local=ownedContent(actual.bytes?.toString(asset.encoding==='base64'?'base64':'utf8'),asset.ownership);
   if(local===undefined)addAsset('failed',makeReason('doctor.targetMissing'));
   else if(asset.mode!==undefined&&actual.mode!==platformFileMode(asset.effectiveMode??asset.mode))addAsset('pending',makeReason('doctor.modeChanged'));
   else if(equalOwnedContent(asset.ownership,local,baseline))addAsset('configured',makeReason('doctor.contentPresent'));
   else addAsset('pending',makeReason('doctor.modified'));
  }
  catch{addAsset('failed',makeReason('doctor.ownershipInvalid'));}
 }
 for(const agent of selected.agents){
  const available=await hostExecutableAvailable(agent);
  add('host',agent+':binary',available?'available':'pending',available?makeReason('doctor.binaryFound'):makeReason('doctor.binaryMissing'));
  const host=agents[agent];const wired=manifest.assets.some(a=>a.target.startsWith(host.skillDirectory+'/')||a.target===host.mcpTarget||a.target===host.entry);
  let state:Diagnostic['state']=wired?'reload-required':'pending';
  let reason=wired?makeReason('doctor.hostReload'):makeReason('doctor.hostUnconfigured');
  if(agent==='claude'&&wired){
   const servers=manifest.assets.filter(asset=>asset.target===host.mcpTarget&&asset.logicalId.startsWith('mcp:claude:'));
   if(options.checkHost===agent&&servers.length){
    const ids=servers.map(asset=>asset.logicalId.slice('mcp:claude:'.length));
    if(servers.every(asset=>diagnostics.some(d=>d.category==='config'&&d.id===asset.logicalId&&d.state==='configured'))){
     const connected=await probeClaudeProjectMcp(root,ids,options.signal);
     if(connected.length===ids.length){
      state='passed';
      reason=makeReason('reason.doctor.claudeConnected',{servers:connected.join(', ')});
      if(ids.includes('rigup')){
       const expected=manifest.versions?.rigup??RIGUP_VERSION,observed=await probeRigupProjectMcp(root,options.signal);
       const matches=observed===expected;
       add('host','rigup:version',matches?'passed':'failed',observed?makeReason('reason.doctor.mcpVersion',{observed,expected}):makeReason('reason.doctor.mcpVersionUnverified'));
       if(!matches){state='reload-required';reason=makeReason('doctor.hostVersion');}
      }
     }else reason=makeReason('reason.doctor.claudeUnconfirmed',{servers:ids.filter(id=>!connected.includes(id)).join(', ')});
    }else reason=makeReason('doctor.hostProbe');
   }else if(servers.length)reason=makeReason('doctor.hostReloadClaude');
  }
  add('host',agent+':load',state,reason);
 }
 const toolPath=consumerPath();
 if(selected.tools?.length){
  const nodeIssue=await checkHostNode(root,toolPath);
  add('tools','tools:host-node',nodeIssue?'pending':'available',nodeIssue?makeReason('reason.doctor.nodeIssue',undefined,nodeIssue):makeReason('doctor.nodeFound'));
 }
 for(const tool of selected.tools??[]){
  const installed=manifest.installedTools?.[tool.id];
  const useProject=tool.install||tool.initialize&&!!installed;
  const verified=useProject?await readVerifiedToolInstall(root,tool.id,installed):undefined;
  const external=useProject?undefined:await detectExternalTool(root,tool.id,toolPath,stateRoot);
  const configure='rigup update '+quoteShell(root)+' --configure --tools '+selected.tools!.map(tool=>tool.id).join(',');
  add('tools',tool.id+':binary',verified||external?.state==='available'?'available':'pending',verified?makeReason('reason.doctor.toolVersion',{version:verified.version}):external?.state==='available'?makeReason('doctor.externalFound'):external?.state==='repair'?external.reason:external?makeReason('reason.doctor.toolMissing',{configure}):makeReason('doctor.receipt'));
  const nativeReceipt=manifest.initializedTools?.[tool.id];
  const native=verified&&await verifyToolInitializationReceipt(root,tool.id,verified,nativeReceipt);
  const externalWiki=!native&&tool.id==='openwiki'&&await completedOpenWikiBaseline(root);
  const initializationReason=native?native.message:externalWiki?makeReason('doctor.wikiBaseline'):tool.id==='openwiki'?makeReason(nativeReceipt?'reason.doctor.wikiReconcile':'reason.doctor.wikiInitialize',undefined,(nativeReceipt?'Existing native ownership/state needs reconciliation. ':'')+openwikiInitializationGuide):makeReason('doctor.nativeUnavailable');
  add('tools',tool.id+':initialization',native||externalWiki?'initialized':'pending',initializationReason);
 }
 let profile:Awaited<ReturnType<typeof scanRepository>>|undefined;
 if(interrupted&&await interruptedSeedApplyId(root,stateRoot)){
  report.warnings.push('Harness discovery is waiting for the original customer document installation to be reconciled.');
 }else if(options.runChecks?.length){
  const lock=await acquireLock(root,{stateRoot:options.stateRoot});
  try{
   await assertNoUnknownWriters(root,lock.stateRoot);
   profile=await scanRepository(root,selected);
   report.checks=await runProjectChecks(profile,options.runChecks,options.signal,selected);
  }finally{await lock.release();}
 }else{
  try{profile=await scanRepository(root,selected);}
  catch{report.warnings.push('Harness discovery unavailable under the current repository read policy.');}
 }
 if(profile){
  report.harness=planHarness(profile,selected,[]).summary;
  report.warnings.push(...profile.unknowns);
 }
 report.runtimeSetup=await runtimeSetupSummary(root,selected,{configured:['*'],verified:report.checks.filter(check=>check.status==='passed').map(check=>'customer:'+check.name)});
 for(const input of report.runtimeSetup.inputs){
  if(input.state==='optional')continue;
  let reason=makeReason('reason.doctor.envDestination',{reason:input[reasonDetail]??input.reason,destination:input[runtimeDestination]??input.destination});
  if(input.source)reason=makeReason('reason.doctor.envSource',{reason,source:makeReason(`runtime.source.${input.source}`,undefined,input.source)});
  if(input.state==='unverified')reason=makeReason('reason.doctor.envUnverified',{reason});
  add('environment','env:'+input.name,input.state==='present'?'available':'pending',reason);
 }
 if(report.runtimeSetup.template.state==='pending')add('environment','runtime-template','pending',report.runtimeSetup.template[reasonDetail]??report.runtimeSetup.template.reason??makeReason('doctor.runtimePending'));
 for(const check of report.checks)add(check.name==='eval'?'eval':check.name==='environment'?'environment':'tests',check.name,check.status,check.message??makeReason('doctor.checkResult'));
 const failed=diagnostics.some(d=>d.state==='failed');const pending=diagnostics.some(d=>d.state==='pending'||d.state==='reload-required');report.status=diagnostics.some(d=>d.category==='config'&&d.state==='failed')?'failed':interrupted?'pending':'complete';report.exitCode=options.signal?.aborted?130:failed?1:pending?3:0;return report;
}
