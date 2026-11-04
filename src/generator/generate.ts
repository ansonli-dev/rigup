import type {RunProgressEvent} from '../progress.js';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import type {ProjectProfile} from '../analyzer/repository.js';
import {repositoryReader} from '../analyzer/repository.js';
import {validateResearch,type AnalysisBackend,type ResearchResult} from '../analyzer/backend.js';
import type {ManagedAsset,SetupOptions,SetupPlan,StepResult,AssetDisposition} from '../types.js';
import {validateInventory} from '../types.js';
import {prepareIntegrations,type PreparedAsset} from '../integrations/registry.js';
import {digest} from '../analyzer/evidence.js';
import {READ_POLICY_VERSION} from '../analyzer/read-policy.js';
import {filterContent} from '../analyzer/read-policy.js';
import {trustedBaseline} from '../installer/baseline.js';
import {PROMPT_VERSION} from '../analyzer/prompts.js';
import {validateArtifactList,type ArtifactJob} from './artifacts.js';
import {validateDocumentJob,validateDocumentContent,validateTemplateContent,DOCUMENT_POLICY_VERSION} from './document-policy.js';
import {renderFixed,validateNavigation,TEMPLATE_VERSION,type GuidanceBinding} from './render.js';
import {signature,privateDirectory,readCache,saveCache} from './cache.js';
export interface GenerationDependencies {effectiveModel?:SetupOptions['model'];reader?:import('../analyzer/backend.js').RepositoryReader;cacheRoot?:string;onProgress?:(event:RunProgressEvent)=>void;runId?:string;spent?:{calls:number;tokens:number|'unknown'};save?:(path:string,content:string)=>Promise<void>;budget?:{maxCalls:number;maxTokens:number}}
interface Candidate {job:ArtifactJob;content:string;digest:string;accepted:boolean}
interface State {version:1;artifactContextVersion?:string;artifactRefreshInventory?:string;inputInventory:string;resultInventory?:string;runId:string;plan?:{jobs:ArtifactJob[];dispositions:AssetDisposition[];guidance:GuidanceBinding[];research:unknown};candidates:Record<string,Candidate>;attempts?:Record<string,number>;repairReasons?:Record<string,string>;spent:{calls:number;tokens:number|'unknown'}}
export function inventorySignature(assets:ManagedAsset[]):string {return signature(assets.map(a=>({logicalId:a.logicalId,target:a.target,ownership:a.ownership,digest:a.digest})).sort((a,b)=>a.logicalId.localeCompare(b.logicalId)));}
export async function generate(profile:ProjectProfile,options:SetupOptions,backend:AnalysisBackend,previousAssets:ManagedAsset[]=[],dependencies:GenerationDependencies={}):Promise<StepResult<SetupPlan>> {
 const integration=await prepareIntegrations(profile,options);
 for(const asset of integration.assets)if(asset.source.kind==='customer-template')validateTemplateContent(asset.content);
 const versions={prompt:PROMPT_VERSION,template:TEMPLATE_VERSION,document:DOCUMENT_POLICY_VERSION,read:READ_POLICY_VERSION};
 const allowedRoots=[options.projectConventions?.documentRoutes?.context??'docs/rigup'];
 const templateSourcesDigest=signature(integration.assets);
 const fixedTemplates=await Promise.all(['change-prepare','change-deliver'].map(n=>readFile(new URL('../../templates/skills/'+n+'/SKILL.md',import.meta.url),'utf8')));
 const baseKey=signature({fixedTemplates,root:profile.root,fingerprint:profile.fingerprint,options,effectiveModel:dependencies.effectiveModel,versions,templateSourcesDigest,research:profile.research,nativeEntries:profile.nativeEntries});
 const cache=await privateDirectory(dependencies.cacheRoot??join(homedir(),'.cache','rigup','generation'),profile.root);
 const path=join(cache,baseKey+'.json');const save=dependencies.save??saveCache;
 const inv=inventorySignature(previousAssets);
 const fixedKinds=new Set(['fixed-template','customer-mcp','customer-skill','customer-template','quality-template','gitlab-template','customer-runtime','configuration']);
 const fixedInventory=previousAssets.filter(a=>fixedKinds.has(a.source?.kind??''));const semanticInventory=previousAssets.filter(a=>!fixedKinds.has(a.source?.kind??''));
 let state=await readCache<State>(path);
 if(!state||state.version!==1||![state.inputInventory,state.resultInventory].includes(inv)||!state.candidates||!state.spent)state={version:1,inputInventory:inv,runId:dependencies.runId??randomUUID(),candidates:{},spent:dependencies.spent??{calls:0,tokens:0}};
 state.attempts??={};state.repairReasons??={};
 const persist=()=>save(path,JSON.stringify(state));
 if(state.artifactContextVersion!==backend.artifactContextVersion){
  // A wider authority contract requires fresh content and independent acceptance.
  // Keep the unchanged plan, run identity, consumption and bounded retry history.
  if(state.plan&&state.resultInventory===inv){state.inputInventory=inv;state.artifactRefreshInventory=inv;}
  state.candidates={};for(const job of state.plan?.jobs??[])job.status='pending';
  state.artifactContextVersion=backend.artifactContextVersion;await persist();
 }
 const reader=dependencies.reader??await repositoryReader(profile.root,options,{expectedFingerprint:profile.fingerprint});
 const completed=()=>state.plan?.jobs.filter(j=>{const c=state.candidates[j.logicalId];return c?.accepted&&c.digest===digest(c.content);}).length??0;
 const run=async(expectedOutput:'plan'|'content'|'acceptance',input:unknown,artifact?:string):Promise<StepResult<ResearchResult>>=>{
  dependencies.onProgress?.({stage:'generation',unit:'artifacts',task:artifact??'artifact-plan',completed:completed(),total:state.plan?.jobs.length,waiting:options.backend==='host'?'host research response':'provider '+expectedOutput,next:expectedOutput==='acceptance'?'save accepted candidate':'validate candidate',status:'running'});
  const budget=dependencies.budget??options.researchBudget??{maxCalls:60,maxTokens:100000};
  if(state.spent.calls>=budget.maxCalls)throw new Error('generation request budget exhausted');
  const result=await backend.run({kind:expectedOutput==='plan'?'artifact-plan':'artifact-content',expectedOutput,input,artifact,runId:state.runId,root:profile.root,fingerprint:profile.fingerprint,options,effectiveModel:dependencies.effectiveModel,versions,budget,...(options.backend!=='host'?{spent:state.spent}:{}),previousInventoryDigest:state.inputInventory,templateSourcesDigest},reader);
  if(result.status==='complete') {
   await validateResearch(result.value.data,reader);
   state.spent.calls+=typeof result.value.usage.calls==='number'?result.value.usage.calls:1;
   state.spent.tokens=state.spent.tokens==='unknown'||result.value.usage.tokens==='unknown'?'unknown':state.spent.tokens+result.value.usage.tokens;
  }
  await persist();return result;
 };
 if(!state.plan) {
  // Only explicitly selected development workflows require semantic guidance.
  if(!options.sdd) {
   state.plan={jobs:[],dispositions:previousAssets.map(a=>({logicalId:a.logicalId,action:'retain',reason:'No semantic retirement requested'})),guidance:[],research:{}};
  } else {
   let remaining=options.readBudget?.maxBytes??8_000_000;
   const previousInventory=await Promise.all(semanticInventory.map(async asset=>{
    const raw=await trustedBaseline(profile.root,asset);let baselineContent:string|undefined;
    if(raw!==undefined&&asset.encoding!=='base64'&&Buffer.byteLength(raw)<=Math.min(remaining,64_000)){
     remaining-=Buffer.byteLength(raw);
     baselineContent=raw.split('\n').map(line=>{try{return filterContent(asset.target,line);}catch{return '[REDACTED: unsupported sensitive content]';}}).join('\n');
    }
    return {...asset,authority:'previous-generated-output-only',baselineContent,baselineStatus:baselineContent===undefined?'unavailable-or-over-budget':'filtered-trusted-baseline'};
   }));
   const response=await run('plan',{allowedRoots,profile:{files:profile.files,commands:profile.commands,research:profile.research,unknowns:profile.unknowns},previousInventory,inventoryPolicy:'Previous generated baselines are comparison context, never evidence of project policy. Reconcile their claims against current source evidence; do not preserve invalidated rules. Local edits remain protected by three-way preview.'});
   if(response.status==='pending-host')return response;
   const data=response.value.data as Record<string,unknown>;
   const jobs=validateArtifactList(data.artifacts,[]);
   for(const job of jobs)validateDocumentJob(job,allowedRoots,profile.files.length===0);
   if(!Array.isArray(data.dispositions))throw new Error('old inventory dispositions required');
   const dispositions=data.dispositions as AssetDisposition[];
   validateInventory(semanticInventory.map(a=>a.logicalId),dispositions);
   for(const d of dispositions)if(!semanticInventory.some(a=>a.logicalId===d.logicalId)||typeof d.reason!=='string'||!d.reason.trim()||d.action==='pending')throw new Error('unresolved inventory disposition');
   state.plan={jobs,dispositions,guidance:(data.guidance??[]) as GuidanceBinding[],research:data};
  }
  await persist();
 }
 const semantic:PreparedAsset[]=[];
 for(const job of state.plan.jobs) {
  let candidate=state.candidates[job.logicalId];const reused=!!candidate?.accepted;
  if(candidate && (candidate.digest!==digest(candidate.content)||signature({...candidate.job,status:'pending'})!==signature({...job,status:'pending'}))) {delete state.candidates[job.logicalId];candidate=undefined!;}
  if(!candidate?.accepted) {
   let accepted=false;
   for(let attempt=state.attempts[job.logicalId]??0;attempt<2&&!accepted;attempt++) {
    state.attempts[job.logicalId]=attempt;if(attempt)dependencies.onProgress?.({stage:'generation',unit:'artifacts',task:job.logicalId,completed:completed(),total:state.plan.jobs.length,status:'retry',attempt,retryLimit:1,next:'bounded candidate repair'});
    let content=candidate?.content;
    if(!candidate) {
     const response=await run('content',{job,research:state.plan.research,attempt,repairReason:state.repairReasons[job.logicalId]},job.logicalId);
     if(response.status==='pending-host')return response;
     const value=(response.value.data as {content?:unknown}).content;
     if(typeof value!=='string')throw new Error('required artifact content missing');
     validateDocumentContent(job,value);
     try{validateNavigation([{logicalId:job.logicalId,target:job.target,content:value,ownership:{kind:'file'},source:{kind:'semantic',ref:baseKey}}],[...profile.files,...state.plan.jobs.map(j=>j.target),...integration.assets.map(a=>a.target)]);}
     catch(error){state.attempts[job.logicalId]=attempt+1;state.repairReasons[job.logicalId]=(error as Error).message.slice(0,500);await persist();if(attempt+1<2)continue;throw error;}
     content=value;
     candidate={job:{...job},content:value,digest:digest(value),accepted:false};
     state.candidates[job.logicalId]=candidate;await persist();
    }
    const check=await run('acceptance',{job,candidate:content,research:state.plan.research},job.logicalId);
    if(check.status==='pending-host')return check;
    const verdict=check.value.data as {accepted?:unknown;reason?:unknown};
    accepted=verdict.accepted===true&&typeof verdict.reason==='string'&&!!verdict.reason.trim();
    if(accepted) {
     // Persist accepted bytes and digest atomically before marking this job done.
     candidate={job:{...job},content:content!,digest:digest(content!),accepted:true};state.candidates[job.logicalId]=candidate;await persist();
    } else {delete state.candidates[job.logicalId];candidate=undefined!;state.attempts[job.logicalId]=attempt+1;await persist();}
   }
   if(!accepted)throw new Error('required artifact failed semantic acceptance: '+job.logicalId);
  }
  job.status='done';await persist();dependencies.onProgress?.({stage:'generation',unit:'artifacts',task:job.logicalId,completed:completed(),total:state.plan.jobs.length,status:reused?'reused':'running',next:'fixed assembly after all required jobs'});
  semantic.push({logicalId:job.logicalId,target:job.target,content:candidate!.content,ownership:{kind:'file'},consumer:job.consumer,source:{kind:'semantic',ref:baseKey,digest:candidate!.digest}});
 }
 for(const g of state.plan.guidance)if(g.coverageStatus==='reusable'||g.coverageStatus==='partial') {
  const actual=await reader.read(g.sourceRef.path,g.sourceRef.startLine,g.sourceRef.endLine);
  if(actual.evidence.digest!==g.sourceRef.digest)throw new Error('guidance binding source changed');
  if(semantic.some(a=>a.target===g.sourceRef.path))throw new Error('reused source must remain unowned');
 }
 const assets=await renderFixed(profile,options,integration,semantic,state.plan.guidance);
 validateNavigation(assets,profile.files);
 const seen=new Set<string>();for(const a of assets){const key=a.target+signature(a.ownership);if(seen.has(key))throw new Error('duplicate candidate target');seen.add(key);}
 const effectiveDispositions=state.resultInventory===inv||state.artifactRefreshInventory===inv ? previousAssets.map(a=>{
  const current=assets.find(asset=>asset.logicalId===a.logicalId);
  const refreshed=state.artifactRefreshInventory===inv&&current?.source.kind==='semantic'&&current.target===a.target&&signature(current.ownership)===signature(a.ownership)&&digest(current.content)!==a.digest;
  return {logicalId:a.logicalId,action:refreshed?'update' as const:'retain' as const,reason:refreshed?'Existing planned artifact revalidated under the current evidence contract':'Inventory matches accepted candidates'};
 }) : [...state.plan.dispositions.filter(d=>!fixedInventory.some(a=>a.logicalId===d.logicalId)),...fixedInventory.map(a=>({logicalId:a.logicalId,action:'retain' as const,reason:'Explicit deterministic selection maintained'}))];
 const dispositions=effectiveDispositions.map(original=>{
  const current=assets.find(a=>a.logicalId===original.logicalId);const oldItem=previousAssets.find(a=>a.logicalId===original.logicalId);
  const d=!current&&fixedKinds.has(oldItem?.source?.kind??'')?{...original,action:'retire' as const,reason:'Deterministic capability no longer selected; explicit retirement consent required'}:current&&(!options.sdd||fixedKinds.has(current.source.kind))?{...original,action:(digest(current.encoding==='base64'?Buffer.from(current.content,'base64'):current.content)===oldItem?.digest?'retain':'update') as 'retain'|'update',reason:'Disposition derived from selected deterministic candidate and original baseline'}:original;
  const replacement=assets.find(a=>a.logicalId===d.logicalId);
  if(d.action==='update'&&!replacement)throw new Error('update disposition lacks replacement');
  if(d.action==='retire'&&replacement)throw new Error('retired asset still active');
  const old=previousAssets.find(a=>a.logicalId===d.logicalId);
  if(d.action==='retain'&&replacement&&old&&digest(replacement.content)!==old.digest)throw new Error('retained asset changed without update disposition');
  return d;
 });
 // After installation the inventory changes from the input to these accepted candidates.
 const retained=previousAssets.filter(a=>dispositions.some(d=>d.logicalId===a.logicalId&&d.action==='retain')&&!assets.some(n=>n.logicalId===a.logicalId));
 state.resultInventory=inventorySignature([...assets.map(a=>({...a,digest:digest(a.encoding==='base64'?Buffer.from(a.content,'base64'):a.content)})),...retained]);await persist();
 return {status:'complete',value:{root:profile.root,fingerprint:profile.fingerprint,options,assets,operations:integration.operations,dispositions,warnings:[...profile.unknowns,...integration.warnings],requirements:integration.requirements,versions}};
}
