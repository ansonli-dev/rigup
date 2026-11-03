import {realpath,access,constants} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import type {CheckKind,SetupOptions,SetupOperation} from '../types.js';
import type {InstallReport} from './apply.js';
import {loadManifest,trustedBaseline} from './baseline.js';
import {ownedContent} from './ownership.js';
import {readTarget} from './preview.js';
import {scanRepository} from '../analyzer/repository.js';
import {runProjectChecks} from '../integrations/tools/quality.js';
import {loadUpstreamLock} from '../integrations/registry.js';
import {queryOperation,assertNoUnknownWriters} from './operations.js';
import {acquireLock} from './lock.js';
import {agents} from '../integrations/agents/index.js';
export interface DoctorOptions {runChecks?:CheckKind[];stateRoot?:string;signal?:AbortSignal}
export interface Diagnostic {category:'config'|'environment'|'host'|'tools'|'tests'|'eval';id:string;state:'configured'|'available'|'initialized'|'reload-required'|'passed'|'failed'|'pending';reason:string}
export async function doctor(root:string,options:DoctorOptions={}):Promise<InstallReport&{diagnostics:Diagnostic[]}>{
 root=await realpath(root);const diagnostics:Diagnostic[]=[];const report:InstallReport&{diagnostics:Diagnostic[]}={status:'pending',exitCode:3,previewId:'doctor',written:[],operations:[],checks:[],warnings:[],diagnostics};
 const add=(category:Diagnostic['category'],id:string,state:Diagnostic['state'],reason:string)=>diagnostics.push({category,id,state,reason});
 let manifest:Awaited<ReturnType<typeof loadManifest>>;try{manifest=await loadManifest(root);}catch{add('config','manifest','failed','Damaged ownership metadata; no repair or initialization performed');return {...report,status:'failed',exitCode:1};}
 if(!manifest){add('config','manifest','pending','No installation manifest; no setup performed');return report;}
 add('config','manifest','configured','Manifest schema readable');const selected:SetupOptions=manifest.options??{agents:[],backend:'native'};
 if(!manifest.options)add('config','selection','pending','Installed selection unavailable; cannot infer capabilities');
 for(const asset of manifest.assets){
  const baseline=await trustedBaseline(root,asset);if(baseline===undefined){add('config',asset.logicalId,'failed','Trusted generated baseline unavailable');continue;}
  try{const raw=await readTarget(root,asset.target);const local=ownedContent(raw?.toString(asset.encoding==='base64'?'base64':'utf8'),asset.ownership);if(local===undefined)add('config',asset.logicalId,'failed','Owned target or selector missing');else add('config',asset.logicalId,local===baseline?'configured':'pending',local===baseline?'Owned content present':'Local modification preserved; capability needs review');}
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
  const recipe=recipes.find(r=>r.integrationId===tool.id)!;const name=tool.id==='openwiki'?'openwiki':'@colbymchenry/codegraph';const prefix='.rigup/tools/'+tool.id;
  const probe:SetupOperation={id:'probe:'+tool.id,integrationId:tool.id,kind:'install',version:recipe.version,parameters:{executable:'npm',args:['--prefix',resolve(root,prefix)],cwd:'.',envRefs:[]},prerequisiteIds:[],declaredWrites:[prefix],timeoutMs:1,protection:{kind:'new-empty-scope',target:prefix},query:{kind:'npm-package',name,version:recipe.version,integrity:recipe.packageIntegrity,packageJson:prefix+'/node_modules/'+name+'/package.json',packageLock:prefix+'/package-lock.json'}};
  const result=await queryOperation(probe);const receipt=manifest.installedTools?.[tool.id];const verified=result.status==='done'&&receipt?.packageLockDigest===result.receipt?.packageLockDigest;
  add('tools',tool.id+':binary',verified?'available':'pending',verified?'Pinned package, dependency tree, launcher and receipt verified':'Project installation unavailable/unreceipted; no install or global change performed');
  add('tools',tool.id+':initialization','pending','Native initialization not observed; no database inspected or initialization executed');
 }
 if(options.runChecks?.length){const lock=await acquireLock(root,{stateRoot:options.stateRoot});try{await assertNoUnknownWriters(root,lock.stateRoot);report.checks=await runProjectChecks(await scanRepository(root,selected),options.runChecks,options.signal);}finally{await lock.release();}}
 for(const check of report.checks)add(check.name==='eval'?'eval':check.name==='environment'?'environment':'tests',check.name,check.status,check.message??'Actual selected command result; separate from installation status');
 const failed=diagnostics.some(d=>d.state==='failed');const pending=diagnostics.some(d=>d.state==='pending'||d.state==='reload-required');report.status=diagnostics.some(d=>d.category==='config'&&d.state==='failed')?'failed':'complete';report.exitCode=options.signal?.aborted?130:failed?1:pending?3:0;return report;
}
