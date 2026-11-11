import {posix} from 'node:path';
import {scopeContains,scopesOverlap,validateTopicId,type Evidence,type ManagedAsset,type StepResult} from '../types.js';
import type {RepositoryReader,ResearchResult} from '../analyzer/backend.js';
import {digest} from '../analyzer/evidence.js';
import {collectTopicEvidence,topicEvidenceRequests,type TopicEvidenceBatch} from '../analyzer/topic-evidence.js';
import {artifactVerdict,relativeTarget,type ArtifactDraftPolicy,type ArtifactJob,type ArtifactPage} from './artifacts.js';
import {markdownLinks} from './document-policy.js';

const PROJECT_RULES_ID='project-development-rules';
const RULES_FILE='development-rules.md';
const MAX_RULE_TOPICS=12,MAX_TOPIC_EVIDENCE_BATCHES=2;
export const isProjectRulesId=(id:string)=>id===PROJECT_RULES_ID||id.startsWith(PROJECT_RULES_ID+':');
export const PROJECT_RULES_CONSUMER='change-prepare/change-deliver';
export const isProjectRulesIndex=(asset:Pick<ManagedAsset,'logicalId'|'target'>)=>isProjectRulesId(asset.logicalId)&&asset.target.endsWith('/'+RULES_FILE);

export interface GuidanceBinding {topic:string;topicId?:string;sourceRef?:Evidence;scope:string[];coverageStatus:string;consumers:string[];gaps:string[]}
export interface RuleRepair {draft:unknown;ruleIds:string[]}
export interface RuleEvidenceState {topicEvidence?:{limit:number;batches:TopicEvidenceBatch[]}}
export interface ProjectRuleSource {
 id:string;
 topic:string;
 statement:string;
 authority:'explicit-rule'|'convention';
 scope:string[];
 supportingEvidence:Evidence[];
 counterEvidence:Evidence[];
 exceptions:string[];
 gap?:string;
}
export interface ProjectRuleTopic {
 id:string;
 title:string;
 target?:string;
 scope:string[];
 ruleIds:string[];
 guidance:{source:Evidence;scope:string[]}[];
}

interface RuleObservation {
 topic?:string;
 topicId?:string;
 statement:string;
 classification:string;
 guidanceDisposition?:string;
 scope:unknown[];
 supportingEvidence:Evidence[];
 counterEvidence:Evidence[];
 exceptions?:unknown[];
 gap?:string;
}

const within=(path:string,scope:string)=>scopeContains(scope,path);
const configuration=(path:string)=>path.startsWith('.husky/')||/^(?:Makefile|Dockerfile|\.dependency-cruiser\.js|\.(?:eslint|prettier)rc(?:\.[^.]+)?)$|\.(?:config\.[^.]+|jsonc?|ya?ml|toml|ini|xml)$/i.test(posix.basename(path));
const documentation=(path:string)=>/\.(?:md|mdx|rst|adoc|txt)$/i.test(path);
const singleLine=(value:unknown)=>typeof value==='string'?value.replace(/[\x00-\x20\x7f]+/g,' ').trim():'';
const needsDecision=(binding:GuidanceBinding)=>['needs-decision','conflicting','unavailable'].includes(binding.coverageStatus);
const claimKey=(id:string|undefined,topic:unknown)=>JSON.stringify([id,singleLine(topic)]);
const evidenceKey=({path,startLine,endLine,digest}:Evidence)=>JSON.stringify([path,startLine,endLine,digest]);

export function isOriginalGuidance(binding:GuidanceBinding):binding is GuidanceBinding&{sourceRef:Evidence} {
 return !!binding.sourceRef&&documentation(binding.sourceRef.path)&&(binding.coverageStatus==='reusable'||binding.coverageStatus==='partial');
}

export function sameAuthoritySource(binding:GuidanceBinding,source:GuidanceBinding):boolean{
 return !!binding.sourceRef&&binding.sourceRef.path===source.sourceRef?.path&&
  (binding.topicId===undefined?binding.topic===source.topic:binding.topicId===source.topicId);
}

export function replacedSourceAssessment(binding:GuidanceBinding,authority:GuidanceBinding[],conventionPaths:ReadonlySet<string>):boolean{
 return !!binding.sourceRef&&['reusable','partial'].includes(binding.coverageStatus)&&
  (conventionPaths.has(binding.sourceRef.path)||authority.some(source=>sameAuthoritySource(binding,source)&&scopesOverlap(binding.scope,source.scope)));
}

export function verifiedScopes(scope:unknown[],files:string[]):string[] {
 return scope.map(path=>typeof path==='string'?path.replace(/\/+$/,''):'')
  .filter(path=>!/[\x00-\x1f\x7f]/.test(path)&&(path==='.'||relativeTarget(path)&&files.some(file=>within(file,path))));
}

function parseRuleTopics(value:unknown,provisional=false):Map<string,ProjectRuleTopic> {
 const declarations=value??[];
 const topics=new Map<string,ProjectRuleTopic>();
 const declaredIds=new Set<string>();
 if(!provisional&&(!Array.isArray(declarations)||declarations.length>MAX_RULE_TOPICS))throw new Error('ruleTopics: expected at most twelve project topics');
 for(const declaration of Array.isArray(declarations)?declarations.slice(0,MAX_RULE_TOPICS):[]){
  try{
   const {id:rawId,title}=object(declaration);
   const id=validateTopicId(rawId);
   if(declaredIds.has(id)){
    topics.delete(id);
    throw new Error('ruleTopics: expected unique, portable topic IDs');
   }
   declaredIds.add(id);
   topics.set(id,{id,title:text(title),scope:[],ruleIds:[],guidance:[]});
  }catch(error){
   // Planning can correct malformed provisional declarations. They cannot authorize reads.
   if(!provisional)throw error;
  }
 }
 return topics;
}

export async function planWithProjectRules(input:Record<string,unknown>&{inventoryPolicy:string},options:{
 previousAssets:Pick<ManagedAsset,'logicalId'|'target'>[];
 run:(input:unknown)=>Promise<StepResult<ResearchResult>>;
 evidence?:{analysis:unknown;reader:RepositoryReader;callsLeft:number;state:RuleEvidenceState;persist:()=>Promise<void>};
}):Promise<StepResult<Record<string,unknown>>> {
 const {previousAssets,run,evidence}=options;
 const previousRuleTopics=previousAssets.flatMap(asset=>{
  const id=isProjectRulesId(asset.logicalId)?asset.logicalId.split(':topic:')[1]:undefined;
  return id?[{id,target:asset.target}]:[];
 });
 const planInput={...input,...(previousRuleTopics.length?{
  inventoryPolicy:input.inventoryPolicy+' Reuse previousRuleTopics IDs for the same concerns, even when the titles or document route change.',
  previousRuleTopics,
 }:{})};
 const analysis=evidence?.analysis as Record<string,unknown>|undefined;
 const topics=new Set(parseRuleTopics(analysis?.ruleTopics,true).keys());
 if(evidence&&!evidence.state.topicEvidence){
  const requests=topicEvidenceRequests(analysis);
  const batches=requests.length?[await collectTopicEvidence('analysis',requests,topics,evidence.reader)]:[];
  // Reserve the final plan, content and acceptance calls. Save before dispatch to preserve the request identity on resume.
  const extraCalls=Math.max(0,evidence.callsLeft-3);
  evidence.state.topicEvidence={limit:Math.min(MAX_TOPIC_EVIDENCE_BATCHES,batches.length+(topics.size?extraCalls:0)),batches};
  await evidence.persist();
 }
 const followup=evidence?.state.topicEvidence;
 for(;;){
  const remainingBatches=followup?followup.limit-followup.batches.length:0;
  const response=await run({...planInput,...(followup?{topicEvidence:{remainingBatches,batches:followup.batches}}:{})});
  if(response.status==='pending-host')return response;
  const data=response.value.data as Record<string,unknown>;
  const requests=followup?topicEvidenceRequests(data):[];
  if(!requests.length)return {status:'complete',value:data};
  if(!evidence||!followup||remainingBatches<1)throw new Error('Topic evidence request allowance exhausted; a final artifact plan is required');
  followup.batches.push(await collectTopicEvidence('plan',requests,topics,evidence.reader));
  await evidence.persist();
 }
}

export function prepareProjectRules(data:Record<string,unknown>,files:string[],root:string,otherJobs:ArtifactJob[]=[],authority:GuidanceBinding[]=[],conventionPaths:ReadonlySet<string>=new Set(),selectedScopes:string[]=[]):{job?:ArtifactJob;referenceIndex?:ArtifactPage;guidance:GuidanceBinding[]} {
 const target=root+'/'+RULES_FILE;
 const topicDirectory=target.slice(0,-3)+'/';
 if(otherJobs.some(job=>isProjectRulesId(job.logicalId)||job.target===target||job.target.startsWith(topicDirectory)))throw new Error('Development rules targets are reserved for verified project rules');
 const observations=data.observations as RuleObservation[];
 const assessed=(data.guidance??[]) as GuidanceBinding[];
 const guidance=[...assessed.filter(binding=>!replacedSourceAssessment(binding,authority,conventionPaths)),...authority];
 const covered=guidance.filter(source=>isOriginalGuidance(source)&&source.coverageStatus==='reusable');
 const unresolved=[...guidance.filter(needsDecision),...observations.filter(item=>item.guidanceDisposition==='needs-decision')];
 const topics=parseRuleTopics(data.ruleTopics);
 const hasDeclaredTopics=topics.size>0;
 const topicFor=(id?:string)=>{
  const declared=id&&topics.get(id);
  if(declared)return declared;
  if(hasDeclaredTopics)return;
  const general='project-conventions';
  if(!topics.has(general))topics.set(general,{id:general,title:'',scope:[],ruleIds:[],guidance:[]});
  return topics.get(general)!;
 };
 const selected:{group:ProjectRuleTopic;rank:number;rule:Omit<ProjectRuleSource,'id'>}[]=[];
 const groupCounts=new Map<string,number>();
 for(const observation of observations){
  const {classification,scope,supportingEvidence,counterEvidence}=observation;
  const topic=singleLine(observation.topic);
  if(!topic||topic.length>1000)continue;
  const key=claimKey(observation.topicId,topic),keyWithoutTopicId=claimKey(undefined,topic);
  const scopes=verifiedScopes(scope,files);
  if(selectedScopes.length&&scopes.some(scope=>!selectedScopes.some(parent=>scopeContains(parent,scope))))continue;
  const sameScope=(binding:GuidanceBinding)=>claimKey(binding.topicId,binding.topic)===key&&binding.scope.length===scopes.length&&scopes.every(path=>binding.scope.includes(path));
  const bind=(status:string,refs:Evidence[])=>{
   const gaps=status==='needs-decision'?[singleLine(observation.statement)].filter(Boolean):[];
   for(const ref of refs){
    const refKey=evidenceKey(ref);
    const present=guidance.some(binding=>binding.sourceRef&&binding.coverageStatus===status&&sameScope(binding)&&evidenceKey(binding.sourceRef)===refKey);
    if(!present){
     guidance.push({topic,topicId:observation.topicId,sourceRef:ref,scope:scopes,coverageStatus:status,consumers:['prepare','deliver','review'],gaps});
    }
   }
  };
  if(observation.guidanceDisposition==='needs-decision'){
   bind('needs-decision',[...supportingEvidence,...counterEvidence]);
   continue;
  }
  const overlaps=(source:{topicId?:string;topic?:string;scope:unknown[]})=>{
   const sourceKey=claimKey(source.topicId,source.topic);
   return (sourceKey===key||sourceKey===keyWithoutTopicId)&&scopesOverlap(scopes,verifiedScopes(source.scope,files));
  };
  const authorityOverlaps=authority.some(source=>(observation.topicId===undefined?source.topic===topic:source.topicId===observation.topicId)&&scopesOverlap(source.scope,scopes)&&
   (source.coverageStatus!=='partial'||!source.gaps.includes(observation.gap??'')||scopes.some(scope=>!source.scope.some(parent=>scopeContains(parent,scope)))));
  if((classification!=='explicit-rule'&&classification!=='convention')||!scopes.length||scopes.length!==scope.length||authorityOverlaps||covered.some(overlaps)||unresolved.some(overlaps))continue;
  const exceptions=Array.isArray(observation.exceptions)?observation.exceptions.map(singleLine).filter(Boolean):[];
  if(counterEvidence.length&&!exceptions.length||exceptions.some(exception=>exception.length>1000)){
   bind('needs-decision',[...supportingEvidence,...counterEvidence]);
   continue;
  }
  const documented=classification==='explicit-rule'?supportingEvidence.filter(ref=>documentation(ref.path)):[];
  bind('reusable',documented.filter(ref=>!guidance.some(binding=>sameScope(binding)&&binding.sourceRef?.path===ref.path)));
  if(documented.length||observation.guidanceDisposition!=='follow-existing')continue;
  if(classification==='convention'){
   const supports=scopeSupportingPaths(supportingEvidence,scopes);
   if(scopes.includes('.')||supports.size<2||scopes.some(path=>![...supports].some(file=>within(file,path))))continue;
  }else{
   const configRefs=supportingEvidence.filter(ref=>configuration(ref.path));
   if(scopes.some(scope=>!configRefs.some(ref=>within(scope,posix.dirname(ref.path))||scope!=='.'&&within(ref.path,scope))))continue;
  }
  const group=topicFor(observation.topicId);
  if(!group)continue;
  const rank=groupCounts.get(group.id)??0;
  if(rank>=(hasDeclaredTopics?4:8))continue;
  groupCounts.set(group.id,rank+1);
  selected.push({group,rank,rule:{topic,statement:observation.statement,authority:classification,scope:scopes,supportingEvidence,counterEvidence,exceptions,
   ...(typeof observation.gap==='string'?{gap:observation.gap}:{})}});
 }
 // If the plan exceeds the total bound, retain breadth before adding more rules to one topic.
 if(selected.length>18)selected.sort((a,b)=>a.rank-b.rank);
 const ruleSources=selected.slice(0,18).map(({group,rule},index)=>{
  const id='R'+(index+1);
  group.ruleIds.push(id);
  group.scope.push(...rule.scope);
  group.target=topicDirectory+group.id+'.md';
  return {...rule,id};
 });
 if(!ruleSources.length&&!hasDeclaredTopics)return {guidance};
 for(const binding of guidance.filter(isOriginalGuidance)){
  if(conventionPaths.has(binding.sourceRef.path))continue;
  topicFor(binding.topicId)?.guidance.push({source:binding.sourceRef,scope:verifiedScopes(binding.scope,files)});
 }
 const logicalId=root==='docs/rigup'?PROJECT_RULES_ID:PROJECT_RULES_ID+':'+digest(target);
 const ruleTopics=[...topics.values()].filter(topic=>topic.ruleIds.length||topic.guidance.length);
 if(!ruleSources.length){
  if(!ruleTopics.some(topic=>topic.guidance.length)||guidance.some(binding=>binding.sourceRef?.path===target))return {guidance};
  return {guidance,referenceIndex:{logicalId,target,content:renderRuleIndex(target,ruleTopics)}};
 }
 const evidence=new Map<string,Evidence>();
 for(const rule of ruleSources)for(const ref of [...rule.supportingEvidence,...rule.counterEvidence])evidence.set(evidenceKey(ref),ref);
 for(const topic of ruleTopics)for(const {source} of topic.guidance)evidence.set(evidenceKey(source),source);
 for(const binding of guidance)if(binding.sourceRef&&binding.topicId&&topics.has(binding.topicId)&&needsDecision(binding))evidence.set(evidenceKey(binding.sourceRef),binding.sourceRef);
 return {guidance,job:{
  logicalId,target,purpose:'Project development rules for future changes',consumer:PROJECT_RULES_CONSUMER,
  required:true,reason:'Apply verified project rules and scoped code conventions during planning, implementation and review',
  sourceRefs:[...evidence.values()],seedPaths:[],relatedArtifacts:[],ruleSources,ruleTopics,status:'pending',
  acceptance:['The index links to each listed topic target when present and to the original guidance listed in job.ruleTopics. Each generated topic page contains its selected rules.',
   'Every rule instructs future changes and gives a concrete verification step.',
   'Each instruction preserves the verified authority, scope and applicable exceptions. Evidence and unresolved research remain in the private plan.',
   'The selected document language is used and native approval and verification gates remain authoritative.'],
 }};
}

function scopeSupportingPaths(evidence:Evidence[],scopes:string[]):Set<string> {
 return new Set(evidence.filter(ref=>scopes.some(scope=>within(ref.path,scope))).map(ref=>ref.path));
}

function object(value:unknown):Record<string,unknown> {
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('rulebook: expected structured rules');
 return value as Record<string,unknown>;
}

const escapeText=(value:string)=>value.replace(/[\\`*_\[\]<>]/g,'\\$&');
function text(value:unknown):string {
 if(typeof value!=='string'||!value.trim()||value.length>1000||/[\x00-\x1f\x7f]/.test(value))throw new Error('rulebook: expected concise single-line text');
 return value.trim();
}

function localLink(from:string,to:string,label:string):string {
 const link=posix.relative(posix.dirname(from),to).split('/').map(part=>encodeURIComponent(part).replaceAll('(','%28').replaceAll(')','%29')).join('/');
 return '['+escapeText(singleLine(label).replace(/[\[\]]/g,''))+']('+link+')';
}

function publicText(value:unknown):string {
 const line=text(value);
 const investigation=/(?:所引|所查).{0,16}(?:示例|证据|源码)|\b(?:cited|inspected) (?:examples?|snippets?|evidence|source ranges?)\b|\bthe evidence (?:shows|suggests|indicates)\b/i;
 if(/#L\d+\b/.test(line)||investigation.test(line)||!markdownLinks(line).next().done)throw new Error('rulebook: keep evidence references and research notes out of topic text');
 return line;
}

function scopeLabel(scope:string[]):string {
 const paths=[...new Set(scope.map(singleLine).filter(Boolean))];
 return paths.length?' · '+paths.map(escapeText).join(', '):'';
}

function renderRuleIndex(target:string,topics:ProjectRuleTopic[],title?:string):string {
 const lines=title?['# '+escapeText(title),'']:[];
 for(const topic of topics){
  const name=publicText(topic.title||title);
  lines.push('- '+(topic.target?localLink(target,topic.target,name)+scopeLabel(topic.scope):'**'+escapeText(name)+'**'));
  const links=new Map<string,string[]>();
  for(const {source,scope} of topic.guidance)links.set(source.path,[...(links.get(source.path)??[]),...scope]);
  for(const [path,scope] of links)lines.push('  - '+localLink(target,path,path)+scopeLabel(scope));
 }
 return lines.join('\n')+'\n';
}

function reviseRulebook(previous:unknown,replacement:unknown,ruleIds:string[]):unknown {
 const draft=object(previous),changes=object(replacement);
 if(!Array.isArray(draft.rules)||!Array.isArray(changes.rules)||changes.rules.length!==ruleIds.length)throw new Error('rulebook: provide one replacement per rejected rule');
 const revisions=new Map<string,Record<string,unknown>>();
 for(const value of changes.rules){
  const rule=object(value),id=rule.sourceId;
  if(typeof id!=='string'||!ruleIds.includes(id)||revisions.has(id))throw new Error('rulebook: replace only the rejected rule IDs');
  revisions.set(id,rule);
 }
 return {...draft,rules:draft.rules.map(rule=>revisions.get(rule.sourceId)??rule)};
}

function renderProjectRules(job:ArtifactJob,value:unknown):{index:string;pages:ArtifactPage[]} {
 const book=object(value);
 const sources=job.ruleSources??[];
 if(!Array.isArray(book.rules)||book.rules.length!==sources.length)throw new Error('rulebook: one instruction for each selected rule source required');
 const rules=new Map<string,Record<string,unknown>>();
 for(const value of book.rules){
  const rule=object(value),id=rule.sourceId;
  if(typeof id!=='string'||!sources.some(source=>source.id===id)||rules.has(id))throw new Error('rulebook: invalid or duplicate rule source');
  rules.set(id,rule);
 }
 const sentence=(value:unknown)=>publicText(value).replace(/`([^`]+)`|\*\*([^*]+)\*\*|[\\`*_\[\]<>]/g,(match,code?:string,strong?:string)=>{
  if(code)return '`'+code+'`';
  if(strong)return '**'+escapeText(strong)+'**';
  return escapeText(match);
 });
 const plain=(value:unknown)=>escapeText(publicText(value));
 const title=publicText(book.title),topics=job.ruleTopics??[];
 const index=renderRuleIndex(job.target,topics,title);
 const pages:ArtifactPage[]=[];
 const when=plain(book.when),verify=plain(book.verify),exceptions=plain(book.exceptions);
 for(const topic of topics){
  const target=topic.target;
  if(!target)continue;
  const lines=['# '+plain(topic.title||title),''];
  for(const [authority,heading] of [['explicit-rule',book.existing],['convention',book.inferred]] as const){
   const group=sources.filter(source=>source.authority===authority&&topic.ruleIds.includes(source.id));
   if(!group.length)continue;
   lines.push('## '+plain(heading),'');
   for(const source of group){
    const rule=rules.get(source.id)!;
    if(!Array.isArray(rule.exceptions)||rule.exceptions.length!==source.exceptions.length)throw new Error('rulebook: provide a behavioral limit or null for each private exception');
    lines.push('### '+plain(source.topic),'',source.scope.map(escapeText).join(', '),'',
     '- **'+when+'** '+sentence(rule.trigger),'- '+sentence(rule.instruction),'- **'+verify+'** '+sentence(rule.verification));
    for(const exception of rule.exceptions)if(exception!==null)lines.push('- **'+exceptions+'** '+sentence(exception));
    lines.push('');
   }
  }
  pages.push({logicalId:job.logicalId+':topic:'+topic.id,target,content:lines.join('\n')});
 }
 if(!pages.length)throw new Error('rulebook: expected topic pages');
 return {index,pages};
}

export function isProjectRulesJob(job:ArtifactJob):job is ArtifactJob&{ruleSources:ProjectRuleSource[]} {
 return !!job.ruleSources;
}

export function projectRuleDraftPolicy(job:ArtifactJob,evidence:RuleEvidenceState):ArtifactDraftPolicy|undefined {
 if(!isProjectRulesJob(job))return;
 const batches=evidence.topicEvidence?.batches;
 return {
  maxAttempts:3,
  context:batches?.length?{topicEvidence:batches}:{},
  repairInput(repair){
   if(!repair)return {rulebookRepair:undefined};
   const draft=repair.draft as {rules:{sourceId:string}[]};
   return {rulebookRepair:{ruleIds:repair.ruleIds,priorRules:draft.rules.filter(rule=>repair.ruleIds.includes(rule.sourceId))}};
  },
  content(data,repair){
   const output=(data as {rulebook?:unknown}).rulebook;
   const rulebook=repair?reviseRulebook(repair.draft,output,repair.ruleIds):output;
   const {index,pages}=renderProjectRules(job,rulebook);
   return {content:index,pages,rulebook};
  },
  acceptance(data,candidate){
   const {accepted,reason,rejectedRuleIds:ids}=artifactVerdict(data);
   const repair=candidate.rulebook&&Array.isArray(ids)&&ids.length&&ids.every(id=>job.ruleSources.some(rule=>rule.id===id))
    ?{draft:candidate.rulebook,ruleIds:[...new Set<string>(ids)]}:undefined;
   return {accepted,reason,repair};
  },
 };
}
