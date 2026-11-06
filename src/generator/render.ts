import {readFile} from 'node:fs/promises';
import {posix} from 'node:path';
import type {ProjectProfile} from '../analyzer/repository.js';
import type {SetupOptions} from '../types.js';
import {agents} from '../integrations/agents/index.js';
import type {PreparedAsset,IntegrationPreparation} from '../integrations/registry.js';
import {digest} from '../analyzer/evidence.js';
import {isOriginalGuidance,isProjectRulesId,isProjectRulesIndex,verifiedScopes,type GuidanceBinding} from './project-rules.js';
import {markdownLinks} from './document-policy.js';
import {projectChecks} from '../integrations/tools/check-catalog.js';
export const TEMPLATE_VERSION='7';
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
 if(!options.sdd && !(options.customSkills?.some(s=>s.position==='prepare'||s.position==='deliver'))) return result;
 templates??=await readWorkflowTemplates();
 const refs=[...new Set([...integration.assets.filter(a=>a.consumer==='change-deliver:review').map(a=>a.target),...semantic.filter(a=>!isProjectRulesId(a.logicalId)).map(a=>a.target)])];
 const reused=new Map<string,string[]>();
 for(const binding of guidance.filter(isOriginalGuidance)){
  const path=binding.sourceRef.path;
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
   if(projectRulesPending)lines.push('','Project rules are pending. For the touched paths, read applicable AGENTS.md or CLAUDE.md files and repository contribution guidance. Use the checks below.');
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
  add('entry:'+target,target,[marker.start,'## Project workflow',...skills.map(p=>'- '+link(target,p)),...(rules?['- '+link(target,rules.target,'Project development rules')]:[]),...refs.map(p=>'- '+link(target,p)),...sources.map(path=>'- '+link(target,path)),marker.end].join('\n')+'\n',marker);
 }
 return result;
}

export function validateNavigation(assets:PreparedAsset[],existing:string[]):void {
 const available=new Set([...existing,...assets.map(a=>a.target)]);
 for(const asset of assets.filter(a=>a.target.endsWith('.md')&&a.encoding!=='base64')) {
  for(const match of markdownLinks(asset.content)) {
   const raw=match[1].split('#')[0];if(!raw||/^(?:https?:|mailto:)/.test(raw))continue;
   const target=posix.normalize(posix.join(posix.dirname(asset.target),decodeURIComponent(raw)));
   if(raw.startsWith('/')||target.startsWith('../')||!available.has(target))throw new Error('dangling or escaping navigation link: '+asset.target+' -> '+raw);
  }
 }
}
