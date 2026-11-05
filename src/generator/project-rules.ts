import {posix} from 'node:path';
import type {Evidence} from '../types.js';
import {digest} from '../analyzer/evidence.js';
import {relativeTarget,type ArtifactJob,type ArtifactPage,type ProjectRuleSource,type ProjectRuleTopic} from './artifacts.js';
import {validateTemplateContent} from './document-policy.js';
import type {GuidanceBinding} from './render.js';

export const PROJECT_RULES_ID='project-development-rules';
export const isProjectRulesId=(id:string)=>id===PROJECT_RULES_ID||id.startsWith(PROJECT_RULES_ID+':');
export const PROJECT_RULES_CONSUMER='change-prepare/change-deliver';

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
}

const within=(path:string,scope:string)=>scope==='.'||path===scope||path.startsWith(scope+'/');
const configuration=(path:string)=>path.startsWith('.husky/')||/^(?:Makefile|Dockerfile|\.dependency-cruiser\.js|\.(?:eslint|prettier)rc(?:\.[^.]+)?)$|\.(?:config\.[^.]+|jsonc?|ya?ml|toml|ini|xml)$/i.test(posix.basename(path));
const singleLine=(value:unknown)=>typeof value==='string'?value.replace(/[\x00-\x20\x7f]+/g,' ').trim():'';
const needsDecision=(binding:GuidanceBinding)=>['needs-decision','conflicting','unavailable'].includes(binding.coverageStatus);
const claimKey=(id:string|undefined,topic:unknown)=>JSON.stringify([id,singleLine(topic)]);
const evidenceKey=({path,startLine,endLine,digest}:Evidence)=>JSON.stringify([path,startLine,endLine,digest]);

function decisionNotes(values:unknown[]):string[] {
 return values.map(singleLine).filter(note=>{
  try{validateTemplateContent(note);return !!note;}catch{return false;}
 });
}

export function prepareProjectRules(data:Record<string,unknown>,files:string[],target:string):{job?:ArtifactJob;referenceIndex?:ArtifactPage;guidance:GuidanceBinding[]} {
 const observations=data.observations as RuleObservation[];
 const guidance=((data.guidance??[]) as GuidanceBinding[]).map(binding=>needsDecision(binding)?{...binding,gaps:decisionNotes(binding.gaps)}:binding);
 const covered=new Set(guidance.filter(source=>source.coverageStatus==='reusable').map(source=>claimKey(source.topicId,source.topic)));
 const unresolved=new Set([
  ...guidance.filter(needsDecision).map(source=>claimKey(source.topicId,source.topic)),
  ...observations.filter(item=>item.guidanceDisposition==='needs-decision').map(item=>claimKey(item.topicId,item.topic)),
 ]);
 const topics=new Map<string,ProjectRuleTopic>();
 const declarations=data.ruleTopics??[];
 if(!Array.isArray(declarations)||declarations.length>12)throw new Error('ruleTopics: expected at most twelve project topics');
 for(const declaration of declarations){
  const {id,title}=object(declaration);
  if(typeof id!=='string'||id.length>48||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)||/^(?:aux|con|nul|prn|com[0-9]|lpt[0-9])$/.test(id)||topics.has(id))throw new Error('ruleTopics: expected unique, portable topic IDs');
  topics.set(id,{id,title:text(title),scope:[],ruleIds:[],guidance:[]});
 }
 const topicFor=(id?:string)=>{
  const declared=id&&topics.get(id);
  if(declared)return declared;
  if(declarations.length)return;
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
  const key=claimKey(observation.topicId,topic),legacyKey=claimKey(undefined,topic);
  const scopes=scope.map(path=>typeof path==='string'?path.replace(/\/+$/,''):'')
   .filter(path=>path==='.'||relativeTarget(path)&&files.some(file=>within(file,path)));
  const sameScope=(binding:GuidanceBinding)=>claimKey(binding.topicId,binding.topic)===key&&binding.scope.length===scopes.length&&scopes.every(path=>binding.scope.includes(path));
  const bind=(status:string,refs:Evidence[])=>{
   const gaps=status==='needs-decision'?decisionNotes([observation.statement]):[];
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
  if((classification!=='explicit-rule'&&classification!=='convention')||!scopes.length||scopes.length!==scope.length||covered.has(key)||covered.has(legacyKey)||unresolved.has(key)||unresolved.has(legacyKey))continue;
  const exceptions=Array.isArray(observation.exceptions)?observation.exceptions.map(singleLine).filter(Boolean):[];
  if(counterEvidence.length&&!exceptions.length||exceptions.some(exception=>exception.length>1000)){
   bind('needs-decision',[...supportingEvidence,...counterEvidence]);
   continue;
  }
  const documented=classification==='explicit-rule'?supportingEvidence.filter(ref=>/\.(?:md|mdx|rst|adoc|txt)$/i.test(ref.path)):[];
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
  if(rank>=(declarations.length?4:8))continue;
  groupCounts.set(group.id,rank+1);
  selected.push({group,rank,rule:{topic,statement:observation.statement,authority:classification,scope:scopes,supportingEvidence,counterEvidence,exceptions}});
 }
 // If the plan exceeds the total bound, retain breadth before adding more rules to one topic.
 if(selected.length>18)selected.sort((a,b)=>a.rank-b.rank);
 const ruleSources=selected.slice(0,18).map(({group,rule},index)=>{
  const id='R'+(index+1);
  group.ruleIds.push(id);
  group.scope.push(...rule.scope);
  group.target=target.slice(0,-3)+'/'+group.id+'.md';
  return {...rule,id};
 });
 if(!ruleSources.length&&!declarations.length)return {guidance};
 for(const binding of guidance)if(binding.sourceRef&&(binding.coverageStatus==='reusable'||binding.coverageStatus==='partial')){
  topicFor(binding.topicId)?.guidance.push({source:binding.sourceRef,scope:binding.scope});
 }
 const logicalId=target==='docs/rigup/development-rules.md'?PROJECT_RULES_ID:PROJECT_RULES_ID+':'+digest(target);
 const issueTopics=new Set(guidance.filter(needsDecision).map(binding=>binding.topicId));
 const ruleTopics=[...topics.values()].filter(topic=>topic.ruleIds.length||topic.guidance.length||issueTopics.has(topic.id));
 if(!ruleSources.length){
  if(!ruleTopics.some(topic=>topic.guidance.length)||guidance.some(binding=>binding.sourceRef?.path===target))return {guidance};
  return {guidance,referenceIndex:{logicalId,target,content:renderRuleIndex(target,ruleTopics,guidance)}};
 }
 const evidence=new Map<string,Evidence>();
 for(const rule of ruleSources)for(const ref of [...rule.supportingEvidence,...rule.counterEvidence])evidence.set(evidenceKey(ref),ref);
 for(const topic of ruleTopics)for(const {source} of topic.guidance)evidence.set(evidenceKey(source),source);
 for(const binding of guidance)if(binding.sourceRef&&binding.topicId&&topics.has(binding.topicId)&&needsDecision(binding))evidence.set(evidenceKey(binding.sourceRef),binding.sourceRef);
 return {guidance,job:{
  logicalId,target,purpose:'Project development rules for future changes',consumer:PROJECT_RULES_CONSUMER,
  required:true,reason:'Apply verified project rules and scoped code conventions during planning, implementation and review',
  sourceRefs:[...evidence.values()],seedPaths:[],relatedArtifacts:[],ruleSources,ruleTopics,status:'pending',
  acceptance:['The index leads to applicable topics and original guidance. Each topic contains the rules selected for it.',
   'Every rule instructs future changes and gives a concrete verification step.',
   'Each instruction distinguishes supporting evidence, authority, scope, counterexamples, and exceptions. The index flags unresolved guidance in selected topics without adopting it.',
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

function localLink(from:string,to:string,label:string,anchor=''):string {
 const link=posix.relative(posix.dirname(from),to).split('/').map(part=>encodeURIComponent(part).replaceAll('(','%28').replaceAll(')','%29')).join('/');
 return '['+escapeText(label.replace(/[\[\]]/g,''))+']('+link+anchor+')';
}

function evidenceLink(target:string,ref:Evidence,label=ref.path+':'+ref.startLine+'–'+ref.endLine):string {
 return localLink(target,ref.path,label,'#L'+ref.startLine+'-L'+ref.endLine);
}

function scopeLabel(scope:string[]):string {
 const paths=[...new Set(scope.map(singleLine).filter(Boolean))];
 return paths.length?' · '+paths.map(escapeText).join(', '):'';
}

function renderRuleIndex(target:string,topics:ProjectRuleTopic[],guidance:GuidanceBinding[],title?:string,decisions?:string):string {
 const lines=title?['# '+escapeText(title),'']:[];
 const decisionLabel=decisions?'**'+escapeText(decisions)+'** ':'`needs-decision` ';
 for(const topic of topics){
  const name=text(topic.title||title);
  lines.push('- '+(topic.target?localLink(target,topic.target,name)+scopeLabel(topic.scope):'**'+escapeText(name)+'**'));
  for(const {source,scope} of topic.guidance)lines.push('  - '+evidenceLink(target,source)+scopeLabel(scope));
  const bindings=guidance.filter(binding=>binding.topicId===topic.id&&needsDecision(binding));
  const claims=new Set(bindings.map(binding=>singleLine(binding.topic)).filter(Boolean));
  for(const claim of claims){
   const related=bindings.filter(binding=>singleLine(binding.topic)===claim);
   lines.push('  - '+decisionLabel+escapeText(claim)+scopeLabel(related.flatMap(binding=>binding.scope)));
   for(const gap of new Set(related.flatMap(binding=>binding.gaps.map(singleLine)).filter(Boolean)))lines.push('    - '+escapeText(gap));
   const refs=new Set(related.flatMap(binding=>binding.sourceRef?[evidenceLink(target,binding.sourceRef)]:[]));
   if(refs.size)lines.push('    - '+[...refs].join(' · '));
  }
 }
 return lines.join('\n')+'\n';
}

export function renderProjectRules(job:ArtifactJob,value:unknown,guidance:GuidanceBinding[]):{index:string;pages:ArtifactPage[]} {
 const book=object(value);
 const sources=job.ruleSources??[];
 if(!Array.isArray(book.rules)||book.rules.length!==sources.length)throw new Error('rulebook: one instruction for each selected rule source required');
 const rules=new Map<string,Record<string,unknown>>();
 for(const value of book.rules){
  const rule=object(value),id=rule.sourceId;
  if(typeof id!=='string'||!sources.some(source=>source.id===id)||rules.has(id))throw new Error('rulebook: invalid or duplicate rule source');
  rules.set(id,rule);
 }
 const originalDocs=guidance.flatMap(binding=>binding.sourceRef&&(binding.coverageStatus==='reusable'||binding.coverageStatus==='partial')?[binding.sourceRef]:[]);
 const sentence=(target:string,topic:ProjectRuleTopic,value:unknown)=>text(value).replace(/`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)]+)\)|[\\`*_\[\]<>]/g,(match,code?:string,strong?:string,label?:string,destination?:string)=>{
  if(code&&!code.includes(']('))return '`'+code+'`';
  if(strong)return '**'+escapeText(strong)+'**';
  if(destination){
   const [path,anchor]=destination.split('#');
   const direct=originalDocs.some(ref=>ref.path===path)?path:posix.normalize(posix.join(posix.dirname(target),path));
   const refs=originalDocs.filter(ref=>ref.path===direct);
   if(refs.length){
    const localRefs=topic.guidance.filter(item=>item.source.path===direct).map(item=>item.source);
    const preferred=localRefs.length?localRefs:refs;
    const ref=anchor?refs.find(ref=>anchor==='L'+ref.startLine+'-L'+ref.endLine||ref.startLine===ref.endLine&&anchor==='L'+ref.startLine):
     preferred.every(ref=>ref.startLine===preferred[0].startLine&&ref.endLine===preferred[0].endLine)?preferred[0]:undefined;
    return ref?evidenceLink(target,ref,label):localLink(target,direct,label!);
   }
  }
  return escapeText(match);
 });
 const plain=(value:unknown)=>escapeText(text(value));
 const title=text(book.title),topics=job.ruleTopics??[];
 const index=renderRuleIndex(job.target,topics,guidance,title,text(book.decisions));
 const pages:ArtifactPage[]=[];
 const when=plain(book.when),verify=plain(book.verify),exceptions=plain(book.exceptions);
 const support=plain(book.support),counter=plain(book.counter);
 for(const topic of topics){
  const target=topic.target;
  if(!target)continue;
  const lines=['# '+plain(topic.title||title),''];
  for(const {source,scope} of topic.guidance)lines.push('- '+evidenceLink(target,source)+scopeLabel(scope));
  if(topic.guidance.length)lines.push('');
  for(const [authority,heading] of [['explicit-rule',book.existing],['convention',book.inferred]] as const){
   const group=sources.filter(source=>source.authority===authority&&topic.ruleIds.includes(source.id));
   if(!group.length)continue;
   lines.push('## '+plain(heading),'');
   for(const source of group){
    const rule=rules.get(source.id)!;
    lines.push('### '+plain(source.topic),'',source.scope.map(plain).join(', '),'',
     '- **'+when+'** '+sentence(target,topic,rule.trigger),'- '+sentence(target,topic,rule.instruction),'- **'+verify+'** '+sentence(target,topic,rule.verification));
    for(const exception of source.exceptions)lines.push('- **'+exceptions+'** '+plain(exception));
    lines.push('- **'+support+'** '+source.supportingEvidence.map(ref=>evidenceLink(target,ref)).join(' · '));
    if(source.counterEvidence.length)lines.push('- **'+counter+'** '+source.counterEvidence.map(ref=>evidenceLink(target,ref)).join(' · '));
    lines.push('');
   }
  }
  pages.push({logicalId:job.logicalId+':topic:'+topic.id,target,content:lines.join('\n')});
 }
 if(!pages.length)throw new Error('rulebook: expected topic pages');
 return {index,pages};
}
