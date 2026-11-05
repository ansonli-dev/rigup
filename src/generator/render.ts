import {readFile} from 'node:fs/promises';
import {posix} from 'node:path';
import type {ProjectProfile} from '../analyzer/repository.js';
import type {SetupOptions} from '../types.js';
import {agents} from '../integrations/agents/index.js';
import type {PreparedAsset,IntegrationPreparation} from '../integrations/registry.js';
import {digest} from '../analyzer/evidence.js';
import {isOriginalGuidance,isProjectRulesId,isProjectRulesIndex,verifiedScopes,type GuidanceBinding} from './project-rules.js';
import {markdownLinks} from './document-policy.js';
import {quoteShell} from '../shell-command.js';
export const TEMPLATE_VERSION='4';
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
 const commandSources=new Set(Object.values(profile.commands).flat().map(command=>posix.join(command.cwd,'package.json')));
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
   if(projectRulesPending)lines.push('','Project rules are pending. For the touched paths, read applicable AGENTS.md or CLAUDE.md files and repository contribution guidance. Use the checks below. Run rigup update to prepare verified project rules.');
   if(rules||refs.length||reused.size){
    lines.push('','## Project guidance','');
    if(rules)lines.push('- Before planning or editing, use the scopes in the '+link(refTarget,rules.target,'project development rules index')+' to open the topics and original guidance that apply to the changed paths.');
    lines.push(...refs.map(p=>'- '+link(refTarget,p)));
    for(const [path,scope] of reused){
     if(path===refTarget)continue;
     lines.push('- '+link(refTarget,path)+(scope.length?' · '+inline(scope.join(', ')):''));
    }
   }
   const sources=profile.files.filter(p=>commandSources.has(p)||hookSources.includes(p));
   if(sources.length){
    lines.push('','## Existing checks','',...sources.map(p=>'- '+link(refTarget,p)));
    for(const [kind,commands] of Object.entries(profile.commands)) for(const command of commands) lines.push(`- Existing ${kind} in ${inline(command.cwd)} runs ${inline(JSON.stringify([command.executable,...command.args]))}.`);
   }
   if(profile.specializedChecks.length){
    lines.push('','## Specialized checks','','Working directories are relative to the repository root. Select the checks relevant to the change and verify their prerequisites in project sources.');
    for(const {command,source,tools,postgres} of profile.specializedChecks){
     const run=[command.executable,...command.args].join(' ');
     const fromRoot=command.cwd==='.'?'':'cd '+quoteShell('./'+command.cwd)+' && ';
     lines.push(`- ${codeSpan(run)} from ${codeSpan(command.cwd)} · ${link(refTarget,source)}`);
     if(tools?.includes('yarn'))lines.push('  - The script calls Yarn. Put the project’s Yarn version on PATH and verify it with '+codeSpan('yarn --version')+'.');
     if(tools?.includes('playwright'))lines.push('  - Install the project’s Playwright browsers if missing with '+codeSpan('npm exec --yes=false -- playwright install')+' from this package directory after installing project dependencies. Check the Playwright configuration for local URLs and ports.');
     if(tools?.includes('pm2')){
      const check=tools.includes('yarn')?"(command -v yarn >/dev/null || { printf '%s\\n' 'Yarn is required on PATH' >&2; exit 127; }) && ":'';
      const isolated="(pm2_bin=$(npm exec --offline --yes=false --call 'command -v pm2') && test -x \"$pm2_bin\" || { printf '%s\\n' 'Install the project dependencies first' >&2; exit 127; }; PM2_HOME=$(mktemp -d) || exit; export PM2_HOME; trap '\"$pm2_bin\" kill >/dev/null 2>&1' 0; "+run+')';
      lines.push('  - The script starts a PM2 background process. From the repository root, use an isolated '+codeSpan('PM2_HOME')+' and stop that instance on exit with '+codeSpan(fromRoot+check+isolated)+'.');
     }
     if(postgres){
      lines.push('  - Use a reachable, dedicated PostgreSQL test database and load the project test environment in the authorized terminal. See '+link(refTarget,postgres.config)+'.');
      if(postgres.guard)lines.push('  - '+link(refTarget,postgres.guard)+' requires that the database name contain '+codeSpan('test')+'. Confirm the resolved database before migrations or tests.');
      const migration=postgres.migration?'npm run '+postgres.migration+' && ':'';
      if(postgres.runInBand)lines.push('  - Run these Jest suites serially when they share the test database. Run separate database checks one at a time when they use the same fixtures.');
      lines.push('  - After confirming the test target and environment, run from the repository root '+codeSpan(fromRoot+migration+run)+'. If the agent sandbox blocks loopback, copy this command to the authorized terminal and bring back the exit status and test summary.');
     }
    }
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
