import {readFile} from 'node:fs/promises';
import {posix} from 'node:path';
import type {ProjectProfile} from '../analyzer/repository.js';
import type {SetupOptions} from '../types.js';
import {agents} from '../integrations/agents/index.js';
import type {PreparedAsset,IntegrationPreparation} from '../integrations/registry.js';
import {digest} from '../analyzer/evidence.js';
export const TEMPLATE_VERSION='1';
export interface GuidanceBinding {topic:string;sourceRef:{path:string;startLine:number;endLine:number;digest:string};scope:string[];coverageStatus:string;consumers:string[];gaps:string[]}
const link=(from:string,to:string,label=to)=>`[${label.replaceAll('[','').replaceAll(']','')}](${posix.relative(posix.dirname(from),to).split('/').map(encodeURIComponent).join('/')})`;
export async function renderFixed(profile:ProjectProfile,options:SetupOptions,integration:IntegrationPreparation,semantic:PreparedAsset[],guidance:GuidanceBinding[]):Promise<PreparedAsset[]>{
 const result=[...integration.assets,...semantic];
 if(!options.sdd && !(options.customSkills?.some(s=>s.position))) return result;
 const refs=[...new Set([...integration.assets.filter(a=>a.consumer==='change-deliver:review').map(a=>a.target),...semantic.map(a=>a.target),...guidance.filter(g=>g.coverageStatus==='reusable'||g.coverageStatus==='partial').map(g=>g.sourceRef.path)])];
 const add=(logicalId:string,target:string,content:string,ownership:PreparedAsset['ownership']={kind:'file'})=>result.push({logicalId,target,content,ownership,source:{kind:'fixed-template',ref:TEMPLATE_VERSION,digest:digest(content)}});
 const entryTargets=new Set<string>();
 for(const agent of options.agents) {
  const host=agents[agent];entryTargets.add(host.entry);
  for(const name of ['change-prepare','change-deliver']) {
   const target=host.skillDirectory+'/'+name+'/SKILL.md';
   add(agent+':'+name,target,await readFile(new URL('../../templates/skills/'+name+'/SKILL.md',import.meta.url),'utf8'));
   const refTarget=host.skillDirectory+'/'+name+'/references/project.md';
   const binding=integration.bindings.find(b=>b.id===options.sdd);
   const lines=['# Project context',...(binding ? ['Native prepare: '+binding.prepare.join(', '),'Native deliver: '+binding.deliver.join(', '),'Native document routes: '+binding.artifacts.join(', '),...binding.gates] : ['Native workflow prerequisites pending; do not claim completion.']),...refs.map(p=>'- '+link(refTarget,p))];
   for(const g of guidance) lines.push(`Guidance ${g.topic}: ${g.coverageStatus}; scope ${g.scope.join(', ')}; gaps ${g.gaps.join(', ')}`);
   for(const [kind,commands] of Object.entries(profile.commands)) for(const command of commands) lines.push(`Existing ${kind} sensor in ${command.cwd}: ${JSON.stringify(command)}. Run only when authorized and relevant.`);
   if(options.projectConventions?.tracker)lines.push('Tracker convention (no migration): '+JSON.stringify(options.projectConventions.tracker));
   if(options.projectConventions?.documentRoutes)lines.push('Document destinations (no migration): '+JSON.stringify(options.projectConventions.documentRoutes));
   add(agent+':'+name+':context',refTarget,lines.join('\n')+'\n');
  }
 }
 for(const target of entryTargets) {
  const marker={kind:'block' as const,start:'<!-- rigup:start -->',end:'<!-- rigup:end -->'};
  const skills=options.agents.filter(a=>agents[a].entry===target).flatMap(a=>['change-prepare','change-deliver'].map(n=>agents[a].skillDirectory+'/'+n+'/SKILL.md'));
  add('entry:'+target,target,[marker.start,'## Project workflow',...skills.map(p=>'- '+link(target,p)),...refs.map(p=>'- '+link(target,p)),...guidance.map(g=>`Scope ${g.topic}: ${g.scope.join(', ')}; ${g.coverageStatus}.`),marker.end].join('\n')+'\n',marker);
 }
 return result;
}

export function validateNavigation(assets:PreparedAsset[],existing:string[]):void {
 const available=new Set([...existing,...assets.map(a=>a.target)]);
 for(const asset of assets.filter(a=>a.target.endsWith('.md')&&a.encoding!=='base64')) {
  for(const match of asset.content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
   const raw=match[1].split('#')[0];if(!raw||/^(?:https?:|mailto:)/.test(raw))continue;
   const target=posix.normalize(posix.join(posix.dirname(asset.target),decodeURIComponent(raw)));
   if(raw.startsWith('/')||target.startsWith('../')||!available.has(target))throw new Error('dangling or escaping navigation link: '+asset.target+' -> '+raw);
  }
 }
}
