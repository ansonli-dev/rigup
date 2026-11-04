import {parseDocument} from 'yaml';
import {parse as parseJsonc} from 'jsonc-parser';
import {parse as parseToml} from 'smol-toml';
import {filterContent} from '../analyzer/read-policy.js';
import {scanRepository} from '../analyzer/repository.js';
import {projectInput} from '../managed-input.js';
import {readFile,lstat,readdir,realpath} from 'node:fs/promises';
import {join,posix} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import type {SetupPlan,ManagedAsset} from '../types.js';
import type {Ownership} from '../managed-input.js';
import type {PreparedAsset} from '../integrations/registry.js';
import {loadUpstreamLock} from '../integrations/registry.js';
import {prepareSoftwareInstall} from '../integrations/tools/software.js';
import {digest} from '../analyzer/evidence.js';
import {privateDirectory,signature,readCache,saveCache} from '../generator/cache.js';
import {validateTemplateContent} from '../generator/document-policy.js';
import {loadManifest,trustedBaseline,type Manifest} from './baseline.js';
import {mergeManaged,type MergeResult} from './merge.js';
import {targetPath,ownedContent,replaceOwned,selectorsOverlap} from './ownership.js';
export interface PreviewResolution {target:string;selector:Ownership;observedDigest:string;action:'adopt'|'restore'|'replace'|'remove'}
export interface PreviewItem {logicalId:string;target:string;ownership:Ownership;action:MergeResult['action'];reason?:string;observedDigest:string;before?:string;after?:string}
export interface Preview {previewId:string;root:string;executable:boolean;items:PreviewItem[];blockers:string[];operations:SetupPlan['operations'];warnings:string[]}
export interface PreviewFile {target:string;observedDigest:string;next?:string;encoding:'utf8'|'base64';mode?:number}
export interface PreviewData {schemaVersion:1;preview:Preview;plan:SetupPlan;oldManifest?:Manifest;manifestDigest:string;inputSnapshot:string;files:PreviewFile[];assets:ManagedAsset[];baselines:{logicalId:string;content:string;encoding:'utf8'|'base64'}[];operationPreconditions:{id:string;state:'missing'|'empty'}[]}
export const absentDigest=digest('rigup:absent');
export const defaultPreviewCache=()=>join(homedir(),'.cache','rigup','previews');
export async function readTarget(root:string,target:string):Promise<Buffer|undefined>{try{return await readFile(await targetPath(root,target));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}}
export async function operationPrecondition(root:string,target:string):Promise<'missing'|'empty'>{
 const path=await targetPath(root,target);try {const st=await lstat(path);if(!st.isDirectory()||(await readdir(path)).length)throw new Error('external operation requires a new empty scope');return 'empty';}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return 'missing';throw e;}
}
export async function loadPreview(previewId:string,cacheRoot=defaultPreviewCache()):Promise<PreviewData>{
 if(!/^[a-f0-9]{64}$/.test(previewId))throw new Error('preview id invalid');
 const value=await readCache<{digest:string;data:PreviewData}>(join(cacheRoot,previewId+'.json'));
 if(!value||value.digest!==signature(value.data)||value.data.preview.previewId!==previewId)throw new Error('private preview missing or corrupted');return value.data;
}
export async function preview(plan:SetupPlan,resolutions:PreviewResolution[]=[],dependencies:{cacheRoot?:string}={}):Promise<Preview>{
 const root=await realpath(plan.root);if(root!==plan.root)throw new Error('plan root must be canonical');
 const oldManifest=await loadManifest(root);const old=oldManifest?.assets??[];
 const blockers=plan.requirements.map(r=>r.integrationId+': '+r.reason);const items:PreviewItem[]=[];
 for(const a of old)if(plan.dispositions.filter(d=>d.logicalId===a.logicalId).length!==1)throw new Error('every old inventory item requires a disposition: '+a.logicalId);
 for(const d of plan.dispositions)if(!old.some(a=>a.logicalId===d.logicalId)||!['retain','update','retire','pending'].includes(d.action))throw new Error('invalid old inventory disposition');
 const inputAssets=[...plan.assets];const baselineRecords:PreviewData['baselines']=[];const nextAssets:ManagedAsset[]=[];
 const fileMap=new Map<string,{raw?:Buffer;text?:string;encoding:'utf8'|'base64';mode?:number}>();
 const allTargets=[...new Set([...inputAssets.map(a=>a.target),...old.map(a=>a.target)])];
 for(const target of allTargets){const raw=await readTarget(root,target);const encoding=inputAssets.find(a=>a.target===target)?.encoding??old.find(a=>a.target===target)?.encoding??'utf8';fileMap.set(target,{raw,text:raw?.toString(encoding==='base64'?'base64':'utf8'),encoding});}
 const usedResolutions=new Set<PreviewResolution>();
 const entries:{candidate?:PreparedAsset;old?:ManagedAsset;action:'update'|'remove'|'retain'|'pending'}[]=[];
 for(const asset of inputAssets){
  if(asset.target==='.rigup/manifest.json'||asset.target.startsWith('.rigup/baseline/'))throw new Error('installer metadata target reserved');
  const prior=old.find(a=>a.logicalId===asset.logicalId)??old.find(a=>a.target===asset.target&&signature(a.ownership)===signature(asset.ownership)&&plan.dispositions.some(d=>d.logicalId===a.logicalId&&d.action==='retire'));
  if(prior&&(prior.target!==asset.target||signature(prior.ownership)!==signature(asset.ownership)))throw new Error('logicalId target/selector changed; explicit old retirement and new identity required');
  const disposition=plan.dispositions.find(d=>d.logicalId===asset.logicalId);
  if(disposition?.action==='retain'&&prior&&digest(asset.encoding==='base64'?Buffer.from(asset.content,'base64'):asset.content)!==prior.digest)throw new Error('retained candidate differs from trusted baseline');
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
  else result=mergeManaged(base,local,entry.candidate?.content,{action:entry.action,binary:asset.encoding==='base64'});
  const resolution=resolutions.find(r=>r.target===asset.target&&signature(r.selector)===signature(asset.ownership));
  if(resolution){
   usedResolutions.add(resolution);if(resolution.observedDigest!==observedDigest)throw new Error('resolution target digest changed');
   if(resolution.action==='remove'){if(entry.action!=='remove')throw new Error('remove resolution requires explicit retirement');result={action:local===undefined?'noop':'remove'};}
   else {
    if(!entry.candidate)throw new Error('resolution requires new generated baseline');
    if(resolution.action==='restore'&&local!==undefined)throw new Error('restore only applies to deleted managed content');
    if(resolution.action==='adopt'&&entry.old&&base!==undefined)throw new Error('adoption only applies to untrusted ownership');
    if(!['adopt','restore','replace'].includes(resolution.action))throw new Error('invalid resolution action');
    result={action:local===undefined?'create':'update',content:entry.candidate.content};
   }
  }
  if(result.action==='conflict')blockers.push(asset.target+': '+result.reason);
  else {
   if(['create','update','remove'].includes(result.action)) {
    try{file.text=replaceOwned(file.text,asset.ownership,result.action==='remove'?undefined:result.content);file.mode=asset.mode;}
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
  items.push({logicalId:asset.logicalId,target:asset.target,ownership:asset.ownership,action:result.action,reason:result.reason,observedDigest,...(!['noop','keep'].includes(result.action)?{before:display(local),after:display(result.action==='remove'?undefined:result.content??entry.candidate?.content)}:{})});
 }
 if(usedResolutions.size!==resolutions.length)throw new Error('resolution target/selector does not match planned item');
 const operationPreconditions:PreviewData['operationPreconditions']=[];
 const lock=await loadUpstreamLock();
 for(const op of plan.operations){
  try{
   const recipe=lock.find(r=>r.integrationId===op.integrationId);if(!recipe||op.kind!=='install'||!['openwiki','codegraph'].includes(op.integrationId))throw new Error('external operation has no verified adapter');
   const expected=await prepareSoftwareInstall(root,op.integrationId as 'openwiki'|'codegraph',recipe.version,recipe.packageIntegrity);
   if('pending' in expected||'reused' in expected||signature(expected)!==signature(op))throw new Error('operation differs from verified recipe');
   if(op.declaredWrites.some(scope=>allTargets.some(target=>target===scope||target.startsWith(scope+'/')||scope.startsWith(target+'/'))))throw new Error('external operation overlaps candidate');
   operationPreconditions.push({id:op.id,state:await operationPrecondition(root,op.protection.target)});
  }catch{blockers.push(op.id+': external operation protection or recipe validation failed');}
 }
 // Validate selected owned content in the final virtual tree, including preserved local edits.
 const available=async(target:string)=>fileMap.has(target)?fileMap.get(target)!.text!==undefined:(await readTarget(root,target))!==undefined;
 for(const entry of entries.filter(e=>e.action!=='remove')){
  const asset=entry.candidate??entry.old!;const file=fileMap.get(asset.target)!;if(file.encoding==='base64')continue;
  let text:string|undefined;try{text=ownedContent(file.text,asset.ownership);}catch{continue;}
  if(text===undefined){blockers.push(asset.target+': required owned binding missing');continue;}
  if(entry.candidate&&['quality-template','customer-runtime'].includes(entry.candidate.source.kind)&&text!==entry.candidate.content)blockers.push(asset.target+': fixed executable/configuration binding changed; resolve against the deterministic candidate');
  if(entry.candidate?.source.kind==='customer-mcp'&&asset.target.endsWith('.mjs')&&text!==entry.candidate.content)blockers.push(asset.target+': fixed MCP runner changed; resolve before apply');
  if(asset.target.endsWith('.md')) {
   try{validateTemplateContent(text);}catch{blockers.push(asset.target+': local content conflicts with mandatory workflow gate; regenerate or resolve');}
   for(const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)){
    const raw=match[1].split('#')[0];if(!raw||/^(?:https?:|mailto:)/.test(raw))continue;
    try {const target=posix.normalize(posix.join(posix.dirname(asset.target),decodeURIComponent(raw)));if(raw.startsWith('/')||target.startsWith('../')||!await available(target))throw new Error('missing');}
    catch{blockers.push(asset.target+': navigation link unavailable: '+raw);}
   }
   if(entry.candidate?.source.kind==='fixed-template')for(const match of entry.candidate.content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g))if(!text.includes(match[0]))blockers.push(asset.target+': required consumer binding removed; regenerate or resolve');
  }else if(asset.ownership.kind==='json-key'||asset.ownership.kind==='toml-table'){
   // A locally changed executable binding cannot inherit semantic acceptance of N.
   if(entry.candidate&&signature(asset.ownership.kind==='json-key'?parseJsonc(text):parseToml(text))!==signature(asset.ownership.kind==='json-key'?parseJsonc(entry.candidate.content):parseToml(entry.candidate.content)))blockers.push(asset.target+': selected machine binding differs from accepted configuration');
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
 const publicPreview:Preview={previewId,root,executable:blockers.length===0,items,blockers,operations:plan.operations,warnings:plan.warnings};
 const files:PreviewFile[]=[...fileMap].map(([target,f])=>({target,observedDigest:f.raw?digest(f.raw):absentDigest,next:f.text,encoding:f.encoding,mode:f.mode}));
 const manifestRaw=await readTarget(root,'.rigup/manifest.json');
 const data:PreviewData={schemaVersion:1,preview:publicPreview,plan,oldManifest,manifestDigest:manifestRaw?digest(manifestRaw):absentDigest,inputSnapshot:await installationInput(root,plan),files,assets:nextAssets,baselines:baselineRecords,operationPreconditions};
 const cache=await privateDirectory(dependencies.cacheRoot??defaultPreviewCache(),root);await saveCache(join(cache,previewId+'.json'),JSON.stringify({digest:signature(data),data}));
 return publicPreview;
}

export async function installationInput(root:string,plan:SetupPlan):Promise<string>{
 const profile=await scanRepository(root,plan.options);const old=(await loadManifest(root))?.assets??[];const values:string[]=[];
 for(const path of profile.files) {
  let raw=(await readTarget(root,path))!.toString('utf8');
  const selectors=[...old,...plan.assets].filter(a=>a.target===path).map(a=>a.ownership);
  const unique=[...new Map(selectors.map(s=>[signature(s),s])).values()];
  const present=unique.filter(s=>ownedContent(raw,s)!==undefined);
  const text=projectInput(raw,present);if(text!==null)values.push(path+'\0'+digest(text));
 }
 const config=await readTarget(root,'.rigup/config.yaml');return signature({values,config:plan.assets.some(a=>a.target==='.rigup/config.yaml')?'configured-in-this-preview':config?digest(config):absentDigest});
}
