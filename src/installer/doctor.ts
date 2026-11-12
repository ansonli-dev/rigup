import {realpath,access,constants,stat,lstat} from 'node:fs/promises';
import {delimiter,join} from 'node:path';
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
import {loadUpstreamLock} from '../integrations/upstream.js';
import {assertNoUnknownWriters} from './operations.js';
import {acquireLock,defaultStateRoot} from './lock.js';
import {agents} from '../integrations/agents/index.js';
import {verifyToolInstallReceipt} from '../integrations/tools/installed-state.js';
import {verifyToolInitializationReceipt} from '../integrations/tools/native-state.js';
import {openwikiInitializationGuide} from '../integrations/tools/openwiki.js';
import {probeClaudeProjectMcp} from '../integrations/agents/claude-health.js';
import {runtimeSetupSummary} from '../runtime-inputs.js';
import {probeRigupProjectMcp} from '../integrations/agents/rigup-health.js';
import {RIGUP_VERSION} from '../version.js';
export interface DoctorOptions {checkHost?:'claude';runChecks?:CheckKind[];stateRoot?:string;signal?:AbortSignal}
export interface Diagnostic {category:'config'|'environment'|'host'|'tools'|'tests'|'eval';id:string;state:'configured'|'available'|'initialized'|'reload-required'|'passed'|'failed'|'pending';reason:string}

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
 const add=(category:Diagnostic['category'],id:string,state:Diagnostic['state'],reason:string)=>diagnostics.push({category,id,state,reason});
 let manifest:Awaited<ReturnType<typeof loadManifest>>;
 try{manifest=await loadManifest(root);}catch(error){
  add('config','manifest','failed',error instanceof LinkedRigupDirectoryError?error.message:'Damaged ownership metadata; no repair or initialization performed');
  return {...report,status:'failed',exitCode:1};
 }
 let interrupted:string|undefined;
 let pendingReview:SourceReview|undefined;
 const stateRoot=options.stateRoot??defaultStateRoot();
 try{interrupted=await interruptedApplyId(root,stateRoot);pendingReview=await sourceReview(root,manifest,stateRoot);}
 catch{add('config','installation','failed','Installation recovery record is unavailable or damaged');return {...report,status:'failed',exitCode:1};}
 if(interrupted){
  add('config','installation','pending','An approved installation was interrupted. Review the saved preview before resuming.');
  report.nextCommand='rigup update '+quoteShell(root)+' --resume --review';
 }
 if(!manifest){add('config','manifest','pending','No installation manifest; no setup performed');return report;}
 add('config','manifest','configured','Manifest schema readable');const selected:SetupOptions=manifest.options??{agents:[],backend:'native'};
 if(pendingReview){
  report.projectRules='pending';
  report.sourceReview=pendingReview;
  report.nextCommand??='rigup update '+quoteShell(root)+' --review';
  add('config','project-rules','pending','Approved rule sources changed. Review current sources before relying on project rules.');
 }else if(manifest.projectRules){
  report.projectRules=manifest.projectRules;
  if(manifest.projectRules==='pending')add('config','project-rules','pending','Foundation installed. Run rigup update --review to prepare project rules.');
 }
 if(!manifest.options)add('config','selection','pending','Installed selection unavailable; cannot infer capabilities');
 for(const asset of manifest.assets){
  const baseline=await trustedBaseline(root,asset);if(baseline===undefined){add('config',asset.logicalId,'failed','Trusted generated baseline unavailable');continue;}
  try{
   const actual=await readFileState(root,asset.target);
   const local=ownedContent(actual.bytes?.toString(asset.encoding==='base64'?'base64':'utf8'),asset.ownership);
   if(local===undefined)add('config',asset.logicalId,'failed','Owned target or selector missing');
   else if(asset.mode!==undefined&&actual.mode!==platformFileMode(asset.mode))add('config',asset.logicalId,'pending','Local file mode differs from the managed baseline; user chmod preserved, review actual executable permissions');
   else if(equalOwnedContent(asset.ownership,local,baseline))add('config',asset.logicalId,'configured','Owned content present');
   else add('config',asset.logicalId,'pending','Local modification preserved; capability needs review');
  }
  catch{add('config',asset.logicalId,'failed','Configuration or ownership markers cannot be parsed safely');}
 }
 for(const agent of selected.agents){
  const available=await hostExecutableAvailable(agent);
  add('host',agent+':binary',available?'available':'pending',available?'Executable found on current PATH':'Executable not found on current PATH');
  const host=agents[agent];const wired=manifest.assets.some(a=>a.target.startsWith(host.skillDirectory+'/')||a.target===host.mcpTarget||a.target===host.entry);
  let state:Diagnostic['state']=wired?'reload-required':'pending';
  let reason=wired?'Reload affected sessions and verify loading in the host':'No native assets configured for this selected host';
  if(agent==='claude'&&wired){
   const servers=manifest.assets.filter(asset=>asset.target===host.mcpTarget&&asset.logicalId.startsWith('mcp:claude:'));
   if(options.checkHost===agent&&servers.length){
    const ids=servers.map(asset=>asset.logicalId.slice('mcp:claude:'.length));
    if(servers.every(asset=>diagnostics.some(d=>d.category==='config'&&d.id===asset.logicalId&&d.state==='configured'))){
     const connected=await probeClaudeProjectMcp(root,ids,options.signal);
     if(connected.length===ids.length){
      state='passed';
      reason='A fresh Claude Code probe connected to the managed project MCP servers: '+connected.join(', ');
      if(ids.includes('rigup')){
       const expected=manifest.versions?.rigup??RIGUP_VERSION,observed=await probeRigupProjectMcp(root,options.signal);
       const matches=observed===expected;
       add('host','rigup:version',matches?'passed':'failed',observed?'Rigup MCP serverInfo.version '+observed+'; project requires '+expected:'Rigup MCP version could not be verified through the managed project launcher. Check the first Rigup installation on PATH and regenerate setup with the matching version.');
       if(!matches){state='reload-required';reason='Rigup responding version is stale or unavailable; review PATH and reload the project MCP server.';}
      }
     }else reason='Claude Code did not confirm project-scoped connections for: '+ids.filter(id=>!connected.includes(id)).join(', ')+'. Check approvals and connection status in /mcp.';
    }else reason='Review the managed MCP configuration before probing Claude Code';
   }else if(servers.length)reason+=' or run rigup doctor --check-host claude for a fresh MCP probe';
  }
  add('host',agent+':load',state,reason);
 }
 const recipes=await loadUpstreamLock();for(const tool of selected.tools??[]){
  const recipe=recipes.find(r=>r.integrationId===tool.id)!;
  const verified=await verifyToolInstallReceipt(root,tool.id,recipe,manifest.installedTools?.[tool.id]);
  add('tools',tool.id+':binary',verified?'available':'pending',verified?'Pinned package, dependency tree, launcher and receipt verified':'Project installation unavailable/unreceipted; no install or global change performed');
  const nativeReceipt=manifest.initializedTools?.[tool.id];
  const native=await verifyToolInitializationReceipt(root,tool.id,recipe,nativeReceipt);
  const externalWiki=!native&&tool.id==='openwiki'&&await completedOpenWikiBaseline(root);
  const initializationReason=native?native.message:externalWiki?'Completed native OpenWiki baseline observed outside Rigup ownership':tool.id==='openwiki'?(nativeReceipt?'Existing native ownership/state needs reconciliation. ':'')+openwikiInitializationGuide:'Native initialization unavailable or ownership/state changed; no initialization or repair executed';
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
  add('environment','env:'+input.name,input.state==='present'?'available':'pending',input.reason+'; destination: '+input.destination+(input.source?'; source: '+input.source:'')+(input.state==='unverified'?'; verify in its host or CI runner':''));
 }
 if(report.runtimeSetup.template.state==='pending')add('environment','runtime-template','pending',report.runtimeSetup.template.reason??'Private runtime inputs need attention');
 for(const check of report.checks)add(check.name==='eval'?'eval':check.name==='environment'?'environment':'tests',check.name,check.status,check.message??'Actual selected command result; separate from installation status');
 const failed=diagnostics.some(d=>d.state==='failed');const pending=diagnostics.some(d=>d.state==='pending'||d.state==='reload-required');report.status=diagnostics.some(d=>d.category==='config'&&d.state==='failed')?'failed':interrupted?'pending':'complete';report.exitCode=options.signal?.aborted?130:failed?1:pending?3:0;return report;
}
