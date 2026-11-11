import {lstat,readFile} from 'node:fs/promises';
import {posix} from 'node:path';
import type {ProjectProfile} from '../analyzer/repository.js';
import {scopeContains,scopesOverlap,validateTopicId,type ManagedAsset,type SetupOptions} from '../types.js';
import {agents} from '../integrations/agents/index.js';
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
export const TEMPLATE_VERSION='8';
const inline=(value:string)=>value.replace(/[\x00-\x1f\x7f]+/g,' ').replace(/[\\`*_\[\]<>]/g,'\\$&');
const link=(from:string,to:string,label=to)=>`[${inline(label)}](${posix.relative(posix.dirname(from),to).split('/').map(part=>encodeURIComponent(part).replaceAll('(','%28').replaceAll(')','%29')).join('/')})`;
function codeSpan(value:string):string {
 const text=value.replace(/[\x00-\x1f\x7f]/g,char=>JSON.stringify(char).slice(1,-1));
 let fence='`';
 while(text.includes(fence))fence+='`';
 return /^[ `]|[ `]$/.test(text)&&text.trim()?`${fence} ${text} ${fence}`:`${fence}${text}${fence}`;
}
export function readWorkflowTemplates(){
 return Promise.all(['change-prepare','change-deliver'].map(async name=>{
  const base=new URL('../../templates/skills/'+name+'/',import.meta.url);
  const [skill,reference]=await Promise.all(['SKILL.md','references/project.md'].map(path=>readFile(new URL(path,base),'utf8')));
  return {name,skill,reference};
 }));
}
export async function renderFixed(profile:ProjectProfile,options:SetupOptions,integration:IntegrationPreparation,semantic:PreparedAsset[],guidance:GuidanceBinding[],templates?:Awaited<ReturnType<typeof readWorkflowTemplates>>,projectRulesPending=false):Promise<PreparedAsset[]>{
 const result=[...integration.assets,...semantic];
 const hasWorkflow=!!options.sdd||options.customSkills?.some(s=>s.position==='prepare'||s.position==='deliver');
 if(!hasWorkflow&&!options.projectRules)return result;
 templates=hasWorkflow?(templates??await readWorkflowTemplates()):[];
 const refs=[...new Set([...integration.assets.filter(a=>a.consumer==='change-deliver:review').map(a=>a.target),...semantic.filter(a=>!isProjectRulesId(a.logicalId)).map(a=>a.target)])];
 const reused=new Map<string,string[]>();
 const declared=declaredAuthority(profile,options,guidance).filter(binding=>['reusable','partial'].includes(binding.coverageStatus));
 for(const binding of [...guidance.filter(isOriginalGuidance),...declared]){
  const path=binding.sourceRef.path;
  if(profile.conventionPaths?.includes(path))continue;
  reused.set(path,[...new Set([...(reused.get(path)??[]),...verifiedScopes(binding.scope,profile.files)])]);
 }
 const checks=projectChecks(profile);
 const hookSources=profile.files.filter(path=>/(?:^|\/)(?:\.husky\/(?:pre-commit|pre-push)|\.pre-commit-config\.ya?ml|\.?lefthook\.ya?ml|\.?lintstagedrc(?:\.[a-z]+)?|lint-staged\.config\.[a-z]+)$/.test(path));
 const rules=semantic.find(isProjectRulesIndex);
 const add=(logicalId:string,target:string,content:string,ownership:PreparedAsset['ownership']={kind:'file'})=>result.push({logicalId,target,content,ownership,source:{kind:'fixed-template',ref:TEMPLATE_VERSION,digest:digest(content)}});
 const entryTargets=new Set<string>();
 for(const agent of options.agents) {
  const host=agents[agent];entryTargets.add(host.entry);
  for(const {name,skill,reference} of templates) {
   const target=host.skillDirectory+'/'+name+'/SKILL.md';
   add(agent+':'+name,target,skill);
   const refTarget=host.skillDirectory+'/'+name+'/references/project.md';
   const binding=integration.bindings.find(b=>b.id===options.sdd&&b.agent===agent);
   const customerBindings=integration.skillBindings?.filter(b=>b.agent===agent&&b.consumer===name)??[];
   const customerRefs=customerBindings.flatMap(b=>b.target?[b.target]:[]);
   const lines=[reference.trimEnd(),'','## Installed workflow','',...(binding ? ['Native prepare: '+binding.prepare.join(', '),...(binding.revise?['Native revise: '+binding.revise]:[]),'Native deliver: '+binding.deliver.join(', '),'Native document routes: '+binding.artifacts.join(', '),...binding.gates] : options.sdd?['Native workflow prerequisites pending. Stop at the missing entry.']:['Use the explicitly selected customer workflow and preserve its approvals.']),...customerRefs.map(p=>'- '+link(refTarget,p,'Customer workflow'))];
   if(binding?.projectSources?.length)lines.push(...binding.projectSources.map(path=>'- '+link(refTarget,path)));
   for(const b of customerBindings)if(b.nativeName)lines.push('- Invoke existing native customer skill: '+inline(b.nativeName)+'. Preserve its gates.');
   if(projectRulesPending)lines.push('','Project rules are pending. For the touched paths, read applicable AGENTS.md or CLAUDE.md files and repository contribution guidance. Use the checks below.',...(options.projectRules?['Use the Rigup MCP research tools to prepare a rules preview. Ask the user to apply the preview from an independent terminal after ending affected sessions.']:[]));
   if(rules||refs.length||reused.size){
    lines.push('','## Project guidance','');
    if(rules)lines.push('- Before planning or editing, use the scopes in the '+link(refTarget,rules.target,'project development rules index')+' to open the topics and original guidance that apply to the changed paths.');
    lines.push(...refs.map(p=>'- '+link(refTarget,p)));
    for(const [path,scope] of reused){
     if(path===refTarget)continue;
     lines.push('- '+link(refTarget,path)+(scope.length?' · '+inline(scope.join(', ')):''));
    }
   }
   if(checks.length||hookSources.length){
    lines.push('','## Existing checks','','Working directories are relative to the repository root.');
    for(const {command,source,tools,postgres} of checks){
     const run=codeSpan([command.executable,...command.args].join(' '));
     const prerequisite=postgres?' · dedicated PostgreSQL test database':tools?.includes('playwright')?' · Playwright environment':'';
     lines.push('- '+run+' from '+codeSpan(command.cwd)+' · '+link(refTarget,source)+prerequisite);
     if(name==='change-prepare')continue;
     if(tools?.includes('yarn'))lines.push('  - Put the project’s Yarn version on PATH and verify it with '+codeSpan('yarn --version')+'.');
     if(tools?.includes('playwright'))lines.push('  - Install missing Playwright browsers in this package with '+codeSpan('npm exec --yes=false -- playwright install')+'. Check the Playwright configuration for local URLs and ports.');
     if(tools?.includes('pm2'))lines.push('  - Use a private temporary '+codeSpan('PM2_HOME')+' for this run. After the check, stop that instance with '+codeSpan('npm exec --offline --yes=false -- pm2 kill')+' from the same directory and environment.');
     if(postgres?.guard){
      lines.push('  - Load the project test environment in the authorized terminal. Verify the reachable, dedicated PostgreSQL test database in '+link(refTarget,postgres.config)+'.');
      lines.push('  - '+link(refTarget,postgres.guard)+' requires that the database name contain '+codeSpan('test')+'. Confirm it before migrations or tests.');
      if(postgres.migration)lines.push('  - Run '+codeSpan('npm run '+postgres.migration)+' in '+codeSpan(command.cwd)+' against the confirmed test database, then run the listed test in its working directory.');
      if(postgres.runInBand)lines.push('  - Run suites and separate checks sharing this database one at a time.');
     }else if(postgres)lines.push('  - Verify the project’s test setup and its database guard before running the test or any migrations. Use a dedicated PostgreSQL test database in the authorized terminal.');
    }
    if(hookSources.length)lines.push('','Check triggers',...hookSources.map(path=>'- '+link(refTarget,path)));
   }
   if(options.projectConventions?.tracker)lines.push('','Tracker convention '+inline(JSON.stringify(options.projectConventions.tracker)));
   if(options.projectConventions?.documentRoutes)lines.push('','Document destinations '+inline(JSON.stringify(options.projectConventions.documentRoutes)));
   add(agent+':'+name+':context',refTarget,lines.join('\n')+'\n');
  }
 }
 for(const target of entryTargets) {
  const marker={kind:'block' as const,start:'<!-- rigup:start -->',end:'<!-- rigup:end -->'};
  const skills=options.agents.filter(a=>agents[a].entry===target).flatMap(a=>templates.map(({name})=>agents[a].skillDirectory+'/'+name+'/SKILL.md'));
  const sources=[...reused.keys()].filter(path=>path!==target);
  const pending=projectRulesPending&&options.projectRules?['Project rules are pending. Use the Rigup MCP research tools when asked to prepare a rules preview.']:[];
  add('entry:'+target,target,[marker.start,hasWorkflow?'## Project workflow':'## Project guidance',...pending,...skills.map(p=>'- '+link(target,p)),...(rules?['- '+link(target,rules.target,'Project development rules')]:[]),...refs.map(p=>'- '+link(target,p)),...sources.map(path=>{
   const scope=reused.get(path)!;
   return '- '+link(target,path)+(scope.length&&!scope.includes('.')?' · '+inline(scope.join(', ')):'');
  }),marker.end].join('\n')+'\n',marker);
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
const navConsumer=(id:string)=>id.startsWith('entry:')||/:change-(?:prepare|deliver):context$/.test(id);
const navHeading='## Team conventions';
const navInstruction='Open the confirmed conventions that apply to the touched paths. Check each page’s status and scope before using it.';
const navRow=/ <!-- rigup:convention ([a-zA-Z0-9_-]+) -->$/;
const referencePath=(from:string,raw:string)=>{
 if(!raw||/^(?:\/|https?:|mailto:)/.test(raw))return;
 try{return posix.normalize(posix.join(posix.dirname(from),decodeURIComponent(raw.split('#')[0])));}
 catch{return undefined;}
};
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

export async function reconcileHarnessNavigation(profile:ProjectProfile,options:SetupOptions,assets:PreparedAsset[],previous:ManagedAsset[],guidance:GuidanceBinding[],preserveContext=false):Promise<HarnessNavigation>{
 const inherited=new Map<string,string>(),targets:string[]=[],warnings:string[]=[],retainIds=new Set<string>();
 const knownPaths=new Set(profile.conventionPaths);
 const pages=new Map(profile.conventions?.map(page=>[page.path,page]));
 const confirmed=guidance.filter(binding=>['reusable','partial'].includes(binding.coverageStatus)&&binding.sourceRef&&binding.consumers.length&&pages.get(binding.sourceRef.path)?.status==='confirmed');
 const applicable=options.scope?.length?options.scope:['.'];
 const visible=new Set(profile.researchFiles??profile.files);
 const conflicted=new Set(guidance.flatMap(binding=>binding.coverageStatus==='conflicting'&&binding.sourceRef?[binding.sourceRef.path]:[]));
 const migratable=new Set([...knownPaths].filter(path=>applicable.includes('.')||pages.has(path)||profile.extraSourcePaths?.includes(path)));
 const ignored=await loadResearchIgnore(profile.root);
 const candidates=new Map(assets.map(asset=>[asset.logicalId,asset]));
 const pending=(target:string,reason:string)=>warnings.push(target+': '+reason+'; review project rules.');
 const confirmedRows=(target:string)=>confirmed.flatMap(binding=>{
  const page=pages.get(binding.sourceRef!.path)!;
  if(page.path===target||!applicable.some(scope=>scopeContains(scope,page.scope)))return [];
  const identity={topicId:page.topicId,scope:page.scope,path:page.path};
  const token=Buffer.from(JSON.stringify([identity.topicId,identity.scope,identity.path])).toString('base64url');
  return [{...identity,line:'- '+link(target,page.path,page.title)+' · '+inline(page.scope)+' <!-- rigup:convention '+token+' -->'}];
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
  const preserve=!!old&&preserveContext;
  const relevant=knownPaths.size>0||confirmed.length>0||baseline?.includes(harnessBlock.start)||preserve;
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
   if(consumer){
    const rows=new Map(confirmedRows(asset.target).map(row=>[rowKey(row),row]));
    for(const row of previousRows){
     const key=rowKey(row);
     if(rows.has(key))continue;
     const affected=scopesOverlap(applicable,[row.scope]);
     const current=pages.get(row.path);
     const revoked=visible.has(row.path)&&(!current||current.status!=='confirmed'||current.topicId!==row.topicId||current.scope!==row.scope||conflicted.has(row.path));
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
