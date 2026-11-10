import {parseDocument} from 'yaml';
import {filterContent} from '../analyzer/read-policy.js';
import {scanRepository} from '../analyzer/repository.js';
import type {NativeDiscoveryOptions} from '../analyzer/native-sources.js';
import {projectInput} from '../managed-input.js';
import {realpath} from 'node:fs/promises';
import {join,posix,isAbsolute} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import type {SetupPlan,ManagedAsset} from '../types.js';
import type {Ownership} from '../managed-input.js';
import type {PreparedAsset} from '../integrations/registry.js';
import {loadUpstreamLock} from '../integrations/upstream.js';
import {assertEmptyToolScopes} from '../integrations/tools/initialization.js';
import {assertToolOperationRecipe,isNativeTool} from '../integrations/tools/recipes.js';
import {verifyToolInstallReceipt} from '../integrations/tools/installed-state.js';
import {openwikiInitializationGuide} from '../integrations/tools/openwiki.js';
import {digest} from '../analyzer/evidence.js';
import {readFileState,readFileStates,absentDigest,platformFileMode} from './file-state.js';
export {absentDigest} from './file-state.js';
import {privateDirectory,signature,readCache,saveCache} from '../generator/cache.js';
import {markdownLinks,validateTemplateContent} from '../generator/document-policy.js';
import {loadManifest,trustedBaseline,type Manifest} from './baseline.js';
import {mergeManaged,type MergeResult} from './merge.js';
import {equalOwnedContent,ownedContent,replaceOwned,selectorsOverlap} from './ownership.js';
export interface PreviewResolution {target:string;selector:Ownership;observedDigest:string;observedMode?:number;action:'adopt'|'restore'|'replace'|'remove'}
export interface PreviewItem {logicalId:string;target:string;ownership:Ownership;action:MergeResult['action'];reason?:string;observedDigest:string;beforeMode?:number;afterMode?:number;before?:string;after?:string}
export interface Preview {noChanges?:true;projectRules?:SetupPlan['projectRules'];previewId:string;root:string;executable:boolean;runChecks?:SetupPlan['runChecks'];items:PreviewItem[];blockers:string[];operations:SetupPlan['operations'];warnings:string[]}
export interface PreviewFile {target:string;observedDigest:string;observedMode?:number;next?:string;encoding:'utf8'|'base64';mode?:number}
export interface PreviewData {schemaVersion:1;modePolicyVersion?:1;nativeDiscoveryVersion?:1;inputSnapshotVersion?:2;preview:Preview;plan:SetupPlan;oldManifest?:Manifest;manifestDigest:string;inputSnapshot:string;files:PreviewFile[];assets:ManagedAsset[];baselines:{logicalId:string;content:string;encoding:'utf8'|'base64'}[]}
export const defaultPreviewCache=()=>join(homedir(),'.cache','rigup','previews');
const targetKey=(target:string)=>process.platform==='win32'?target.toLowerCase():target;
export async function readTarget(root:string,target:string):Promise<Buffer|undefined>{return (await readFileState(root,target)).bytes;}
export async function loadPreview(previewId:string,cacheRoot=defaultPreviewCache()):Promise<PreviewData>{
 if(!/^[a-f0-9]{64}$/.test(previewId))throw new Error('preview id invalid');
 const value=await readCache<{digest:string;data:PreviewData}>(join(cacheRoot,previewId+'.json'));
 if(!value||value.digest!==signature(value.data)||value.data.preview.previewId!==previewId)throw new Error('private preview missing or corrupted');return value.data;
}
export function unchangedInstallation(data:PreviewData):boolean{
 const {oldManifest:old,plan}=data;
 if(!old?.options||!old.versions||plan.operations.length||plan.runChecks?.length||old.projectRules!==plan.projectRules)return false;
 if(signature(old.options)!==signature(plan.options)||signature(old.versions)!==signature(plan.versions))return false;
 const assets=(items:Manifest['assets'])=>items.map(({baseline,...item})=>item).sort((a,b)=>a.logicalId.localeCompare(b.logicalId));
 return signature(assets(old.assets))===signature(assets(data.assets))&&data.files.every(file=>{
  const after=file.next===undefined?absentDigest:digest(Buffer.from(file.next,file.encoding));
  return file.observedDigest===after&&file.observedMode===file.mode;
 });
}

export async function preview(plan:SetupPlan,resolutions:PreviewResolution[]=[],dependencies:{cacheRoot?:string;skipUnchanged?:boolean;reviewEntryBlocks?:boolean}={}):Promise<Preview>{
 const root=await realpath(plan.root);if(root!==plan.root)throw new Error('plan root must be canonical');
 const oldManifest=await loadManifest(root);const old=oldManifest?.assets??[];
 const blockers=plan.requirements.map(r=>r.integrationId+': '+r.reason);const items:PreviewItem[]=[];
 for(const a of old)if(plan.dispositions.filter(d=>d.logicalId===a.logicalId).length!==1)throw new Error('every old inventory item requires a disposition: '+a.logicalId);
 for(const d of plan.dispositions)if(!old.some(a=>a.logicalId===d.logicalId)||!['retain','update','retire','pending'].includes(d.action))throw new Error('invalid old inventory disposition');
 const inputAssets=[...plan.assets];const baselineRecords:PreviewData['baselines']=[];const nextAssets:ManagedAsset[]=[];
 const fileMap=new Map<string,{raw?:Buffer;text?:string;encoding:'utf8'|'base64';observedMode?:number;mode?:number}>();
 const allTargets=[...new Set([...inputAssets.map(a=>a.target),...old.map(a=>a.target)])];
 const targetKeys=allTargets.map(targetKey);
 if(new Set(targetKeys).size!==allTargets.length)throw new Error('Windows target aliases overlap');
 for await(const {target,state} of readFileStates(root,allTargets)){const raw=state.bytes;const encoding=inputAssets.find(a=>a.target===target)?.encoding??old.find(a=>a.target===target)?.encoding??'utf8';fileMap.set(target,{raw,text:raw?.toString(encoding==='base64'?'base64':'utf8'),encoding,observedMode:state.mode,mode:state.mode});}
 const usedResolutions=new Set<PreviewResolution>();
 const entries:{candidate?:PreparedAsset;old?:ManagedAsset;action:'update'|'remove'|'retain'|'pending'}[]=[];
 for(const asset of inputAssets){
  if(asset.mode!==undefined&&(!Number.isInteger(asset.mode)||asset.mode<0||asset.mode>0o777||asset.ownership.kind!=='file'))throw Error('managed file mode requires ordinary permissions and full-file ownership');
  const key=targetKey(asset.target);
  if(key==='.rigup/manifest.json'||key==='.rigup/baseline'||key.startsWith('.rigup/baseline/')||key==='.rigup/check-results'||key.startsWith('.rigup/check-results/'))throw new Error('installer metadata target reserved');
  const prior=old.find(a=>a.logicalId===asset.logicalId)??old.find(a=>a.target===asset.target&&signature(a.ownership)===signature(asset.ownership)&&plan.dispositions.some(d=>d.logicalId===a.logicalId&&d.action==='retire'));
  if(prior&&(prior.target!==asset.target||signature(prior.ownership)!==signature(asset.ownership)))throw new Error('logicalId target/selector changed; explicit old retirement and new identity required');
  const disposition=plan.dispositions.find(d=>d.logicalId===asset.logicalId);
  if(disposition?.action==='retain'&&prior&&(digest(asset.encoding==='base64'?Buffer.from(asset.content,'base64'):asset.content)!==prior.digest||asset.mode!==prior.mode))throw new Error('retained candidate differs from trusted baseline');
  if(disposition?.action==='retire'||disposition?.action==='pending')throw new Error('candidate contradicts old disposition');
  entries.push({candidate:asset,old:prior,action:disposition?.action==='retain'?'retain':'update'});
 }
 for(const prior of old.filter(a=>!entries.some(e=>e.old===a))){const d=plan.dispositions.find(d=>d.logicalId===prior.logicalId)!;if(d.action==='update')throw new Error('update requires candidate');entries.push({old:prior,action:d.action==='retire'?'remove':d.action});}
 for(let i=0;i<entries.length;i++)for(let j=0;j<i;j++){
  const a=entries[i].candidate??entries[i].old!,b=entries[j].candidate??entries[j].old!;
  if(a.target===b.target&&selectorsOverlap(a.ownership,b.ownership))throw new Error('overlapping managed selectors');
 }
 for(const entry of entries){
  const asset=entry.candidate??entry.old!;const file=fileMap.get(asset.target)!;
  const observedDigest=file.raw?digest(file.raw):absentDigest;const base=entry.old?await trustedBaseline(root,entry.old):undefined;
  let local:string|undefined;let result:MergeResult;
  try {local=ownedContent(file.text,asset.ownership);}catch{items.push({logicalId:asset.logicalId,target:asset.target,ownership:asset.ownership,action:'conflict',reason:'Cannot safely select owned content; manual patch required',observedDigest});blockers.push(asset.target+': malformed ownership/configuration');continue;}
  if(entry.action==='pending'){result={action:'conflict',reason:'Unresolved old asset disposition'};}
  else if(entry.action==='retain') {result=base===undefined?{action:'conflict',reason:'Retained item has no trusted baseline'}:{action:'keep',content:local};}
  else result=mergeManaged(base,local,entry.candidate?.content,{action:entry.action,binary:asset.encoding==='base64',equals:(left,right)=>equalOwnedContent(asset.ownership,left,right)});
  if(dependencies.reviewEntryBlocks&&entry.old&&asset.ownership.kind==='block'&&asset.logicalId.startsWith('entry:')&&base!==undefined&&
     (local===undefined||!equalOwnedContent(asset.ownership,local,base))){
   result={action:'conflict',reason:'Local edit in the Rigup-owned block was preserved. Keep the file as it is, or move your local text outside the managed block and restore the managed text before retrying.'};
  }
  let nextMode=file.mode;
  const localMode=file.observedMode,baseMode=platformFileMode(entry.old?.mode),newMode=platformFileMode(entry.candidate?.mode);
  let modeConflict=false;
  if(entry.action==='remove'&&baseMode!==undefined&&localMode!==undefined&&localMode!==baseMode)modeConflict=true;
  else if(newMode!==undefined){
   if(localMode===undefined||localMode===baseMode||localMode===newMode)nextMode=newMode;
   else if(newMode!==baseMode)modeConflict=true;
  }
  if(modeConflict)result={action:'conflict',reason:'File mode changed locally and upstream, or has no trusted baseline; review permissions explicitly'};
  const resolution=resolutions.find(r=>r.target===asset.target&&signature(r.selector)===signature(asset.ownership));
  if(resolution){
   usedResolutions.add(resolution);if(resolution.observedDigest!==observedDigest)throw new Error('resolution target digest changed');
   if((newMode!==undefined||baseMode!==undefined)&&resolution.observedMode!==localMode)throw Error('resolution target mode changed or was not explicitly reviewed');
   if(resolution.action==='remove'){if(entry.action!=='remove')throw new Error('remove resolution requires explicit retirement');result={action:local===undefined?'noop':'remove'};}
   else {
    if(!entry.candidate)throw new Error('resolution requires new generated baseline');
    if(resolution.action==='restore'&&local!==undefined)throw new Error('restore only applies to deleted managed content');
    if(resolution.action==='adopt'&&entry.old&&base!==undefined)throw new Error('adoption only applies to untrusted ownership');
    if(!['adopt','restore','replace'].includes(resolution.action))throw new Error('invalid resolution action');
    result={action:local===undefined?'create':'update',content:entry.candidate.content};
    if(newMode!==undefined)nextMode=newMode;
   }
  }
  if(result.action!=='conflict'&&entry.action!=='remove'&&file.text!==undefined&&nextMode!==file.observedMode&&['keep','noop'].includes(result.action))result={action:'update',content:result.content??local};
  if(process.platform==='win32'&&localMode===0o444&&['create','update','remove'].includes(result.action))result={action:'conflict',reason:'Windows target is read-only; review its permissions before changing it'};
  if(result.action==='conflict')blockers.push(asset.target+': '+result.reason);
  else {
   if(['create','update','remove'].includes(result.action)) {
    try{file.text=replaceOwned(file.text,asset.ownership,result.action==='remove'?undefined:result.content);file.mode=file.text===undefined?undefined:nextMode??0o644;}
    catch{result={action:'conflict',reason:'Configuration cannot be safely edited'};blockers.push(asset.target+': configuration edit conflict');}
   }
   if(result.action!=='conflict'&&entry.action!=='remove') {
    if(entry.candidate){
     const content=entry.candidate.content;const bytes=asset.encoding==='base64'?Buffer.from(content,'base64'):Buffer.from(content);
     const {content:generatedContent,...metadata}=entry.candidate;nextAssets.push({...metadata,digest:digest(bytes)});baselineRecords.push({logicalId:asset.logicalId,content,encoding:asset.encoding??'utf8'});
    }else if(entry.old){nextAssets.push(entry.old);baselineRecords.push({logicalId:asset.logicalId,content:base!,encoding:asset.encoding??'utf8'});}
   }
  }
  const display=(content:string|undefined)=>{if(content===undefined)return undefined;if(asset.encoding==='base64')return '[binary content]';try{return filterContent(asset.target,content).slice(0,4000);}catch{return '[content withheld by read policy]';}};
  items.push({logicalId:asset.logicalId,target:asset.target,ownership:asset.ownership,action:result.action,reason:result.reason,observedDigest,beforeMode:file.observedMode,afterMode:file.mode,...(!['noop','keep'].includes(result.action)?{before:display(local),after:display(result.action==='remove'?undefined:result.content??entry.candidate?.content)}:{})});
 }
 if(usedResolutions.size!==resolutions.length)throw new Error('resolution target/selector does not match planned item');
 const lock=await loadUpstreamLock();
 for(const op of plan.operations){
  if(op.kind==='initialize'&&op.integrationId==='openwiki'){
   blockers.push(op.id+': '+openwikiInitializationGuide);
   continue;
  }
  try{
   const id=op.integrationId;
   const recipe=lock.find(r=>r.integrationId===id);
   if(!recipe||!isNativeTool(id))throw Error('External operation has no verified adapter');
   if(plan.operations.filter(o=>o.id===op.id).length!==1||op.prerequisiteIds.some(id=>!plan.operations.slice(0,plan.operations.indexOf(op)).some(o=>o.id===id)))throw Error('Missing or reordered operation prerequisite');
   const prerequisites=op.kind==='initialize'?plan.operations.filter(o=>o.kind==='install'&&o.integrationId===id).map(o=>o.id):[];
   assertToolOperationRecipe(root,op,recipe,prerequisites);
   if(op.kind==='initialize'&&!prerequisites.length&&!await verifyToolInstallReceipt(root,id,recipe,oldManifest?.installedTools?.[id]))throw Error('Initialization requires receipted software');
   if(op.declaredWrites.map(targetKey).some(scope=>targetKeys.some(target=>target===scope||target.startsWith(scope+'/')||scope.startsWith(target+'/'))))throw Error('External operation overlaps candidate');
   await assertEmptyToolScopes(root,op);
  }catch{blockers.push(op.id+': external operation protection or recipe validation failed');}
 }
 // Validate selected owned content in the final virtual tree, including preserved local edits.
 const available=async(target:string)=>fileMap.has(target)?fileMap.get(target)!.text!==undefined:(await readTarget(root,target))!==undefined;
 for(const entry of entries.filter(e=>e.action!=='remove')){
  const asset=entry.candidate??entry.old!;const file=fileMap.get(asset.target)!;if(file.encoding==='base64')continue;
  let text:string|undefined;try{text=ownedContent(file.text,asset.ownership);}catch{continue;}
  if(text===undefined){blockers.push(asset.target+': required owned binding missing');continue;}
  if(entry.candidate&&['quality-template','customer-runtime'].includes(entry.candidate.source.kind)&&text!==entry.candidate.content)blockers.push(asset.target+': fixed executable/configuration binding changed; resolve against the deterministic candidate');
  if(asset.target.endsWith('.md')) {
   try{validateTemplateContent(text);}catch{blockers.push(asset.target+': local content conflicts with mandatory workflow gate; regenerate or resolve');}
   for(const match of markdownLinks(text)){
    const raw=match[1].split('#')[0];if(!raw||/^(?:https?:|mailto:)/.test(raw))continue;
    try {const target=posix.normalize(posix.join(posix.dirname(asset.target),decodeURIComponent(raw)));if(raw.startsWith('/')||target.startsWith('../')||!await available(target))throw new Error('missing');}
    catch{blockers.push(asset.target+': navigation link unavailable: '+raw);}
   }
   if(entry.candidate?.source.kind==='fixed-template')for(const match of markdownLinks(entry.candidate.content))if(!text.includes(match[0]))blockers.push(asset.target+': required consumer binding removed; regenerate or resolve');
  }else if(asset.ownership.kind==='json-key'||asset.ownership.kind==='toml-table'){
   // A locally changed executable binding cannot inherit semantic acceptance of N.
   if(entry.candidate&&!equalOwnedContent(asset.ownership,text,entry.candidate.content))blockers.push(asset.target+': selected machine binding differs from accepted configuration');
  }
 }
 if(plan.options.quality?.gitlab){
  try{
   const text=fileMap.get('.gitlab-ci.yml')?.text??(await readTarget(root,'.gitlab-ci.yml'))?.toString('utf8');const doc=parseDocument(text??'');if(doc.errors.length)throw new Error('CI YAML invalid');
   const include=doc.toJS()?.include;const includes=Array.isArray(include)?include:[include];
   if(!includes.some(v=>v==='.rigup/gitlab-ci.yml'||v?.local==='.rigup/gitlab-ci.yml')||!await available('.rigup/gitlab-ci.yml'))throw new Error('required CI include binding missing');
   const jobs=parseDocument(fileMap.get('.rigup/gitlab-ci.yml')?.text??'');if(jobs.errors.length)throw new Error('CI jobs YAML invalid');
   const expected=parseDocument(plan.assets.find(a=>a.target==='.rigup/gitlab-ci.yml')?.content??'').toJS();const actual=jobs.toJS();
   for(const [name,job] of Object.entries(expected??{}))for(const [key,value] of Object.entries(job as object))if(signature(actual?.[name]?.[key])!==signature(value))throw new Error('required CI job binding changed');
  }catch{blockers.push('.gitlab-ci.yml: required CI include/job binding invalid or unavailable; preserve local content and re-prepare');}
 }
 const previewId=digest(randomUUID()+signature({plan,items,resolutions}));
 const publicPreview:Preview={...(plan.projectRules?{projectRules:plan.projectRules}:{}),previewId,root,executable:blockers.length===0,runChecks:plan.runChecks??[],items,blockers,operations:plan.operations,warnings:plan.warnings};
 const files:PreviewFile[]=[...fileMap].map(([target,f])=>({target,observedDigest:f.raw?digest(f.raw):absentDigest,observedMode:f.observedMode,next:f.text,encoding:f.encoding,mode:f.text===undefined?undefined:f.mode??0o644}));
 const manifestRaw=await readTarget(root,'.rigup/manifest.json');
 const data:PreviewData={schemaVersion:1,modePolicyVersion:1,nativeDiscoveryVersion:1,inputSnapshotVersion:2,preview:publicPreview,plan,oldManifest,manifestDigest:manifestRaw?digest(manifestRaw):absentDigest,inputSnapshot:await installationInput(root,plan,{},allTargets),files,assets:nextAssets,baselines:baselineRecords};
 if(dependencies.skipUnchanged&&publicPreview.executable&&unchangedInstallation(data))return {...publicPreview,previewId:'',noChanges:true};
 const cache=await privateDirectory(dependencies.cacheRoot??defaultPreviewCache(),root);await saveCache(join(cache,previewId+'.json'),JSON.stringify({digest:signature(data),data}));
 return publicPreview;
}

export async function installationInput(root:string,plan:SetupPlan,discovery:NativeDiscoveryOptions={},managedTargets?:string[]):Promise<string>{
 // The apply journal verifies whole managed files, including customer content.
 // Keep those files out of the source snapshot so partial writes can resume.
 const scopes=[...plan.operations.filter(o=>o.kind==='initialize').flatMap(o=>o.declaredWrites),...(managedTargets??[])];
 const profile=await scanRepository(root,plan.options,discovery,scopes);
 const legacyAssets=managedTargets?[]:[...(await loadManifest(root))?.assets??[],...plan.assets];
 const values:string[]=[];
 for await(const {target:path,state} of readFileStates(root,profile.files)) {
  if(!state.bytes)throw Error('source input changed while preparing installation');
  const raw=state.bytes.toString('utf8');
  const selectors=legacyAssets.filter(a=>a.target===path).map(a=>a.ownership);
  const unique=[...new Map(selectors.map(s=>[signature(s),s])).values()];
  const present=unique.filter(s=>ownedContent(raw,s)!==undefined);
  const text=projectInput(raw,present);if(text!==null)values.push(path+'\0'+digest(text));
 }
 const config=await readTarget(root,'.rigup/config.yaml');const nativeSources=Object.fromEntries(Object.entries(profile.skillSources??{}).map(([agent,sources])=>[agent,sources.filter(s=>isAbsolute(s.identity))]).filter(([,sources])=>(sources as unknown[]).length));return signature({values,nativeSources,ignore:profile.ignoreFingerprint,config:plan.assets.some(a=>a.target==='.rigup/config.yaml')?'configured-in-this-preview':config?digest(config):absentDigest});
}
