import {prepareQuality} from './tools/quality.js';
import {prepareCustomer} from './gitlab/customer.js';
import {prepareSoftwareInstall} from './tools/software.js';
import {prepareNativeInitialization} from './tools/initialization.js';
import type {SetupOperation,SetupRequirement} from '../types.js';
import {quoteShell} from '../shell-command.js';
import {dirname,isAbsolute,resolve} from 'node:path';
import {agents,prepareCustomerMcp} from './tools/customer-mcp.js';
import {collectCustomSkill} from './custom-skills.js';
import {renderCustomerTemplate} from './custom-templates.js';
import {openwiki,openwikiInitializationGuide} from './tools/openwiki.js';
import {codegraph} from './tools/codegraph.js';
import type {Ownership} from '../managed-input.js';
import {resolveSddBinding,resolveSkillSource,type SddBinding} from './sdd/binding.js';
import {digest} from '../analyzer/evidence.js';
import {loadUpstreamLock,requireRecipeEvidence} from './upstream.js';
export {loadUpstreamLock,parseUpstreamLock,requireRecipeEvidence,selectUpdateVersion,type Recipe} from './upstream.js';
export {bindSdd,resolveSkillSource} from './sdd/binding.js';
export type {SddBinding,SkillSource} from './sdd/binding.js';
export interface PreparedAsset {logicalId:string;target:string;content:string;ownership:Ownership;source:{kind:string;ref:string;digest?:string};encoding?:'utf8'|'base64';mode?:number;consumer?:string}
export interface IntegrationPreparation {assets:PreparedAsset[];operations:SetupOperation[];warnings:string[];requirements:SetupRequirement[];bindings:SddBinding[];skillBindings?:{agent:string;consumer:string;target?:string;nativeName?:string}[]}
export async function prepareIntegrations(profile:import('../analyzer/repository.js').ProjectProfile,options:import('../types.js').SetupOptions):Promise<IntegrationPreparation>{
 const lock=await loadUpstreamLock();const assets:PreparedAsset[]=[];const operations:SetupOperation[]=[];const warnings:string[]=[];const requirements:IntegrationPreparation['requirements']=[];const bindings:SddBinding[]=[];const skillBindings:NonNullable<IntegrationPreparation['skillBindings']>=[];
 const requireKnown=(id:string)=>{const recipe=lock.find(r=>r.integrationId === id);if(!recipe) throw new Error('unsupported integration: '+id);requireRecipeEvidence(recipe);return recipe;};
 for(const agent of options.agents) {if(!Object.hasOwn(agents,agent)) throw new Error('unknown agent');requireKnown(agent);}
 const push=(added:PreparedAsset[])=>{
  for(const asset of added) {
   const same=assets.find(a=>a.target === asset.target && JSON.stringify(a.ownership) === JSON.stringify(asset.ownership));
   if(same) {if(same.content === asset.content) continue;throw new Error('integration target collision: '+asset.target);}
   if(assets.some(a=>a.target === asset.target && (a.ownership.kind === 'file'||asset.ownership.kind === 'file'))) throw new Error('integration target overlap: '+asset.target);
   assets.push(asset);
  }
 };
 if(options.sdd) {
  const recipe=requireKnown(options.sdd);
  for(const agent of options.agents) {
   try {
    const {binding,warnings:bindingWarnings}=resolveSddBinding(options.sdd,agent,profile.nativeEntries?.[agent]??[],profile.skillSources?.[agent]??[],profile.files);
    if(binding.status==='pending') requirements.push({integrationId:options.sdd,reason:binding.reason});
    else bindings.push(binding);
    warnings.push(...bindingWarnings);
   }
   catch(error){
    const reason=(error as Error).message;
    const nextCommand=options.sdd==='openspec'&&reason.startsWith('missing native entry: openspec-')&&['codex','claude','opencode'].includes(agent)
     ?'cd '+quoteShell(profile.root)+' && npx --yes @fission-ai/openspec@'+recipe.version+' init --tools '+agent+' --profile core --no-copilot-cloud':undefined;
    requirements.push({integrationId:options.sdd,reason,...(nextCommand?{nextCommand}:{})});
   }
  }
 }
 for(const input of options.mcp ?? []) {
  if(input.agents.some(a=>!options.agents.includes(a))) throw new Error('MCP target agent not selected');
  const prepared=await prepareCustomerMcp(profile.root,input);push(prepared.assets);warnings.push(...prepared.warnings);
 }
 for(const selection of options.tools ?? []) {
  const recipe=requireKnown(selection.id);const tool=selection.id === 'openwiki' ? openwiki : selection.id === 'codegraph' ? codegraph : undefined;
  if(!tool) throw new Error('unsupported executable adapter');
  if(selection.agents.some(a=>!options.agents.includes(a))) throw new Error('tool MCP target agent not selected');
  for(const agent of selection.agents) {
   const prepared=await prepareCustomerMcp(profile.root,{id:tool.id,agents:[agent],command:{executable:selection.install||selection.initialize&&!!profile.installedTools?.[tool.id] ? resolve(profile.root,'.rigup/tools/'+tool.id+'/node_modules/.bin/'+tool.software) : tool.software,args:tool.mcpArgs(agent),cwd:'.',envRefs:[]}},tool.id+'-'+agent);push(prepared.assets);
  }
  warnings.push(tool.id+': binary '+recipe.version+' availability and native connection pending');
  let installed=false;
  if(selection.install||selection.initialize&&profile.installedTools?.[tool.id]) {
   const prepared=await prepareSoftwareInstall(profile.root,selection.id,recipe.version,recipe.packageIntegrity,profile.installedTools?.[tool.id]);
   if('pending' in prepared) {warnings.push(tool.id+': '+prepared.pending);requirements.push({integrationId:tool.id,reason:prepared.pending});}
   else if('reused' in prepared) {installed=true;warnings.push(tool.id+': reuse receipted project installation '+prepared.version);}
   else if(selection.install) operations.push(prepared);
  }
  if(selection.id==='openwiki')warnings.push(openwikiInitializationGuide);
  else if(selection.initialize) {
   const prepared=await prepareNativeInitialization(profile.root,selection.id,recipe.version,recipe.packageIntegrity,{installed,prerequisiteIds:operations.filter(o=>o.id==='install:'+selection.id).map(o=>o.id),receipt:profile.initializedTools?.[tool.id]});
   if('pending' in prepared){warnings.push(tool.id+': '+prepared.pending);requirements.push({integrationId:tool.id,reason:prepared.pending});}else if('reused' in prepared)warnings.push(tool.id+': verified native initialization reused');else operations.push(prepared);
  }
 }
 for(const skill of options.customSkills ?? []) for(const agent of options.agents) {
  const copies=await collectCustomSkill(skill.source.startsWith('/') ? skill.source : profile.root+'/'+skill.source,agents[agent].skillDirectory);
  const entry=copies.find(a=>a.target.endsWith('/SKILL.md'))!;const name=entry.target.split('/').at(-2)!;
  const existing=(profile.skillSources?.[agent]??[]).filter(s=>s.name===name||s.name.split(':').at(-1)===name);
  const resolved=existing.length?resolveSkillSource(name,existing.map(s=>({...s,name,nativeName:s.name}))):undefined;
  if(resolved){
   const bundle=(items:Awaited<ReturnType<typeof collectCustomSkill>>)=>digest(JSON.stringify(items.map(a=>({target:a.target,digest:a.source.digest,mode:a.mode,encoding:a.encoding}))));
   for(const source of existing){const installed=await collectCustomSkill(dirname(isAbsolute(source.identity)?source.identity:resolve(profile.root,source.identity)),agents[agent].skillDirectory);if(bundle(installed)!==bundle(copies))throw new Error('skill source conflict: selected and native resources are not equivalent');}
  }
  if(skill.position==='release')requirements.push({integrationId:name,reason:'Customer release position pending a verified release adapter; no release workflow is installed'});
  else if(skill.position)skillBindings.push({agent,consumer:'change-'+skill.position,...(resolved&&isAbsolute(resolved.identity)?{nativeName:resolved.nativeName}:{target:resolved?.identity??entry.target})});
  if(resolved) {warnings.push(name+': reuse satisfied native source; no duplicate copy');continue;}
  push(copies.map(a=>({...a,...(skill.position && a === entry ? {consumer:'change-'+skill.position} : {})})));
 }
 const context=options.projectConventions?.documentRoutes?.context ?? 'docs/rigup';
 const roots=[context,...assets.filter(a=>a.target.endsWith('/SKILL.md')).map(a=>a.target.slice(0,-9)+'/references')];
 for(const template of options.templates ?? []) push([await renderCustomerTemplate(profile.root,template,roots,'change-deliver:review')]);
 if(options.projectConventions?.tracker) warnings.push('Tracker convention recorded; executable tracker adapter is pending');
 const quality=await prepareQuality(profile,options);push(quality.assets);warnings.push(...quality.warnings);requirements.push(...quality.requirements);
 const customer=prepareCustomer(options);push(customer.assets);warnings.push(...customer.warnings);requirements.push(...customer.requirements);
 if(profile.git.available&&(assets.length||bindings.length)){
  const ownership={kind:'block' as const,start:'# rigup:start',end:'# rigup:end'};
  const content=[ownership.start,'/baseline/','/manifest.json','/native/','/tools/',ownership.end,''].join('\n');
  push([{logicalId:'rigup:local-state-ignore',target:'.rigup/.gitignore',content,ownership,source:{kind:'configuration',ref:'local-state-ignore',digest:digest(content)}}]);
 }
 for(let i=operations.length-1;i>=0;i--) {
  const operation=operations[i];
  if(operation.declaredWrites.some(scope=>assets.some(asset=>scope === '.' || asset.target === scope || asset.target.startsWith(scope+'/')))) {
   operations.splice(i,1);const reason='external write scope overlaps a text candidate; manual preparation required';
   warnings.push(operation.integrationId+': '+reason);requirements.push({integrationId:operation.integrationId,reason});
  }
 }
 // Software installations have no prerequisites. Put them together before native initialization.
 operations.sort((a,b)=>Number(a.kind!=='install')-Number(b.kind!=='install'));
 return {assets,operations,warnings,requirements,bindings,skillBindings};
}
