import type {ProjectProfile} from '../analyzer/repository.js';
import {projectChecks} from '../integrations/tools/check-catalog.js';
import {scopeContains,scopesOverlap,validateTopicId,type ConventionDraft,type Evidence,type HarnessSummary,type SetupOptions} from '../types.js';
import {replacedSourceAssessment,sameAuthoritySource,verifiedScopes,type GuidanceBinding} from './project-rules.js';

const selectedScopes=(options:SetupOptions)=>options.scope?.length?options.scope:['.'];
type SourceBinding=GuidanceBinding&{topicId:string;sourceRef:Evidence};
function conventionConsumers(options:SetupOptions):string[]{
 const workflow=options.sdd||options.customSkills?.some(skill=>skill.position==='prepare'||skill.position==='deliver');
 return options.agents.length&&(options.projectRules||workflow)?['agent-entry',...(workflow?['prepare','deliver','review']:[])]:[];
}

function assessedAuthority(source:SourceBinding,assessed:GuidanceBinding[],files:string[],selected:string[]):SourceBinding[]{
 const authorized=source.scope[0];
 const decisions=['conflicting','unavailable','partial','reusable'];
 const assessments=assessed.flatMap(binding=>{
  if(!sameAuthoritySource(binding,source)||!decisions.includes(binding.coverageStatus))return [];
  const scope=verifiedScopes(binding.scope,files).flatMap(path=>scopeContains(authorized,path)?[path]:scopeContains(path,authorized)?[authorized]:[])
   .filter(path=>scopesOverlap(selected,[path]));
  return scope.length?[{...binding,scope}]:[];
 });
 if(!assessments.length)return [source];
 return [...new Set(assessments.flatMap(binding=>binding.scope))].flatMap(scope=>{
  const applicable=assessments.filter(binding=>binding.scope.some(parent=>scopeContains(parent,scope)));
  const coverageStatus=decisions.find(status=>applicable.some(binding=>binding.coverageStatus===status))!;
  if(coverageStatus==='reusable'&&assessments.some(binding=>binding.coverageStatus!=='reusable'&&binding.scope.some(child=>scopeContains(scope,child))))return [];
  return [{...source,scope:[scope],coverageStatus,gaps:[...new Set(applicable.filter(binding=>binding.coverageStatus===coverageStatus).flatMap(binding=>binding.gaps))]}];
 });
}

export function declaredAuthority(profile:ProjectProfile,options:SetupOptions,assessed:GuidanceBinding[]=[]):SourceBinding[]{
 const files=profile.researchFiles??profile.files,selected=selectedScopes(options);
 return (options.projectConventions?.topics??[]).flatMap(topic=>{
  const sourceRef=topic.source&&profile.declaredSources?.[topic.source];
  if(!sourceRef)return [];
  return [...new Set(verifiedScopes(topic.scope,files))].filter(scope=>scopesOverlap(selected,[scope])).flatMap(scope=>
   assessedAuthority({topicId:topic.id,topic:topic.title,scope:[scope],sourceRef,coverageStatus:'reusable',consumers:conventionConsumers(options),gaps:[]},assessed,files,selected));
 });
}

export function sourceGuidance(profile:ProjectProfile,options:SetupOptions,assessed:GuidanceBinding[]=[]):SourceBinding[]{
 const files=profile.researchFiles??profile.files;
 const confirmed=(profile.conventions??[]).filter(page=>page.status==='confirmed'&&page.sourceRef&&verifiedScopes([page.scope],files).length);
 const bindings=[...declaredAuthority(profile,options,assessed),...confirmed.flatMap(page=>{
  const source={topicId:page.topicId,topic:page.title,scope:[page.scope],sourceRef:page.sourceRef!,consumers:conventionConsumers(options)};
  const conflicting=confirmed.some(other=>other.topicId===page.topicId&&other.bodyDigest!==page.bodyDigest&&scopesOverlap([page.scope],[other.scope]));
  if(conflicting)return [{...source,coverageStatus:'conflicting',gaps:['Resolve the differing confirmed sources for their overlapping scope.']}];
  return assessedAuthority({...source,coverageStatus:'reusable',gaps:[]},assessed,files,selectedScopes(options));
 })];
 const key=(binding:typeof bindings[number])=>JSON.stringify([binding.topicId,binding.scope,binding.sourceRef.path,binding.sourceRef.startLine,binding.sourceRef.endLine]);
 return bindings.sort((a,b)=>key(a).localeCompare(key(b),'en'));
}

export function planHarness(profile:ProjectProfile,options:SetupOptions,guidance:GuidanceBinding[]):{summary:HarnessSummary;drafts:ConventionDraft[]}{
 const selected=selectedScopes(options);
 const files=profile.researchFiles??profile.files;
 const consumers=conventionConsumers(options);
 const incomplete=profile.truncated||!!profile.ignoreFingerprint||
  profile.unknowns.some(note=>/unreadable|denied by policy|symlink skipped/.test(note));
 const authority=sourceGuidance(profile,options,guidance);
 const conventionPaths=new Set(profile.conventionPaths);
 const bindings=guidance.flatMap(binding=>{
  if(replacedSourceAssessment(binding,authority,conventionPaths))return [];
  const scope=[...new Set(verifiedScopes(binding.scope,files))].filter(path=>scopesOverlap(selected,[path]));
  if(!scope.length)return [];
  const coverageStatus=binding.coverageStatus==='missing'&&(incomplete||scope.some(path=>!selected.some(parent=>scopeContains(parent,path))))
   ?'unavailable':binding.coverageStatus;
  return [{...binding,scope,coverageStatus}];
 });
 const drafts=new Map<string,ConventionDraft>();
 const applies=(scope:string)=>selected.some(parent=>scopeContains(parent,scope))&&verifiedScopes([scope],files).length>0;
 const topicAuthority=new Set<GuidanceBinding>(authority);
 const related=(id:string,title:string,scope:string,wholeTopic=false)=>bindings.filter(binding=>
  (binding.topicId===id&&(wholeTopic||binding.topic===title||topicAuthority.has(binding))||
   binding.topicId===undefined&&binding.topic===title)&&scopesOverlap(binding.scope,[scope]));
 const covered=(binding:GuidanceBinding,scope:string)=>binding.scope.some(parent=>scopeContains(parent,scope));
 const deferred=(binding:GuidanceBinding,scope:string)=>['conflicting','needs-decision'].includes(binding.coverageStatus)||
  ['partial','reusable'].includes(binding.coverageStatus)&&!covered(binding,scope);
 const putDraft=(topicId:string,title:string,scope:string,questions:string[])=>{
  if(!questions.length||!applies(scope))return;
  if(profile.conventions?.some(page=>page.topicId===topicId&&page.status==='not-applicable'&&scopeContains(page.scope,scope)))return;
  const key=JSON.stringify([topicId,scope]),previous=drafts.get(key);
  drafts.set(key,{topicId,title,scope,questions:[...new Set([...(previous?.questions??[]),...questions])].sort()});
 };
 for(const source of authority){
  const scope=source.scope[0];
  const equivalent=related(source.topicId,source.topic,scope,true).find(binding=>binding.scope.length===1&&binding.scope[0]===scope&&
   binding.coverageStatus===source.coverageStatus&&binding.sourceRef?.digest===source.sourceRef.digest&&binding.sourceRef?.path===source.sourceRef.path);
  if(equivalent)bindings[bindings.indexOf(equivalent)]=source;
  else bindings.push(source);
 }
 for(const topic of options.projectConventions?.topics??[])for(const scope of new Set(topic.scope)){
  if(!scopesOverlap(selected,[scope])||profile.conventions?.some(page=>page.topicId===topic.id&&page.status==='not-applicable'&&scopeContains(page.scope,scope)))continue;
  const sources=related(topic.id,topic.title,scope,true);
  const question='Confirm whether this scope already has guidance for '+topic.title+' and record the decisions still needed.';
  const sufficient=sources.some(binding=>binding.coverageStatus==='reusable'&&covered(binding,scope));
  const unknownSource=topic.source&&!sources.some(binding=>binding.sourceRef?.path===topic.source||binding.scope.includes(scope)&&binding.coverageStatus==='unavailable');
  if(unknownSource||!sources.some(binding=>covered(binding,scope))){
   bindings.push({topicId:topic.id,topic:topic.title,scope:[scope],consumers,coverageStatus:'unavailable',gaps:[question]});
  }
  if(consumers.length&&!sufficient&&!sources.some(binding=>deferred(binding,scope))){
   const knownGaps=sources.filter(binding=>['partial','missing'].includes(binding.coverageStatus)&&covered(binding,scope));
   putDraft(topic.id,topic.title,scope,knownGaps.length?knownGaps.flatMap(binding=>binding.gaps):[question]);
  }
 }
 for(const binding of bindings){
  if(!binding.topicId||!binding.consumers.some(consumer=>consumers.includes(consumer))||!['partial','missing'].includes(binding.coverageStatus))continue;
  let id:string;
  try{id=validateTopicId(binding.topicId);}catch{continue;}
  for(const scope of binding.scope){
   const sources=related(id,binding.topic,scope);
   if(sources.some(source=>deferred(source,scope)||source.coverageStatus==='reusable'&&covered(source,scope)))continue;
   putDraft(id,binding.topic,scope,binding.gaps);
  }
 }
 return {summary:{guidance:bindings,checks:projectChecks(profile),ci:profile.gitlabJobs??[]},
  drafts:[...drafts.entries()].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([,draft])=>draft)};
}
