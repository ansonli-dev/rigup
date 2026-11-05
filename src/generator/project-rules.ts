import {posix} from 'node:path';
import type {Evidence} from '../types.js';
import {digest} from '../analyzer/evidence.js';
import {relativeTarget,type ArtifactJob,type ProjectRuleSource} from './artifacts.js';
import type {GuidanceBinding} from './render.js';

export const PROJECT_RULES_ID='project-development-rules';
export const isProjectRulesId=(id:string)=>id===PROJECT_RULES_ID||id.startsWith(PROJECT_RULES_ID+':');

interface RuleObservation {
 topic?:string;
 statement:string;
 classification:string;
 guidanceDisposition?:string;
 scope:unknown[];
 supportingEvidence:Evidence[];
 counterEvidence:Evidence[];
 exceptions?:unknown[];
}

const within=(path:string,scope:string)=>scope==='.'||path===scope||path.startsWith(scope+'/');
const configuration=(path:string)=>/^(?:Makefile|Dockerfile|\.dependency-cruiser\.js)$|\.(?:config\.[^.]+|jsonc?|ya?ml|toml|ini|xml)$/i.test(posix.basename(path));
const singleLine=(value:unknown)=>typeof value==='string'?value.replace(/[\x00-\x20\x7f]+/g,' ').trim():'';

export function prepareProjectRules(data:Record<string,unknown>,files:string[],target:string):{job?:ArtifactJob;guidance:GuidanceBinding[]} {
 const observations=data.observations as RuleObservation[];
 const guidance=[...(data.guidance??[]) as GuidanceBinding[]];
 const covered=new Set(guidance.filter(source=>source.coverageStatus==='reusable').map(source=>singleLine(source.topic)));
 const unresolved=new Set([
  ...guidance.filter(source=>source.coverageStatus==='conflicting'||source.coverageStatus==='unavailable').map(source=>singleLine(source.topic)),
  ...observations.filter(item=>item.guidanceDisposition==='needs-decision').map(item=>singleLine(item.topic)),
 ]);
 const ruleSources:ProjectRuleSource[]=[];
 for(const observation of observations){
  const {classification,scope,supportingEvidence,counterEvidence}=observation;
  const topic=singleLine(observation.topic);
  if(!topic||topic.length>1000)continue;
  const scopes=scope.map(path=>typeof path==='string'?path.replace(/\/+$/,''):'')
   .filter(path=>path==='.'||relativeTarget(path)&&files.some(file=>within(file,path)));
  const bind=(status:string,refs:Evidence[])=>{
   for(const ref of refs){
    if(!guidance.some(binding=>binding.topic===topic&&binding.sourceRef?.path===ref.path&&binding.sourceRef.digest===ref.digest&&binding.coverageStatus===status)){
     guidance.push({topic,sourceRef:ref,scope:scopes,coverageStatus:status,consumers:['prepare','deliver','review'],gaps:[]});
    }
   }
  };
  if(observation.guidanceDisposition==='needs-decision'){
   bind('needs-decision',[...supportingEvidence,...counterEvidence]);
   continue;
  }
  if((classification!=='explicit-rule'&&classification!=='convention')||!scopes.length||scopes.length!==scope.length||covered.has(topic)||unresolved.has(topic))continue;
  const exceptions=Array.isArray(observation.exceptions)?observation.exceptions.map(singleLine).filter(Boolean):[];
  if(counterEvidence.length&&!exceptions.length||exceptions.some(exception=>exception.length>1000)){
   bind('needs-decision',[...supportingEvidence,...counterEvidence]);
   continue;
  }
  const documented=classification==='explicit-rule'?supportingEvidence.filter(ref=>/\.(?:md|mdx|rst|adoc|txt)$/i.test(ref.path)):[];
  bind('reusable',documented.filter(ref=>!guidance.some(binding=>binding.topic===topic&&binding.sourceRef?.path===ref.path)));
  if(documented.length||observation.guidanceDisposition!=='follow-existing'||ruleSources.length>=8)continue;
  if(classification==='convention'){
   const supports=scopeSupportingPaths(supportingEvidence,scopes);
   if(scopes.includes('.')||supports.size<2||scopes.some(path=>![...supports].some(file=>within(file,path))))continue;
  }else if(scopes.some(scope=>!supportingEvidence.some(ref=>configuration(ref.path)?within(scope,posix.dirname(ref.path)):scope!=='.'&&within(ref.path,scope)))){
   continue;
  }
  ruleSources.push({id:'R'+(ruleSources.length+1),topic,statement:observation.statement,authority:classification,scope:scopes,supportingEvidence,counterEvidence,exceptions});
 }
 if(!ruleSources.length)return {guidance};
 const evidence=new Map<string,Evidence>();
 for(const rule of ruleSources)for(const ref of [...rule.supportingEvidence,...rule.counterEvidence])evidence.set(JSON.stringify(ref),ref);
 return {guidance,job:{
  logicalId:target==='docs/rigup/development-rules.md'?PROJECT_RULES_ID:PROJECT_RULES_ID+':'+digest(target),target,purpose:'Project development rules for future changes',consumer:'change-prepare/change-deliver',
  required:true,reason:'Apply verified project rules and scoped code conventions during planning, implementation and review',
  sourceRefs:[...evidence.values()],seedPaths:[],relatedArtifacts:[],ruleSources,status:'pending',
  acceptance:['Every rule instructs future changes and gives a concrete verification step.',
   'Each instruction preserves the selected evidence, authority, scope, counterexamples, and exceptions.',
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

function evidenceLink(target:string,ref:Evidence,label=ref.path+':'+ref.startLine+'–'+ref.endLine):string {
 const link=posix.relative(posix.dirname(target),ref.path).split('/').map(part=>encodeURIComponent(part).replaceAll('(','%28').replaceAll(')','%29')).join('/');
 return '['+escapeText(label.replace(/[\[\]]/g,''))+']('+link+'#L'+ref.startLine+'-L'+ref.endLine+')';
}

export function renderProjectRules(job:ArtifactJob,value:unknown,guidance:GuidanceBinding[]):string {
 const book=object(value);
 const sources=job.ruleSources??[];
 if(!Array.isArray(book.rules)||book.rules.length!==sources.length)throw new Error('rulebook: one instruction for each selected rule source required');
 const rules=new Map<string,Record<string,unknown>>();
 for(const value of book.rules){
  const rule=object(value),id=rule.sourceId;
  if(typeof id!=='string'||!sources.some(source=>source.id===id)||rules.has(id))throw new Error('rulebook: invalid or duplicate rule source');
  rules.set(id,rule);
 }
 const originalDocs=new Map(guidance.flatMap(binding=>binding.sourceRef&&(binding.coverageStatus==='reusable'||binding.coverageStatus==='partial')?[[binding.sourceRef.path,binding.sourceRef] as const]:[]));
 const sentence=(value:unknown)=>text(value).replace(/\[([^\]]+)\]\(([^)]+)\)|[\\`*_\[\]<>]/g,(match,label?:string,destination?:string)=>{
  if(destination){
   const path=destination.split('#')[0],ref=originalDocs.get(path)??originalDocs.get(posix.normalize(posix.join(posix.dirname(job.target),path)));
   if(ref)return evidenceLink(job.target,ref,label);
  }
  return escapeText(match);
 });
 const plain=(value:unknown)=>escapeText(text(value));
 const lines=['# '+plain(book.title),''];
 const when=plain(book.when),verify=plain(book.verify),exceptions=plain(book.exceptions);
 for(const [authority,heading] of [['explicit-rule',book.existing],['convention',book.inferred]] as const){
  const group=sources.filter(source=>source.authority===authority);
  if(!group.length)continue;
  lines.push('## '+plain(heading),'');
  for(const source of group){
   const rule=rules.get(source.id)!;
   const paths=source.scope.map(plain).join(', ');
   lines.push('### '+plain(source.topic),'',paths,'',
    '- **'+when+'** '+sentence(rule.trigger),'- '+sentence(rule.instruction),'- **'+verify+'** '+sentence(rule.verification));
   for(const exception of source.exceptions)lines.push('- **'+exceptions+'** '+plain(exception));
   lines.push('',[...source.supportingEvidence,...source.counterEvidence].map(ref=>evidenceLink(job.target,ref)).join(' · '),'');
  }
 }
 return lines.join('\n');
}
