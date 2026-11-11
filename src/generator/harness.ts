import type {ProjectProfile} from '../analyzer/repository.js';
import {projectChecks} from '../integrations/tools/check-catalog.js';
import {scopeContains,scopesOverlap,validateTopicId,type ConventionDraft,type Evidence,type HarnessSummary,type SetupOptions} from '../types.js';
import {verifiedScopes,type GuidanceBinding} from './project-rules.js';

const selectedScopes=(options:SetupOptions)=>options.scope?.length?options.scope:['.'];
function conventionConsumers(options:SetupOptions):string[]{
 const workflow=options.sdd||options.customSkills?.some(skill=>skill.position==='prepare'||skill.position==='deliver');
 return options.agents.length&&(options.projectRules||workflow)?['agent-entry',...(workflow?['prepare','deliver','review']:[])]:[];
}

export function declaredAuthority(profile:ProjectProfile,options:SetupOptions,assessed:GuidanceBinding[]=[]):(GuidanceBinding&{topicId:string;sourceRef:Evidence})[]{
 return (options.projectConventions?.topics??[]).flatMap(topic=>{
  const sourceRef=topic.source&&profile.declaredSources?.[topic.source];
  if(!sourceRef)return [];
  return [...new Set(verifiedScopes(topic.scope,profile.researchFiles??profile.files))]
   .filter(scope=>scopesOverlap(selectedScopes(options),[scope]))
   .map(scope=>{
    const assessments=assessed.filter(binding=>binding.sourceRef?.path===sourceRef.path&&
     (binding.topicId===topic.id||binding.topicId===undefined&&binding.topic===topic.title)&&binding.scope.some(parent=>scopeContains(parent,scope)));
    const decision=['conflicting','unavailable','partial'].find(status=>assessments.some(binding=>binding.coverageStatus===status));
    return {topicId:topic.id,topic:topic.title,scope:[scope],sourceRef,coverageStatus:decision??'reusable',consumers:conventionConsumers(options),
     gaps:[...new Set(assessments.filter(binding=>binding.coverageStatus===decision).flatMap(binding=>binding.gaps))]};
   });
 });
}

export function sourceGuidance(profile:ProjectProfile,options:SetupOptions,assessed:GuidanceBinding[]=[]):(GuidanceBinding&{topicId:string;sourceRef:Evidence})[]{
 const files=profile.researchFiles??profile.files;
 const confirmed=(profile.conventions??[]).filter(page=>page.status==='confirmed'&&page.sourceRef&&verifiedScopes([page.scope],files).length);
 const bindings=[...declaredAuthority(profile,options,assessed),...confirmed.flatMap(page=>{
  const source={topicId:page.topicId,topic:page.title,scope:[page.scope],sourceRef:page.sourceRef!,consumers:conventionConsumers(options)};
  const conflicting=confirmed.some(other=>other.topicId===page.topicId&&other.bodyDigest!==page.bodyDigest&&scopesOverlap([page.scope],[other.scope]));
  if(conflicting)return [{...source,coverageStatus:'conflicting',gaps:['Resolve the differing confirmed sources for their overlapping scope.']}];
  const decisions=['conflicting','unavailable','partial','reusable'];
  const assessments=assessed.flatMap(binding=>{
   const sameTopic=binding.topicId===page.topicId||binding.topicId===undefined&&binding.topic===page.title;
   if(binding.sourceRef?.path!==page.path||!sameTopic||!decisions.includes(binding.coverageStatus))return [];
   const scope=verifiedScopes(binding.scope,files).filter(path=>scopeContains(page.scope,path)&&scopesOverlap(selectedScopes(options),[path]));
   return scope.length?[{...binding,scope}]:[];
  });
  if(!assessments.length)return [{...source,coverageStatus:'reusable',gaps:[]}];
  return [...new Set(assessments.flatMap(binding=>binding.scope))].flatMap(scope=>{
   const applicable=assessments.filter(binding=>binding.scope.some(parent=>scopeContains(parent,scope)));
   const coverageStatus=decisions.find(status=>applicable.some(binding=>binding.coverageStatus===status))!;
   if(coverageStatus==='reusable'&&assessments.some(binding=>binding.coverageStatus!=='reusable'&&binding.scope.some(child=>scopeContains(scope,child))))return [];
   return [{...source,scope:[scope],coverageStatus,gaps:[...new Set(applicable.filter(binding=>binding.coverageStatus===coverageStatus).flatMap(binding=>binding.gaps))]}];
  });
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
 const bindings=guidance.flatMap(binding=>{
  if(binding.sourceRef&&profile.conventionPaths?.includes(binding.sourceRef.path)&&['reusable','partial'].includes(binding.coverageStatus))return [];
  const scope=[...new Set(verifiedScopes(binding.scope,files))].filter(path=>scopesOverlap(selected,[path]));
  if(!scope.length)return [];
  const coverageStatus=binding.coverageStatus==='missing'&&(incomplete||scope.some(path=>!selected.some(parent=>scopeContains(parent,path))))
   ?'unavailable':binding.coverageStatus;
  return [{...binding,scope,coverageStatus}];
 });
 const drafts=new Map<string,ConventionDraft>();
 const applies=(scope:string)=>selected.some(parent=>scopeContains(parent,scope))&&verifiedScopes([scope],files).length>0;
 const authority=sourceGuidance(profile,options,guidance);
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
