import type {RunProgressEvent} from '../progress.js';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import type {ProjectProfile} from '../analyzer/repository.js';
import {repositoryReader} from '../analyzer/repository.js';
import {researchBudget} from '../analyzer/budget.js';
import {validateResearch,type AnalysisBackend,type ResearchResult} from '../analyzer/backend.js';
import type {ManagedAsset,SetupOptions,SetupPlan,StepResult,AssetDisposition} from '../types.js';
import {scopeContains,scopesOverlap,validateInventory} from '../types.js';
import {prepareIntegrations,type IntegrationPreparation,type PreparedAsset} from '../integrations/registry.js';
import {digest} from '../analyzer/evidence.js';
import {READ_POLICY_VERSION} from '../analyzer/read-policy.js';
import {filterContent} from '../analyzer/read-policy.js';
import {trustedBaseline} from '../installer/baseline.js';
import {PROMPT_VERSION} from '../analyzer/prompts.js';
import {stageEvidence} from '../analyzer/stage-context.js';
import {documentDraftPolicy,validateArtifactList,type ArtifactContent,type ArtifactJob,type ArtifactPage} from './artifacts.js';
import {validateDocumentJob,validateDocumentTarget,validateDocumentContent,validateTemplateContent,DOCUMENT_POLICY_VERSION} from './document-policy.js';
import {readWorkflowTemplates,reconcileHarnessNavigation,renderFixed,validateNavigation,TEMPLATE_VERSION,type HarnessNavigation} from './render.js';
import {isProjectRulesId,isProjectRulesJob,planWithProjectRules,prepareProjectRules,projectRuleDraftPolicy,PROJECT_RULES_CONSUMER,type GuidanceBinding,type RuleEvidenceState,type RuleRepair} from './project-rules.js';
import {signature,privateDirectory,readCache,saveCache} from './cache.js';
import {isGitlabWiring} from '../integrations/gitlab/ci.js';
import {planHarness,sourceGuidance} from './harness.js';
import {renderConventionSeed} from '../project-conventions.js';
export interface GenerationDependencies {prepared?:GenerationPreparation;effectiveModel?:SetupOptions['model'];reader?:import('../analyzer/backend.js').RepositoryReader;cacheRoot?:string;onProgress?:(event:RunProgressEvent)=>void;runId?:string;spent?:{calls:number;tokens:number|'unknown'};save?:(path:string,content:string)=>Promise<void>;budget?:{maxCalls:number;maxTokens:number}}
interface Candidate extends ArtifactContent {job:ArtifactJob;digest:string;accepted:boolean}
interface State extends RuleEvidenceState {version:1;artifactContextVersion?:string;artifactRefreshInventory?:string;inputInventory:string;resultInventory?:string;runId:string;plan?:{jobs:ArtifactJob[];referenceIndex?:ArtifactPage;dispositions:AssetDisposition[];guidance:GuidanceBinding[];research:unknown};candidates:Record<string,Candidate>;attempts?:Record<string,number>;repairReasons?:Record<string,string>;ruleRepairs?:Record<string,RuleRepair>;spent:{calls:number;tokens:number|'unknown'}}
const candidateDigest=(content:string,pages?:ArtifactPage[])=>pages?signature({content,pages}):digest(content);
export function inventorySignature(assets:ManagedAsset[]):string {return signature(assets.map(a=>({logicalId:a.logicalId,target:a.target,ownership:a.ownership,digest:a.digest})).sort((a,b)=>a.logicalId.localeCompare(b.logicalId)));}
type GenerationPreparation={integration:IntegrationPreparation;fixedTemplates:Awaited<ReturnType<typeof readWorkflowTemplates>>};
export async function prepareGeneration(profile:ProjectProfile,options:SetupOptions):Promise<GenerationPreparation>{
 const [integration,fixedTemplates]=await Promise.all([prepareIntegrations(profile,options),readWorkflowTemplates()]);
 for(const asset of integration.assets)if(asset.source.kind==='customer-template')validateTemplateContent(asset.content);
 return {integration,fixedTemplates};
}

function setupPlan(profile:ProjectProfile,options:SetupOptions,integration:IntegrationPreparation,assets:PreparedAsset[],dispositions:AssetDisposition[],previousAssets:ManagedAsset[],harness:ReturnType<typeof planHarness>,navigation:HarnessNavigation,projectRules?:SetupPlan['projectRules']):SetupPlan{
 const retainedIds=new Set(dispositions.filter(d=>d.action==='retain').map(d=>d.logicalId));
 const retainedTargets=previousAssets.filter(a=>retainedIds.has(a.logicalId)).map(a=>a.target);
 const context=options.projectConventions?.documentRoutes?.context??'docs/rigup';
 const projectDocuments=harness.drafts.flatMap(draft=>{
  const document=renderConventionSeed(draft);
  const target=context+'/'+document.target;
  const mapped=options.projectConventions?.topics?.find(topic=>topic.id===draft.topicId&&topic.scope.includes(draft.scope))?.source;
  if(mapped&&mapped!==target&&profile.conventions?.some(page=>page.path===mapped&&page.topicId===draft.topicId&&page.scope===draft.scope))return [];
  return [{...document,target}];
 });
 // The research inventory excludes managed files. Preview checks retained targets on disk.
 validateNavigation(assets,[...profile.files,...retainedTargets,...projectDocuments.map(document=>document.target)],navigation.inherited);
 const seen=new Set<string>();
 for(const asset of assets){
  const key=asset.target+signature(asset.ownership);
  if(seen.has(key))throw new Error('duplicate candidate target');
  seen.add(key);
 }
 const gitlabReviewRequired=profile.gitlabReviewRequired&&(!!options.quality?.gitlab||previousAssets.some(a=>isGitlabWiring(a.logicalId)));
 const notApplicable=profile.conventions?.flatMap(page=>page.status==='not-applicable'?
  [{path:page.path,topic:page.title,topicId:page.topicId,scope:[page.scope]}]:[])??[];
 return {root:profile.root,fingerprint:profile.fingerprint,options,assets,operations:integration.operations,dispositions,
  harness:harness.summary,
  ...(navigation.targets.length||navigation.conventionPaths.length?{harnessNavigation:{targets:navigation.targets,conventionPaths:navigation.conventionPaths,...(notApplicable.length?{notApplicable}:{})}}:{}),
  ...(projectDocuments.length?{projectDocuments}:{}),
  ...(gitlabReviewRequired?{gitlabReviewRequired:true as const}:{}),
  warnings:[...profile.unknowns,...integration.warnings,...navigation.warnings,...(gitlabReviewRequired?['GitLab wiring was left as-is. A complete root review is required to verify and change the selection.']:[])],requirements:integration.requirements,
  versions:{prompt:PROMPT_VERSION,template:TEMPLATE_VERSION,document:DOCUMENT_POLICY_VERSION,read:READ_POLICY_VERSION},
  ...(projectRules?{projectRules}:{})};
}

export async function generateFoundation(profile:ProjectProfile,options:SetupOptions,prepared:GenerationPreparation,previousAssets:ManagedAsset[]=[],preserveWorkflowContext=false,previousGuidance:GuidanceBinding[]=[]):Promise<SetupPlan>{
 const {integration,fixedTemplates}=prepared;
 const harness=planHarness(profile,options,previousGuidance);
 const candidates=await renderFixed(profile,options,integration,[],harness.summary.guidance,fixedTemplates,!preserveWorkflowContext);
 const navigation=await reconcileHarnessNavigation(profile,options,candidates,previousAssets,harness.summary.guidance,preserveWorkflowContext);
 const assets=navigation.assets;
 const dispositions:AssetDisposition[]=previousAssets.map(asset=>({logicalId:asset.logicalId,action:assets.some(candidate=>candidate.logicalId===asset.logicalId)?'update':'retain',reason:'Refresh fixed configuration while preserving existing project guidance'}));
 return setupPlan(profile,options,integration,assets,dispositions,previousAssets,harness,navigation,preserveWorkflowContext&&!navigation.pending?'ready':'pending');
}

export async function generate(profile:ProjectProfile,options:SetupOptions,backend:AnalysisBackend,previousAssets:ManagedAsset[]=[],dependencies:GenerationDependencies={}):Promise<StepResult<SetupPlan>> {
 const {integration,fixedTemplates}=dependencies.prepared??await prepareGeneration(profile,options);
 const versions={prompt:PROMPT_VERSION,template:TEMPLATE_VERSION,document:DOCUMENT_POLICY_VERSION,read:READ_POLICY_VERSION};
 const allowedRoots=[options.projectConventions?.documentRoutes?.context??'docs/rigup'];
 const templateSourcesDigest=signature(integration.assets);
 const authority=sourceGuidance(profile,options);
 const baseKey=signature({fixedTemplates,root:profile.root,fingerprint:profile.fingerprint,options,effectiveModel:dependencies.effectiveModel,versions,templateSourcesDigest,research:profile.research,nativeEntries:profile.nativeEntries,authority});
 const cache=await privateDirectory(dependencies.cacheRoot??join(homedir(),'.cache','rigup','generation'),profile.root);
 const path=join(cache,baseKey+'.json');const save=dependencies.save??saveCache;
 const inv=inventorySignature(previousAssets);
 const fixedKinds=new Set(['fixed-template','customer-mcp','customer-skill','customer-template','quality-template','gitlab-template','customer-runtime','configuration']);
 const deterministic=(asset:Pick<ManagedAsset,'logicalId'|'source'>)=>isProjectRulesId(asset.logicalId)||fixedKinds.has(asset.source?.kind??'');
 const fixedInventory=previousAssets.filter(deterministic);const semanticInventory=previousAssets.filter(a=>!deterministic(a));
 let state=await readCache<State>(path);
 if(!state||state.version!==1||![state.inputInventory,state.resultInventory].includes(inv)||!state.candidates||!state.spent)state={version:1,inputInventory:inv,runId:dependencies.runId??randomUUID(),candidates:{},spent:dependencies.spent??{calls:0,tokens:0}};
 state.attempts??={};state.repairReasons??={};state.ruleRepairs??={};
 const persist=()=>save(path,JSON.stringify(state));
 if(state.artifactContextVersion!==backend.artifactContextVersion){
  // A wider authority contract requires fresh content and independent acceptance.
  // Keep the unchanged plan, run identity, consumption and bounded retry history.
  if(state.plan&&state.resultInventory===inv){state.inputInventory=inv;state.artifactRefreshInventory=inv;}
  state.candidates={};state.ruleRepairs={};for(const job of state.plan?.jobs??[]){job.status='pending';if(isProjectRulesJob(job))delete state.repairReasons[job.logicalId];}
  state.artifactContextVersion=backend.artifactContextVersion;await persist();
 }
 const reader=dependencies.reader??await repositoryReader(profile.root,options,{expectedFingerprint:profile.fingerprint});
 const evidenceFiles=profile.researchFiles??profile.files;
 const wantsRules=options.projectRules??!!options.sdd;
 const budget=dependencies.budget??researchBudget(options);
 const completed=()=>state.plan?.jobs.filter(j=>{const c=state.candidates[j.logicalId];return c?.accepted&&c.digest===candidateDigest(c.content,c.pages);}).length??0;
 const run=async(expectedOutput:'plan'|'content'|'acceptance',input:unknown,artifact?:string):Promise<StepResult<ResearchResult>>=>{
  dependencies.onProgress?.({stage:'generation',unit:'artifacts',task:artifact??'artifact-plan',completed:completed(),total:state.plan?.jobs.length,waiting:options.backend==='host'?'host research response':'provider '+expectedOutput,next:expectedOutput==='acceptance'?'save accepted candidate':'validate candidate',status:'running'});
  if(!backend.durableBudget&&state.spent.calls>=budget.maxCalls)throw new Error('generation request budget exhausted');
  const result=await backend.run({kind:expectedOutput==='plan'?'artifact-plan':'artifact-content',expectedOutput,input,artifact,runId:state.runId,root:profile.root,fingerprint:profile.fingerprint,options,...(authority.length?{sourceGuidance:authority}:{}),effectiveModel:dependencies.effectiveModel,versions,budget,...(options.backend!=='host'?{spent:state.spent}:{}),previousInventoryDigest:state.inputInventory,templateSourcesDigest},reader);
  if(result.status==='complete') {
   await validateResearch(result.value.data,reader);
   state.spent.calls+=typeof result.value.usage.calls==='number'?result.value.usage.calls:1;
   state.spent.tokens=state.spent.tokens==='unknown'||result.value.usage.tokens==='unknown'?'unknown':state.spent.tokens+result.value.usage.tokens;
  }
  await persist();return result;
 };
 if(!state.plan) {
  // Only explicitly selected development workflows require semantic guidance.
  if(!wantsRules) {
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
   const planned=await planWithProjectRules({
    allowedRoots,profile:{files:evidenceFiles,commands:profile.commands,research:profile.research,unknowns:profile.unknowns},previousInventory,
    inventoryPolicy:'Previous generated baselines are comparison context, never evidence of project policy. Reconcile their claims against current source evidence; do not preserve invalidated rules. Local edits remain protected by three-way preview.',
   },{
    previousAssets:fixedInventory,run:input=>run('plan',input),
    evidence:backend.topicEvidence?{analysis:profile.research?.data,reader,callsLeft:budget.maxCalls-state.spent.calls,state,persist}:undefined,
   });
   if(planned.status==='pending-host')return planned;
   const data=planned.value;
   const jobs=validateArtifactList(data.artifacts,[]);
   const {job:rules,referenceIndex,guidance}=prepareProjectRules(data,evidenceFiles,allowedRoots[0],jobs,
    sourceGuidance(profile,options,data.guidance as GuidanceBinding[]|undefined),new Set(profile.conventionPaths));
   if(rules)jobs.unshift(rules);
   for(const job of jobs)validateDocumentJob(job,allowedRoots,profile.files.length===0);
   if(referenceIndex){validateDocumentTarget(referenceIndex.target,allowedRoots);validateTemplateContent(referenceIndex.content);}
   if(!Array.isArray(data.dispositions))throw new Error('old inventory dispositions required');
   const dispositions=data.dispositions as AssetDisposition[];
   validateInventory(semanticInventory.map(a=>a.logicalId),dispositions);
   for(const d of dispositions)if(!semanticInventory.some(a=>a.logicalId===d.logicalId)||typeof d.reason!=='string'||!d.reason.trim()||d.action==='pending')throw new Error('unresolved inventory disposition');
   state.plan={jobs,referenceIndex,dispositions,guidance,research:data};
  }
  await persist();
 }
 const semanticAsset=(page:ArtifactPage,consumer:string):PreparedAsset=>({...page,ownership:{kind:'file'},consumer,source:{kind:'semantic',ref:baseKey,digest:digest(page.content)}});
 const semantic:PreparedAsset[]=state.plan.referenceIndex?[semanticAsset(state.plan.referenceIndex,PROJECT_RULES_CONSUMER)]:[];
 const candidateAssets=(job:ArtifactJob,content:string,pages:ArtifactPage[]=[]):PreparedAsset[]=>[
  {logicalId:job.logicalId,target:job.target,content},...pages,
 ].map(page=>semanticAsset(page,job.consumer));
 for(const job of state.plan.jobs) {
  let candidate:Candidate|undefined=state.candidates[job.logicalId];
  if(candidate && (candidate.digest!==candidateDigest(candidate.content,candidate.pages)||signature({...candidate.job,status:'pending'})!==signature({...job,status:'pending'}))) {delete state.candidates[job.logicalId];candidate=undefined;}
  const reused=!!candidate?.accepted;
  if(!candidate?.accepted) {
   let accepted=false;
   const policy=projectRuleDraftPolicy(job,state)??documentDraftPolicy;
   const {maxAttempts,context}=policy;
   for(let attempt=state.attempts[job.logicalId]??0;attempt<maxAttempts&&!accepted;attempt++) {
    state.attempts[job.logicalId]=attempt;if(attempt)dependencies.onProgress?.({stage:'generation',unit:'artifacts',task:job.logicalId,completed:completed(),total:state.plan.jobs.length,status:'retry',attempt,retryLimit:maxAttempts-1,next:'bounded candidate repair'});
    if(!candidate) {
     const repair=state.ruleRepairs[job.logicalId];
     const response=await run('content',{job,research:state.plan.research,...context,attempt,repairReason:state.repairReasons[job.logicalId],...policy.repairInput(repair)},job.logicalId);
     if(response.status==='pending-host')return response;
     let draft:ArtifactContent;
     try{
      draft=policy.content(response.value.data,repair);
      for(const document of [draft.content,...(draft.pages??[]).map(page=>page.content)])validateDocumentContent(job,document);
      validateNavigation(candidateAssets(job,draft.content,draft.pages),[...profile.files,...state.plan.jobs.map(j=>j.target),...semantic.map(a=>a.target),...integration.assets.map(a=>a.target)]);
     }
     catch(error){state.attempts[job.logicalId]=attempt+1;state.repairReasons[job.logicalId]=(error as Error).message.slice(0,500);await persist();if(attempt+1<maxAttempts)continue;throw error;}
     candidate={job:{...job},...draft,digest:candidateDigest(draft.content,draft.pages),accepted:false};
     state.candidates[job.logicalId]=candidate;await persist();
    }
    const check=await run('acceptance',{job,candidate:candidate.content,candidatePages:candidate.pages,research:state.plan.research,...context},job.logicalId);
    if(check.status==='pending-host')return check;
    const verdict=policy.acceptance(check.value.data,candidate);
    accepted=verdict.accepted;
    delete state.ruleRepairs[job.logicalId];
    if(accepted) {
     // Persist accepted bytes and digest atomically before marking this job done.
     candidate={...candidate,accepted:true};state.candidates[job.logicalId]=candidate;await persist();
    } else {
     if(verdict.repair)state.ruleRepairs[job.logicalId]=verdict.repair;
     delete state.candidates[job.logicalId];candidate=undefined;
     state.repairReasons[job.logicalId]=verdict.reason;
     state.attempts[job.logicalId]=attempt+1;await persist();
    }
   }
   if(!accepted)throw new Error('required artifact failed semantic acceptance: '+job.logicalId);
  }
  job.status='done';await persist();dependencies.onProgress?.({stage:'generation',unit:'artifacts',task:job.logicalId,completed:completed(),total:state.plan.jobs.length,status:reused?'reused':'running',next:'fixed assembly after all required jobs'});
  semantic.push(...candidateAssets(job,candidate!.content,candidate!.pages));
 }
 const ruleCoverage=state.plan.jobs.flatMap(job=>(job.ruleSources??[]).flatMap(rule=>{
  const topicId=job.ruleTopics?.find(topic=>topic.ruleIds.includes(rule.id))?.id;
  const sourceRef=rule.supportingEvidence.find(ref=>!/\.(?:mdx?|rst|adoc|txt)$/i.test(ref.path)&&rule.scope.some(scope=>scopeContains(scope,ref.path)));
  if(!topicId||!sourceRef)return [];
  return [{topicId,topic:rule.topic,scope:rule.scope,sourceRef,gap:rule.gap}];
 }));
 const gapBinding=(binding:GuidanceBinding)=>['missing','partial'].includes(binding.coverageStatus)&&binding.gaps.length>0;
 const sameTopic=(binding:GuidanceBinding,rule:typeof ruleCoverage[number])=>binding.topicId?binding.topicId===rule.topicId:binding.topic===rule.topic;
 const remaining=state.plan.guidance.flatMap(binding=>{
  if(!gapBinding(binding))return [binding];
  const scopes=binding.scope.map(scope=>({scope,gaps:binding.gaps.filter(gap=>!ruleCoverage.some(rule=>
   sameTopic(binding,rule)&&rule.gap===gap&&rule.scope.some(parent=>scopeContains(parent,scope))))}));
  if(scopes.every(item=>item.gaps.length===binding.gaps.length))return [binding];
  return scopes.flatMap(({scope,gaps})=>gaps.length?[{...binding,scope:[scope],gaps}]:
   binding.sourceRef?[{...binding,scope:[scope],gaps,coverageStatus:'reusable'}]:[]);
 });
 const verified=ruleCoverage.flatMap(rule=>{
  if(remaining.some(binding=>gapBinding(binding)&&sameTopic(binding,rule)&&scopesOverlap(binding.scope,rule.scope)))return [];
  const {gap,...binding}=rule;
  return [{...binding,coverageStatus:'reusable',consumers:['agent-entry','prepare','deliver','review'],gaps:[]}];
 });
 const harness=planHarness(profile,options,[...remaining,...verified]);
 const {summary}=harness;
 const guidanceRefs=summary.guidance.flatMap(binding=>binding.sourceRef?[binding.sourceRef]:[]);
 if(guidanceRefs.some(ref=>semantic.some(asset=>asset.target===ref.path)))throw new Error('reused source must remain unowned');
 await stageEvidence(reader,guidanceRefs);
 const rendered=await renderFixed(profile,options,integration,semantic,summary.guidance,fixedTemplates);
 const navigation=await reconcileHarnessNavigation(profile,options,rendered,previousAssets,summary.guidance);
 const {assets}=navigation;
 const effectiveDispositions=state.resultInventory===inv||state.artifactRefreshInventory===inv ? previousAssets.map(a=>{
  const current=assets.find(asset=>asset.logicalId===a.logicalId);
  const refreshed=state.artifactRefreshInventory===inv&&current?.source.kind==='semantic'&&current.target===a.target&&signature(current.ownership)===signature(a.ownership)&&digest(current.content)!==a.digest;
  return {logicalId:a.logicalId,action:refreshed?'update' as const:'retain' as const,reason:refreshed?'Existing planned artifact revalidated under the current evidence contract':'Inventory matches accepted candidates'};
 }) : [...state.plan.dispositions.filter(d=>!fixedInventory.some(a=>a.logicalId===d.logicalId)),...fixedInventory.map(a=>({logicalId:a.logicalId,action:'retain' as const,reason:'Explicit deterministic selection maintained'}))];
 const dispositions=effectiveDispositions.map(original=>{
  if(navigation.retainIds.has(original.logicalId))return {...original,action:'retain' as const,reason:'Preserve navigation pending trusted baseline review'};
  if(profile.gitlabReviewRequired&&isGitlabWiring(original.logicalId))return {...original,action:'retain' as const,reason:'Complete root review required to change GitLab wiring'};
  const current=assets.find(a=>a.logicalId===original.logicalId);const oldItem=previousAssets.find(a=>a.logicalId===original.logicalId);
  const d=!current&&oldItem&&deterministic(oldItem)?{...original,action:'retire' as const,reason:'Managed capability or verified rules no longer selected; explicit retirement consent required'}:current&&(!wantsRules||deterministic(current))?{...original,action:(digest(current.encoding==='base64'?Buffer.from(current.content,'base64'):current.content)===oldItem?.digest&&current.mode===oldItem?.mode?'retain':'update') as 'retain'|'update',reason:'Disposition derived from selected candidate and original baseline'}:original;
  const replacement=assets.find(a=>a.logicalId===d.logicalId);
  if(d.action==='update'&&!replacement)throw new Error('update disposition lacks replacement');
  if(d.action==='retire'&&replacement)throw new Error('retired asset still active');
  const old=previousAssets.find(a=>a.logicalId===d.logicalId);
  if(d.action==='retain'&&replacement&&old&&(digest(replacement.encoding==='base64'?Buffer.from(replacement.content,'base64'):replacement.content)!==old.digest||replacement.mode!==old.mode))throw new Error('retained asset changed without update disposition');
  return d;
 });
 // After installation the inventory changes from the input to these accepted candidates.
 const retained=previousAssets.filter(a=>dispositions.some(d=>d.logicalId===a.logicalId&&d.action==='retain')&&!assets.some(n=>n.logicalId===a.logicalId));
 const plan=setupPlan(profile,options,integration,assets,dispositions,previousAssets,harness,navigation,navigation.pending?'pending':wantsRules?'ready':undefined);
 state.resultInventory=inventorySignature([...assets.map(a=>({...a,digest:digest(a.encoding==='base64'?Buffer.from(a.content,'base64'):a.content)})),...retained]);await persist();
 return {status:'complete',value:plan};
}
