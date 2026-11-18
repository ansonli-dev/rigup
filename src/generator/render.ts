import {lstat,readFile} from 'node:fs/promises';
import {posix} from 'node:path';
import type {ProjectProfile} from '../analyzer/repository.js';
import {scopeContains,scopesOverlap,validateTopicId,type ManagedAsset,type SetupOptions} from '../types.js';
import {agents,entryOwnership} from '../integrations/agents/index.js';
import type {PreparedAsset,IntegrationPreparation} from '../integrations/registry.js';
import {digest} from '../analyzer/evidence.js';
import {isOriginalGuidance,isProjectRulesId,isProjectRulesIndex,verifiedScopes,type GuidanceBinding} from './project-rules.js';
import {markdownLinks} from './document-policy.js';
import {projectChecks} from '../integrations/tools/check-catalog.js';
import {declaredAuthority} from './harness.js';
import {loadResearchIgnore} from '../analyzer/research-ignore.js';
import {trustedBaseline} from '../installer/baseline.js';
import {ownedContent,replaceOwned,targetPath} from '../installer/ownership.js';
import {isConventionScope} from '../project-conventions.js';
import {artifactLocale,translate,type MessageKey,type MessageParams} from '../i18n/index.js';
import {workflowSkills} from '../integrations/workflow-skills.js';
export const TEMPLATE_VERSION='9';
const projectGuidanceHeading='## Project guidance';
const inline=(value:string)=>value.replace(/[\x00-\x1f\x7f]+/g,' ').replace(/[\\`*_\[\]<>]/g,'\\$&');
const link=(from:string,to:string,label=to)=>`[${inline(label)}](${posix.relative(posix.dirname(from),to).split('/').map(part=>encodeURIComponent(part).replaceAll('(','%28').replaceAll(')','%29')).join('/')})`;
function codeSpan(value:string):string {
 const text=value.replace(/[\x00-\x1f\x7f]/g,char=>JSON.stringify(char).slice(1,-1));
 let fence='`';
 while(text.includes(fence))fence+='`';
 return /^[ `]|[ `]$/.test(text)&&text.trim()?`${fence} ${text} ${fence}`:`${fence}${text}${fence}`;
}
export function readWorkflowTemplates(options:Pick<SetupOptions,'documentLanguage'>){
 const suffix=artifactLocale(options.documentLanguage)==='zh-CN'?'.zh-CN.md':'.md';
 return Promise.all(workflowSkills.map(async name=>{
  const base=new URL('../../templates/skills/'+name+'/',import.meta.url);
  const read=(path:string)=>readFile(new URL(path+suffix,base),'utf8');
  const [skill,reference,goal]=await Promise.all([read('SKILL'),read('references/project'),
   name==='change-prepare'?read('references/GOAL'):undefined]);
  return {name,skill,reference,goal};
 }));
}
const chineseGates=new Map([
 ['Retain design approval and all native skill gates','保留设计批准及原生技能的全部前置要求。'],
 ['Execute the approved native plan with native testing and review requirements','执行已批准的原生计划，遵循原生测试与审阅要求。'],
 ['Retain design approval before planning and explicit approval before implementation','规划前保留设计批准要求，实施前保留明确批准要求。'],
 ['Follow the community native testing, review and verification requirements','遵循社区版原生测试、审阅和验证要求。'],
 ['Retain native artifact dependency checks and archive decisions','保留原生产出物依赖检查以及归档决定。'],
 ['Use existing project checks before marking implementation complete','标记实施完成前，运行现有的项目检查。'],
 ['Retain constitution checks, clarification and native prerequisite validation','保留 constitution 检查、澄清流程及原生前置条件验证。'],
 ['Retain registered mandatory pre/post execution hooks','保留已注册且必须运行的前置和后置执行钩子。'],
 ['Review each native result before continuing when required upstream','上游有要求时，继续前先审阅每一步的原生结果。'],
]);
export async function renderFixed(profile:ProjectProfile,options:SetupOptions,integration:IntegrationPreparation,semantic:PreparedAsset[],guidance:GuidanceBinding[],templates?:Awaited<ReturnType<typeof readWorkflowTemplates>>,projectRulesPending=false,context:Pick<PreparedAsset,'logicalId'|'target'>[]=semantic):Promise<PreparedAsset[]>{
 const result=[...integration.assets,...semantic];
 const hasWorkflow=!!options.sdd||options.customSkills?.some(s=>s.position==='prepare'||s.position==='deliver');
 if(!hasWorkflow&&!options.projectRules)return result;
 templates=hasWorkflow?(templates??await readWorkflowTemplates(options)):[];
 const locale=artifactLocale(options.documentLanguage);
 const text=(key:MessageKey,params?:MessageParams)=>translate(locale,key,params);
 const refs=[...new Set([
  ...integration.assets.filter(a=>a.consumer==='change-deliver:review').map(a=>a.target),
  ...context.filter(a=>!isProjectRulesId(a.logicalId)).map(a=>a.target),
 ])];
 const reused=new Map<string,string[]>();
 const declared=declaredAuthority(profile,options,guidance).filter(binding=>['reusable','partial'].includes(binding.coverageStatus));
 for(const binding of [...guidance.filter(isOriginalGuidance),...declared]){
  const path=binding.sourceRef.path;
  if(profile.conventionPaths?.includes(path))continue;
  reused.set(path,[...new Set([...(reused.get(path)??[]),...verifiedScopes(binding.scope,profile.files)])]);
 }
 const checks=projectChecks(profile);
 const hookSources=profile.files.filter(path=>/(?:^|\/)(?:\.husky\/(?:pre-commit|pre-push)|\.pre-commit-config\.ya?ml|\.?lefthook\.ya?ml|\.?lintstagedrc(?:\.[a-z]+)?|lint-staged\.config\.[a-z]+)$/.test(path));
 const rules=context.find(isProjectRulesIndex);
 const templateRef=locale==='zh-CN'?TEMPLATE_VERSION+'-zh-CN':TEMPLATE_VERSION;
 const add=(logicalId:string,target:string,content:string,ownership:PreparedAsset['ownership']={kind:'file'})=>result.push({logicalId,target,content,ownership,source:{kind:'fixed-template',ref:templateRef,digest:digest(content)}});
 const openSpecCommand=integration.openSpecProjectCli?text('artifact.openSpecCommand'):undefined;
 const entryTargets=new Set<string>();
 for(const agent of options.agents) {
  const host=agents[agent];entryTargets.add(host.entry);
  for(const {name,skill,reference,goal} of templates) {
   const target=host.skillDirectory+'/'+name+'/SKILL.md';
   add(agent+':'+name,target,skill);
   if(goal)add(agent+':'+name+':goal',host.skillDirectory+'/'+name+'/references/GOAL.md',goal);
   const refTarget=host.skillDirectory+'/'+name+'/references/project.md';
   const binding=integration.bindings.find(b=>b.id===options.sdd&&b.agent===agent);
   const customerBindings=integration.skillBindings?.filter(b=>b.agent===agent&&(b.consumer===name||name==='change-ready'&&['change-prepare','change-deliver'].includes(b.consumer)))??[];
   const customerRefs=customerBindings.flatMap(b=>b.target?[b.target]:[]);
   const native=binding?[
    text('artifact.nativePrepare',{entries:binding.prepare.join(', ')}),
    ...(binding.revise?[text('artifact.nativeRevise',{entry:binding.revise})]:[]),
    text('artifact.nativeDeliver',{entries:binding.deliver.join(', ')}),
    text('artifact.nativeRoutes',{paths:binding.artifacts.join(', ')}),
    ...binding.gates.map(gate=>locale==='zh-CN'?chineseGates.get(gate)??gate:gate),
   ]:[text(options.sdd?'artifact.nativePending':'artifact.customerSelected')];
   const lines=[reference.trimEnd(),'','## '+text('artifact.installedWorkflow'),'',...native,
    ...customerRefs.map(p=>'- '+link(refTarget,p,text('artifact.customerWorkflow')))];
   if(binding&&openSpecCommand)lines.push(openSpecCommand);
   if(binding?.projectSources?.length)lines.push(...binding.projectSources.map(path=>'- '+link(refTarget,path)));
   for(const b of customerBindings)if(b.nativeName)lines.push('- '+text('artifact.customerSkill',{name:inline(b.nativeName)}));
   if(projectRulesPending)lines.push('',text('artifact.rulesPending'),...(options.projectRules?[text('artifact.rulesMcp')]:[]));
   if(rules||refs.length||reused.size){
    lines.push('',projectGuidanceHeading,'');
    if(rules)lines.push('- '+text('artifact.useRuleIndex',{link:link(refTarget,rules.target,text('artifact.ruleIndex'))}));
    lines.push(...refs.map(p=>'- '+link(refTarget,p)));
    for(const [path,scope] of reused){
     if(path===refTarget)continue;
     lines.push('- '+link(refTarget,path)+(scope.length?' · '+inline(scope.join(', ')):''));
    }
   }
   if(checks.length||hookSources.length){
    lines.push('','## '+text('artifact.existingChecks'),'',text('artifact.checkCwd'));
    for(const {command,source} of checks)
     lines.push('- '+text('artifact.checkLine',{command:codeSpan([command.executable,...command.args].join(' ')),cwd:codeSpan(command.cwd),source:link(refTarget,source)}));
    if(hookSources.length)lines.push('',text('artifact.checkTriggers'),...hookSources.map(path=>'- '+link(refTarget,path)));
   }
   if(options.projectConventions?.tracker)lines.push('',text('artifact.tracker',{data:inline(JSON.stringify(options.projectConventions.tracker))}));
   if(options.projectConventions?.documentRoutes)lines.push('',text('artifact.documentRoutes',{data:inline(JSON.stringify(options.projectConventions.documentRoutes))}));
   add(agent+':'+name+':context',refTarget,lines.join('\n')+'\n');
  }
 }
 for(const target of entryTargets) {
  const skills=options.agents.filter(a=>agents[a].entry===target).flatMap(a=>templates.map(({name})=>agents[a].skillDirectory+'/'+name+'/SKILL.md'));
  const sources=[...reused.keys()].filter(path=>path!==target);
  const pending=projectRulesPending&&options.projectRules?[text('artifact.entryPending')]:[];
  add('entry:'+target,target,[entryOwnership.start,hasWorkflow?'## Project workflow':projectGuidanceHeading,...pending,...(openSpecCommand?[openSpecCommand]:[]),...skills.map(p=>'- '+link(target,p)),...(rules?['- '+link(target,rules.target,text('artifact.rulesLink'))]:[]),...refs.map(p=>'- '+link(target,p)),...sources.map(path=>{
   const scope=reused.get(path)!;
   return '- '+link(target,path)+(scope.length&&!scope.includes('.')?' · '+inline(scope.join(', ')):'');
  }),entryOwnership.end].join('\n')+'\n',entryOwnership);
 }
 return result;
}

export function validateNavigation(assets:PreparedAsset[],existing:string[],inherited:ReadonlyMap<string,string>=new Map()):void {
 const available=new Set([...existing,...assets.map(a=>a.target)]);
 for(const asset of assets.filter(a=>a.target.endsWith('.md')&&a.encoding!=='base64')) {
  for(const match of markdownLinks(asset.content)) {
   const raw=match[1].split('#')[0];if(!raw||/^(?:https?:|mailto:)/.test(raw))continue;
   const target=posix.normalize(posix.join(posix.dirname(asset.target),decodeURIComponent(raw)));
   if(raw.startsWith('/')||target.startsWith('../')||!available.has(target)&&!inherited.get(asset.logicalId)?.includes(match[0]))throw new Error('dangling or escaping navigation link: '+asset.target+' -> '+raw);
  }
 }
}

const harnessBlock={kind:'block' as const,start:'<!-- rigup:harness:start -->',end:'<!-- rigup:harness:end -->'};
const navConsumer=(id:string)=>id.startsWith('entry:')||/:change-(?:prepare|ready|deliver):context$/.test(id);
const navHeading='## Team conventions';
const navInstruction='Open the confirmed conventions that apply to the touched paths. Check each page’s status and scope before using it.';
const navRow=/ <!-- rigup:convention ([a-zA-Z0-9_-]+) -->$/;
const referencePath=(from:string,raw:string)=>{
 if(!raw||/^(?:\/|https?:|mailto:)/.test(raw))return;
 try{return posix.normalize(posix.join(posix.dirname(from),decodeURIComponent(raw.split('#')[0])));}
 catch{return undefined;}
};

function retainGuidanceLinks(asset:Pick<ManagedAsset,'target'|'ownership'>,content:string,baseline:string,excluded:ReadonlySet<string>):string{
 const {target,ownership}=asset;
 const linked=new Set([...markdownLinks(content)].map(match=>referencePath(target,match[1])));
 let original=baseline.split(/\r?\n/);
 if(ownership.kind!=='block'){
  const heading=original.indexOf(projectGuidanceHeading);
  if(heading===-1)return content;
  original=original.slice(heading+1);
  const end=original.findIndex(line=>line.startsWith('## ')||line===harnessBlock.start);
  if(end!==-1)original=original.slice(0,end);
 }
 const missing=original.filter(line=>{
  const matches=[...markdownLinks(line)];
  if(matches.length!==1||navRow.test(line))return false;
  const path=referencePath(target,matches[0][1]);
  if(!path||path==='..'||path.startsWith('../')||linked.has(path)||excluded.has(path))return false;
  const prior='- '+link(target,path);
  return line===prior||line.startsWith(prior+' · ');
 });
 if(!missing.length)return content;
 const lines=missing.join('\n')+'\n';
 if(ownership.kind==='block'){
  const end=content.lastIndexOf(ownership.end);
  return end<0?content:content.slice(0,end)+lines+content.slice(end);
 }
 const heading=content.indexOf('\n'+projectGuidanceHeading+'\n\n');
 if(heading<0)return content.trimEnd()+'\n\n'+projectGuidanceHeading+'\n\n'+lines;
 const insert=heading+projectGuidanceHeading.length+3;
 return content.slice(0,insert)+lines+content.slice(insert);
}
export function conventionLinksOutsideHarness(from:string,text:string,paths:ReadonlySet<string>):string[]{
 const outside=replaceOwned(text,harnessBlock,undefined)??'';
 return [...markdownLinks(outside)].flatMap(match=>{
  const path=referencePath(from,match[1]);
  return path&&paths.has(path)?[path]:[];
 });
}

function legacyConventionLinks(from:string,text:string,paths:ReadonlySet<string>,migratable:ReadonlySet<string>):{content:string;changed:boolean;ambiguous:boolean}{
 let changed=false,ambiguous=false;
 const content=text.split(/(?<=\n)/).filter(line=>{
  const matches=[...markdownLinks(line)].filter(match=>{
   const path=referencePath(from,match[1]);
   return path&&paths.has(path);
  });
  if(!matches.length||navRow.test(line.trimEnd()))return true;
  const match=matches[0],path=referencePath(from,match[1])!;
  const withoutEnding=line.replace(/\r?\n$/,'');
  const expected=link(from,path);
  const suffix=withoutEnding.trimStart().slice(2+match[0].length);
  if(migratable.has(path)&&matches.length===1&&match[0]===expected&&/^ {0,2}- /.test(withoutEnding)&&
    withoutEnding.trimStart().startsWith('- '+match[0])&&(!suffix||suffix.startsWith(' · ')&&!/[\[\]<>]/.test(suffix))){
   changed=true;
   return false;
  }
  ambiguous=true;
  return true;
 }).join('');
 return {content,changed,ambiguous};
}

interface HarnessRow {topicId:string;scope:string;path:string;line:string}
const rowKey=(row:HarnessRow)=>JSON.stringify([row.topicId,row.scope,row.path]);
function readHarnessRows(target:string,block:string|undefined):HarnessRow[]{
 if(!block)return [];
 const rows:HarnessRow[]=[];
 for(const line of block.split(/\r?\n/)){
  if(!line||[harnessBlock.start,harnessBlock.end,navHeading,navInstruction].includes(line))continue;
  const token=navRow.exec(line)?.[1];
  if(!token)throw Error('Unrecognized convention navigation entry');
  const value:unknown=JSON.parse(Buffer.from(token,'base64url').toString('utf8'));
  if(!Array.isArray(value)||value.length!==3||!isConventionScope(value[1])||typeof value[2]!=='string')throw Error('Invalid convention navigation identity');
  const [id,scope,path]=value;
  const found=[...markdownLinks(line)];
  if(found.length!==1||referencePath(target,found[0][1])!==path)throw Error('Convention navigation path changed');
  rows.push({topicId:validateTopicId(id),scope,path,line});
 }
 if(new Set(rows.map(rowKey)).size!==rows.length)throw Error('Duplicate convention navigation identity');
 return rows;
}

export function conventionNavigationMatches(target:string,actual:string,expected:string):boolean{
 const rows=(text:string)=>readHarnessRows(target,ownedContent(text,harnessBlock)).map(row=>row.line).sort();
 return JSON.stringify(rows(actual))===JSON.stringify(rows(expected));
}

export interface HarnessNavigation {
 assets:PreparedAsset[];
 inherited:Map<string,string>;
 targets:string[];
 conventionPaths:string[];
 retainIds:Set<string>;
 warnings:string[];
 pending:boolean;
}

export async function reconcileHarnessNavigation(profile:ProjectProfile,options:SetupOptions,assets:PreparedAsset[],previous:ManagedAsset[],guidance:GuidanceBinding[],contextUpdate?:'retain'|'translate'):Promise<HarnessNavigation>{
 const inherited=new Map<string,string>(),targets:string[]=[],warnings:string[]=[],retainIds=new Set<string>();
 const knownPaths=new Set(profile.conventionPaths);
 const excludedGuidance=new Set([...knownPaths,...previous.map(asset=>asset.target)]);
 const pages=new Map(profile.conventions?.map(page=>[page.path,page]));
 const confirmed=guidance.filter(binding=>['reusable','partial'].includes(binding.coverageStatus)&&binding.sourceRef&&binding.consumers.length&&pages.get(binding.sourceRef.path)?.status==='confirmed');
 const applicable=options.scope?.length?options.scope:['.'];
 const visible=new Set(profile.researchFiles??profile.files);
 const conflicts=guidance.filter(binding=>binding.coverageStatus==='conflicting'&&binding.sourceRef);
 const conflictingScope=(path:string,scope:string)=>conflicts.some(binding=>binding.sourceRef?.path===path&&scopesOverlap(binding.scope,[scope]));
 const migratable=new Set([...knownPaths].filter(path=>applicable.includes('.')||pages.has(path)||profile.extraSourcePaths?.includes(path)));
 const ignored=await loadResearchIgnore(profile.root);
 const candidates=new Map(assets.map(asset=>[asset.logicalId,asset]));
 const pending=(target:string,reason:string)=>warnings.push(target+': '+reason+'; review project rules.');
 const confirmedRows=(target:string)=>confirmed.flatMap(binding=>{
  const page=pages.get(binding.sourceRef!.path)!;
  if(page.path===target)return [];
  return binding.scope.flatMap(scope=>{
   if(!isConventionScope(scope)||!scopeContains(page.scope,scope)||!applicable.some(parent=>scopeContains(parent,scope))||conflictingScope(page.path,scope))return [];
   const identity={topicId:page.topicId,scope,path:page.path};
   const token=Buffer.from(JSON.stringify([identity.topicId,identity.scope,identity.path])).toString('base64url');
   return [{...identity,line:'- '+link(target,page.path,page.title)+' · '+inline(scope)+' <!-- rigup:convention '+token+' -->'}];
  });
 });
 const absent=async(path:string)=>{
  try{await lstat(await targetPath(profile.root,path));return false;}
  catch(error){return (error as NodeJS.ErrnoException).code==='ENOENT';}
 };
 const priorById=new Map(previous.map(asset=>[asset.logicalId,asset]));
 const ids=new Set([...candidates.keys(),...previous.filter(asset=>navConsumer(asset.logicalId)||isProjectRulesIndex(asset)).map(asset=>asset.logicalId)]);
 for(const id of ids){
  const candidate=candidates.get(id),old=priorById.get(id),asset=candidate??old;
  if(!asset||!(navConsumer(id)||isProjectRulesIndex(asset)))continue;
  const consumer=navConsumer(id);
  const baseline=old?.baseline?await trustedBaseline(profile.root,old).catch(()=>undefined):undefined;
  if(baseline!==undefined)inherited.set(id,baseline);
  const preserve=!!old&&contextUpdate==='retain';
  const translateContext=!!old&&consumer&&contextUpdate==='translate';
  const relevant=knownPaths.size>0||confirmed.length>0||baseline?.includes(harnessBlock.start)||preserve||translateContext;
  if(!relevant)continue;
  if(old&&baseline===undefined){
   pending(asset.target,'Trusted navigation baseline is unavailable');
   candidates.delete(id);
   retainIds.add(id);
   continue;
  }
  if(consumer&&!candidate&&!preserve)continue;
  let content=(preserve?baseline:candidate?.content)??baseline;
  if(content===undefined)continue;
  try{
   const oldBlock=baseline===undefined?undefined:ownedContent(baseline,harnessBlock);
   const previousRows=consumer?readHarnessRows(asset.target,oldBlock):[];
   const oldLegacy=baseline===undefined?undefined:legacyConventionLinks(asset.target,baseline,knownPaths,migratable);
   if(oldLegacy?.ambiguous){
    pending(asset.target,'An older convention reference is embedded in other guidance');
    content=baseline!;
   }else if(!candidate&&oldLegacy?.changed)content=oldLegacy.content;
   else if(!candidate&&!consumer)continue;
   const legacy=legacyConventionLinks(asset.target,content,knownPaths,migratable);
   if(legacy.ambiguous)pending(asset.target,'A convention reference needs manual migration');
   content=legacy.content;
   if(translateContext&&baseline!==undefined&&!oldLegacy?.ambiguous)content=retainGuidanceLinks(asset,content,baseline,excludedGuidance);
   if(consumer){
    const rows=new Map(confirmedRows(asset.target).map(row=>[rowKey(row),row]));
    for(const row of previousRows){
     const key=rowKey(row);
     if(rows.has(key))continue;
     const affected=scopesOverlap(applicable,[row.scope]);
     const current=pages.get(row.path);
     const currentScopes=confirmed.filter(binding=>binding.sourceRef?.path===row.path&&binding.topicId===row.topicId).flatMap(binding=>binding.scope);
     const narrowed=!profile.truncated&&applicable.some(scope=>scopeContains(scope,row.scope))&&
      currentScopes.some(scope=>scopeContains(row.scope,scope))&&!currentScopes.some(scope=>scopeContains(scope,row.scope));
     const revoked=visible.has(row.path)&&(!current||current.status!=='confirmed'||current.topicId!==row.topicId||!scopeContains(current.scope,row.scope)||
      conflictingScope(row.path,row.scope)||narrowed);
     const canVerifyAbsence=affected&&!profile.truncated&&!ignored.excludes(row.path,false)&&
      applicable.some(scope=>scopeContains(scope,row.scope))&&
      (applicable.some(scope=>scopeContains(scope,row.path))||profile.extraSourcePaths?.includes(row.path));
     if(affected&&(revoked||canVerifyAbsence&&await absent(row.path)))continue;
     rows.set(key,row);
    }
    const selected=[...rows.values()].sort((a,b)=>rowKey(a).localeCompare(rowKey(b),'en'));
    const block=selected.length?[harnessBlock.start,navHeading,navInstruction,...selected.map(row=>row.line),harnessBlock.end,''].join('\n'):undefined;
    if(block!==undefined&&!ownedContent(content,harnessBlock)&&asset.ownership.kind==='block'){
     const offset=content.lastIndexOf(asset.ownership.end);
     if(offset<0)throw Error('Managed entry marker missing');
     content=content.slice(0,offset)+block+content.slice(offset);
    }else content=replaceOwned(content,harnessBlock,block)??'';
    if(block||oldBlock||oldLegacy?.changed)targets.push(asset.target);
   }else if(oldLegacy?.changed)targets.push(asset.target);
  }catch{
   pending(asset.target,'Existing convention navigation cannot be reconciled safely');
   if(baseline===undefined)throw Error('Invalid generated convention navigation: '+asset.target);
   content=baseline;
  }
  if(preserve&&content===baseline){candidates.delete(id);continue;}
  if(!candidate&&content===baseline)continue;
  if(!candidate&&!old?.source){pending(asset.target,'Existing navigation source metadata is unavailable');retainIds.add(id);continue;}
  const {logicalId,target,ownership,encoding,mode}=asset;
  const source=candidate?.source??old!.source!;
  candidates.set(id,{logicalId,target,ownership,encoding,mode,content,source:{...source,digest:digest(content)}});
 }
 return {assets:[...candidates.values()],inherited,targets,conventionPaths:[...knownPaths],retainIds,warnings,pending:warnings.length>0};
}
