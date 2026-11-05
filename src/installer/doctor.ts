import {realpath,access,constants} from 'node:fs/promises';
import {join} from 'node:path';
import type {CheckKind,SetupOptions} from '../types.js';
import type {InstallReport} from './apply.js';
import {loadManifest,trustedBaseline} from './baseline.js';
import {ownedContent} from './ownership.js';
import {readTarget} from './preview.js';
import {readFileState} from './file-state.js';
import {scanRepository} from '../analyzer/repository.js';
import {runProjectChecks} from '../integrations/tools/quality.js';
import {loadUpstreamLock} from '../integrations/upstream.js';
import {assertNoUnknownWriters} from './operations.js';
import {acquireLock} from './lock.js';
import {agents} from '../integrations/agents/index.js';
import {verifyToolInstallReceipt} from '../integrations/tools/installed-state.js';
import {verifyToolInitializationReceipt} from '../integrations/tools/native-state.js';
import {openwikiInitializationGuide} from '../integrations/tools/openwiki.js';
export interface DoctorOptions {runChecks?:CheckKind[];stateRoot?:string;signal?:AbortSignal}
export interface Diagnostic {category:'config'|'environment'|'host'|'tools'|'tests'|'eval';id:string;state:'configured'|'available'|'initialized'|'reload-required'|'passed'|'failed'|'pending';reason:string}
export async function doctor(root:string,options:DoctorOptions={}):Promise<InstallReport&{diagnostics:Diagnostic[]}>{
 root=await realpath(root);const diagnostics:Diagnostic[]=[];const report:InstallReport&{diagnostics:Diagnostic[]}={status:'pending',exitCode:3,previewId:'doctor',written:[],operations:[],checks:[],warnings:[],diagnostics};
 const add=(category:Diagnostic['category'],id:string,state:Diagnostic['state'],reason:string)=>diagnostics.push({category,id,state,reason});
 let manifest:Awaited<ReturnType<typeof loadManifest>>;try{manifest=await loadManifest(root);}catch{add('config','manifest','failed','Damaged ownership metadata; no repair or initialization performed');return {...report,status:'failed',exitCode:1};}
 if(!manifest){add('config','manifest','pending','No installation manifest; no setup performed');return report;}
 add('config','manifest','configured','Manifest schema readable');const selected:SetupOptions=manifest.options??{agents:[],backend:'native'};
 if(manifest.projectRules){
  report.projectRules=manifest.projectRules;
  if(manifest.projectRules==='pending')add('config','project-rules','pending','Foundation installed. Run rigup update --review to prepare project rules.');
 }
 if(!manifest.options)add('config','selection','pending','Installed selection unavailable; cannot infer capabilities');
 for(const asset of manifest.assets){
  const baseline=await trustedBaseline(root,asset);if(baseline===undefined){add('config',asset.logicalId,'failed','Trusted generated baseline unavailable');continue;}
  try{const actual=await readFileState(root,asset.target);const local=ownedContent(actual.bytes?.toString(asset.encoding==='base64'?'base64':'utf8'),asset.ownership);if(local===undefined)add('config',asset.logicalId,'failed','Owned target or selector missing');else if(asset.mode!==undefined&&actual.mode!==asset.mode)add('config',asset.logicalId,'pending','Local file mode differs from the managed baseline; user chmod preserved, review actual executable permissions');else add('config',asset.logicalId,local===baseline?'configured':'pending',local===baseline?'Owned content present':'Local modification preserved; capability needs review');}
  catch{add('config',asset.logicalId,'failed','Configuration or ownership markers cannot be parsed safely');}
 }
 for(const agent of selected.agents){
  const binary=(process.env.PATH??'').split(':').map(p=>join(p,agent));let available=false;for(const path of binary){try{await access(path,constants.X_OK);available=true;break;}catch{}}
  add('host',agent+':binary',available?'available':'pending',available?'Executable present; version and loaded session not asserted':'Executable not found on current PATH');
  const host=agents[agent];const wired=manifest.assets.some(a=>a.target.startsWith(host.skillDirectory+'/')||a.target===host.mcpTarget||a.target===host.entry);
  add('host',agent+':load',wired?'reload-required':'pending',wired?'Reload affected sessions; current native loading has not been observed':'No native assets configured for this selected host');
 }
 const envRefs=new Set([...(selected.customer?.envRefs??[]),...(selected.mcp??[]).flatMap(m=>[...(m.envRefs??[]),...(m.command?.envRefs??[])]),...(selected.quality?.gitlab?.openwiki?.envRefs??[])]);
 for(const ref of envRefs)add('environment','env:'+ref,process.env[ref]?'available':'pending',process.env[ref]?'Environment reference is available; value omitted':'Missing credential/environment reference; value never stored');
 const recipes=await loadUpstreamLock();for(const tool of selected.tools??[]){
  const recipe=recipes.find(r=>r.integrationId===tool.id)!;
  const verified=await verifyToolInstallReceipt(root,tool.id,recipe,manifest.installedTools?.[tool.id]);
  add('tools',tool.id+':binary',verified?'available':'pending',verified?'Pinned package, dependency tree, launcher and receipt verified':'Project installation unavailable/unreceipted; no install or global change performed');
  const nativeReceipt=manifest.initializedTools?.[tool.id];
  const native=await verifyToolInitializationReceipt(root,tool.id,recipe,nativeReceipt);
  const initializationReason=native?native.message:tool.id==='openwiki'?(nativeReceipt?'Existing native ownership/state needs reconciliation. ':'')+openwikiInitializationGuide:'Native initialization unavailable or ownership/state changed; no initialization or repair executed';
  add('tools',tool.id+':initialization',native?'initialized':'pending',initializationReason);
 }
 if(options.runChecks?.length){const lock=await acquireLock(root,{stateRoot:options.stateRoot});try{await assertNoUnknownWriters(root,lock.stateRoot);report.checks=await runProjectChecks(await scanRepository(root,selected),options.runChecks,options.signal);}finally{await lock.release();}}
 for(const check of report.checks)add(check.name==='eval'?'eval':check.name==='environment'?'environment':'tests',check.name,check.status,check.message??'Actual selected command result; separate from installation status');
 const failed=diagnostics.some(d=>d.state==='failed');const pending=diagnostics.some(d=>d.state==='pending'||d.state==='reload-required');report.status=diagnostics.some(d=>d.category==='config'&&d.state==='failed')?'failed':'complete';report.exitCode=options.signal?.aborted?130:failed?1:pending?3:0;return report;
}
