import {readFile} from 'node:fs/promises';
import {posix} from 'node:path';
import type {ProjectProfile} from '../analyzer/repository.js';
import type {Evidence,SetupOptions} from '../types.js';
import {agents} from '../integrations/agents/index.js';
import type {PreparedAsset,IntegrationPreparation} from '../integrations/registry.js';
import {digest} from '../analyzer/evidence.js';
import {isProjectRulesId} from './project-rules.js';
import {markdownLinks} from './document-policy.js';
export const TEMPLATE_VERSION='2';
export interface GuidanceBinding {topic:string;sourceRef?:Evidence;scope:string[];coverageStatus:string;consumers:string[];gaps:string[]}
const inline=(value:string)=>value.replace(/[\r\n\t]+/g,' ').replace(/[\\`*_\[\]<>]/g,'\\$&');
const link=(from:string,to:string,label=to,anchor='')=>`[${inline(label)}](${posix.relative(posix.dirname(from),to).split('/').map(part=>encodeURIComponent(part).replaceAll('(','%28').replaceAll(')','%29')).join('/')}${anchor})`;
const original=(from:string,ref:Evidence)=>link(from,ref.path,ref.path,`#L${ref.startLine}-L${ref.endLine}`);
export function readWorkflowTemplates(){
 return Promise.all(['change-prepare','change-deliver'].map(async name=>{
  const base=new URL('../../templates/skills/'+name+'/',import.meta.url);
  const [skill,reference]=await Promise.all(['SKILL.md','references/project.md'].map(path=>readFile(new URL(path,base),'utf8')));
  return {name,skill,reference};
 }));
}
export async function renderFixed(profile:ProjectProfile,options:SetupOptions,integration:IntegrationPreparation,semantic:PreparedAsset[],guidance:GuidanceBinding[],templates?:Awaited<ReturnType<typeof readWorkflowTemplates>>):Promise<PreparedAsset[]>{
 const result=[...integration.assets,...semantic];
 if(!options.sdd && !(options.customSkills?.some(s=>s.position==='prepare'||s.position==='deliver'))) return result;
 templates??=await readWorkflowTemplates();
 const refs=[...new Set([...integration.assets.filter(a=>a.consumer==='change-deliver:review').map(a=>a.target),...semantic.filter(a=>!isProjectRulesId(a.logicalId)).map(a=>a.target)])];
 const reused=guidance.flatMap(g=>g.sourceRef&&(g.coverageStatus==='reusable'||g.coverageStatus==='partial')?[g.sourceRef]:[]);
 const commandSources=new Set(Object.values(profile.commands).flat().map(command=>posix.join(command.cwd,'package.json')));
 const hookSources=profile.files.filter(path=>/(?:^|\/)(?:\.husky\/(?:pre-commit|pre-push)|\.pre-commit-config\.ya?ml|\.?lefthook\.ya?ml|\.?lintstagedrc(?:\.[a-z]+)?|lint-staged\.config\.[a-z]+)$/.test(path));
 const rules=semantic.find(a=>isProjectRulesId(a.logicalId));
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
   if(rules||refs.length||guidance.length){
    lines.push('','## Project guidance','');
    if(rules)lines.push('- Before planning or editing, read '+link(refTarget,rules.target,'project development rules')+' and apply the rules that cover the changed paths.');
    lines.push(...refs.map(p=>'- '+link(refTarget,p)));
    for(const g of guidance){
     const source=g.sourceRef?' '+original(refTarget,g.sourceRef)+'.':'';
     lines.push(`- ${inline(g.topic)} (${inline(g.coverageStatus)}) applies to ${inline(g.scope.join(', '))||'an unresolved scope'}.${source}${g.gaps.length?' Gaps to check include '+inline(g.gaps.join(', '))+'.':''}`);
    }
   }
   const sources=profile.files.filter(p=>commandSources.has(p)||hookSources.includes(p));
   if(sources.length){
    lines.push('','## Existing checks','',...sources.map(p=>'- '+link(refTarget,p)));
    for(const [kind,commands] of Object.entries(profile.commands)) for(const command of commands) lines.push(`- Existing ${kind} in ${inline(command.cwd)} runs ${inline(JSON.stringify([command.executable,...command.args]))}.`);
   }
   if(options.projectConventions?.tracker)lines.push('','Tracker convention '+inline(JSON.stringify(options.projectConventions.tracker)));
   if(options.projectConventions?.documentRoutes)lines.push('','Document destinations '+inline(JSON.stringify(options.projectConventions.documentRoutes)));
   add(agent+':'+name+':context',refTarget,lines.join('\n')+'\n');
  }
 }
 for(const target of entryTargets) {
  const marker={kind:'block' as const,start:'<!-- rigup:start -->',end:'<!-- rigup:end -->'};
  const skills=options.agents.filter(a=>agents[a].entry===target).flatMap(a=>templates.map(({name})=>agents[a].skillDirectory+'/'+name+'/SKILL.md'));
  const sources=[...new Map(reused.filter(ref=>ref.path!==target).map(ref=>[ref.path,ref])).values()];
  add('entry:'+target,target,[marker.start,'## Project workflow',...skills.map(p=>'- '+link(target,p)),...(rules?['- '+link(target,rules.target,'Project development rules')]:[]),...refs.map(p=>'- '+link(target,p)),...sources.map(ref=>'- '+original(target,ref)),marker.end].join('\n')+'\n',marker);
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
