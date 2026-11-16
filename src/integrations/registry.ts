import {prepareQuality} from './tools/quality.js';
import {prepareCustomer} from './gitlab/customer.js';
import {inspectProjectToolInstall} from './tools/software.js';
import {assertEmptyToolScopes,prepareNativeInitialization} from './tools/initialization.js';
import {isNativeTool,nativeInitializationPaths,softwareInstallRecipe,toolPackage} from './tools/recipes.js';
import {scopesOverlap,type SetupOperation,type SetupOptions,type SetupPlan,type SetupRequirement} from '../types.js';
import type {ProjectProfile} from '../analyzer/repository.js';
import {resolveNpmLatest,type NpmView} from './tools/npm-resolution.js';
import {dirname,isAbsolute,resolve} from 'node:path';
import {readFile} from 'node:fs/promises';
import {agents,prepareCustomerMcp} from './tools/customer-mcp.js';
import {projectMcpArgs} from './tools/project-mcp-entry.js';
import {collectCustomSkill} from './custom-skills.js';
import {renderCustomerTemplate} from './custom-templates.js';
import {openwiki,openwikiInitializationGuide} from './tools/openwiki.js';
import {codegraph} from './tools/codegraph.js';
import type {Ownership} from '../managed-input.js';
import {resolveSddBinding,resolveSkillSource,type SddBinding} from './sdd/binding.js';
import {digest} from '../analyzer/evidence.js';
import {openspecPreparationCommand} from './sdd/openspec.js';
import {RIGUP_VERSION} from '../version.js';
import {runtimeSetupSummary,selectedNpmRegistry} from '../runtime-inputs.js';
export {loadUpstreamLock,parseUpstreamLock,requireRecipeEvidence,selectUpdateVersion,type Recipe} from './upstream.js';
export {bindSdd,resolveSkillSource} from './sdd/binding.js';
export type {SddBinding,SkillSource} from './sdd/binding.js';
export interface PreparedAsset {logicalId:string;target:string;content:string;ownership:Ownership;source:{kind:string;ref:string;digest?:string};encoding?:'utf8'|'base64';mode?:number;consumer?:string}
export interface IntegrationPreparation {assets:PreparedAsset[];operations:SetupOperation[];warnings:string[];requirements:SetupRequirement[];bindings:SddBinding[];skillBindings?:{agent:string;consumer:string;target?:string;nativeName?:string}[]}
export async function prepareIntegrations(profile:ProjectProfile,options:SetupOptions):Promise<IntegrationPreparation>{
 const [quality,runtime]=await Promise.all([prepareQuality(profile,options),runtimeSetupSummary(profile.root,options)]);
 const assets:PreparedAsset[]=[];const warnings:string[]=[];const requirements:SetupRequirement[]=[];const bindings:SddBinding[]=[];const skillBindings:NonNullable<IntegrationPreparation['skillBindings']>=[];
 for(const agent of options.agents)if(!Object.hasOwn(agents,agent))throw Error('unknown agent');
 const push=(added:PreparedAsset[])=>{
  for(const asset of added) {
   const same=assets.find(a=>a.target === asset.target && JSON.stringify(a.ownership) === JSON.stringify(asset.ownership));
   if(same) {if(same.content === asset.content) continue;throw new Error('integration target collision: '+asset.target);}
   if(assets.some(a=>a.target === asset.target && (a.ownership.kind === 'file'||asset.ownership.kind === 'file'))) throw new Error('integration target overlap: '+asset.target);
   assets.push(asset);
  }
 };
 if(options.sdd) {
  for(const agent of options.agents) {
   try {
    const {binding,warnings:bindingWarnings}=resolveSddBinding(options.sdd,agent,profile.nativeEntries?.[agent]??[],profile.skillSources?.[agent]??[],profile.files);
    if(binding.status==='pending') requirements.push({integrationId:options.sdd,reason:binding.reason});
    else bindings.push(binding);
    warnings.push(...bindingWarnings);
   }
   catch(error){
    const reason=(error as Error).message;
    const nextCommand=options.sdd==='openspec'&&reason.startsWith('missing native entry: openspec-')
     ?openspecPreparationCommand(profile.root,options.agents):undefined;
    requirements.push({integrationId:options.sdd,reason,...(nextCommand?{nextCommand}:{})});
   }
  }
 }
 for(const input of options.mcp ?? []) {
  if(input.agents.some(a=>!options.agents.includes(a))) throw new Error('MCP target agent not selected');
  const prepared=await prepareCustomerMcp(profile.root,input);push(prepared.assets);warnings.push(...prepared.warnings);requirements.push(...prepared.requirements);
 }
 if(options.projectRules&&options.agents.length){
  const target='.rigup/rigup-mcp.mjs';
  const content=(await readFile(new URL('../../templates/rigup-mcp.mjs',import.meta.url),'utf8')).replace('__RIGUP_VERSION__',RIGUP_VERSION);
  push([{logicalId:'rigup:research-launcher',target,content,ownership:{kind:'file'},source:{kind:'fixed-template',ref:'rigup-mcp',digest:digest(content)}}]);
  for(const agent of options.agents){
   const args=projectMcpArgs(agents[agent].mcpTarget,target,[agent]);
   const prepared=await prepareCustomerMcp(profile.root,{id:'rigup',agents:[agent],command:{executable:'node',args,cwd:'.',envRefs:[]}},true);
   push(prepared.assets);requirements.push(...prepared.requirements);
  }
 }
 for(const selection of options.tools ?? []) {
  const tool=selection.id === 'openwiki' ? openwiki : selection.id === 'codegraph' ? codegraph : undefined;
  if(!tool) throw new Error('unsupported executable adapter');
  if(selection.agents.some(a=>!options.agents.includes(a))) throw new Error('tool MCP target agent not selected');
  const useProjectTool=selection.install||selection.initialize&&!!profile.installedTools?.[tool.id];
  const {prefix,name,entry}=toolPackage(selection.id);
  for(const agent of selection.agents) {
   const executable=useProjectTool?'node':tool.software;
   const nativeArgs=tool.mcpArgs(agent);
   const args=useProjectTool?projectMcpArgs(agents[agent].mcpTarget,[prefix,'node_modules',name,entry].join('/'),nativeArgs):nativeArgs;
   const prepared=await prepareCustomerMcp(profile.root,{id:tool.id,agents:[agent],command:{executable,args,cwd:'.',envRefs:[]}},true);push(prepared.assets);requirements.push(...prepared.requirements);
  }
  warnings.push(tool.id+': binary availability and native connection pending');
  if(selection.id==='openwiki')warnings.push(openwikiInitializationGuide);
 }
 for(const skill of options.customSkills ?? []) for(const agent of options.agents) {
  const copies=await collectCustomSkill(resolve(profile.root,skill.source),agents[agent].skillDirectory);
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
 push(quality.assets);warnings.push(...quality.warnings);requirements.push(...quality.requirements);
 const customer=prepareCustomer(options);push(customer.assets);warnings.push(...customer.warnings);requirements.push(...customer.requirements);
 if(profile.git.available&&(assets.length||bindings.length)||runtime.inputs.some(input=>input.destination==='.rigup/.env')){
  const ownership={kind:'block' as const,start:'# rigup:start',end:'# rigup:end'};
  const content=[ownership.start,'/baseline/','/manifest.json','/native/','/tools/','/check-results/','/.env','/.env.rigup-*.tmp',ownership.end,''].join('\n');
  push([{logicalId:'rigup:local-state-ignore',target:'.rigup/.gitignore',content,ownership,source:{kind:'configuration',ref:'local-state-ignore',digest:digest(content)}}]);
 }
 return {assets,operations:[],warnings,requirements,bindings,skillBindings};
}

export async function prepareProjectToolOperations(plan:SetupPlan,profile:ProjectProfile,input:{stateRoot:string;signal?:AbortSignal;view?:NpmView}):Promise<SetupPlan>{
 const {root,options}=plan;
 if(!options.tools?.length)return plan;
 const operations=[...plan.operations],requirements=[...plan.requirements],warnings=[...plan.warnings];
 const pendingRuntimeTools:NonNullable<SetupPlan['pendingRuntimeTools']>=[];
 let registry:Promise<string|undefined>|undefined,registryUnavailable=false;
 const registryForInstall=()=>registry??=selectedNpmRegistry(root).catch(async error=>{
  registryUnavailable=(await runtimeSetupSummary(root,options)).template.state==='pending';
  throw error;
 });
 const targets=[...plan.assets.map(asset=>asset.target),...(plan.projectDocuments??[]).map(document=>document.target)];
 const pending=(id:string,reason:string,kind?:SetupRequirement['kind'])=>{requirements.push({integrationId:id,reason,...(kind?{kind}:{})});warnings.push(id+': '+reason);};
 const duplicate=options.tools.find((selection,index)=>options.tools!.findIndex(tool=>tool.id===selection.id)!==index||operations.some(operation=>operation.integrationId===selection.id));
 if(duplicate){pending(duplicate.id,'Duplicate operation for the same project tool');return {...plan,requirements,warnings};}
 for(const selection of options.tools){
  input.signal?.throwIfAborted();
  const id=selection.id;
  if(!isNativeTool(id))throw Error('Unsupported executable adapter');
  const receipt=profile.installedTools?.[id];
  const initialize=id==='codegraph'&&selection.initialize;
  if(!selection.install&&(!selection.initialize||receipt===undefined)){
   if(initialize)pending(id,'Initialization requires a verified project installation; enable project installation first');
   continue;
  }
  const local=await inspectProjectToolInstall(root,id,receipt);
  if('pending' in local){pending(id,local.pending);continue;}
  const {prefix,name}=toolPackage(id);
  const nativeReceipt=profile.initializedTools?.[id];
  const nativeScopes=initialize&&!nativeReceipt?nativeInitializationPaths(id).declaredWrites:[];
  const writes=[...('root' in local?[prefix]:[]),...nativeScopes];
  if(scopesOverlap(writes,[...targets,...operations.flatMap(op=>op.declaredWrites)])){
   pending(id,'external write scope overlaps a text candidate or operation; manual preparation required');continue;
  }
  if(nativeScopes.length)try{await assertEmptyToolScopes(root,{declaredWrites:nativeScopes});}
  catch{pending(id,'Existing or unsafe native state/staging scope requires reconciliation; user content preserved');continue;}
  let identity,install:SetupOperation|undefined;
  if('identity' in local){identity=local.identity;warnings.push(id+': reuse receipted project installation '+identity.version);}
  else try{
   const resolved=await resolveNpmLatest(name,{...input,root,registry:await registryForInstall(),nodeVersion:process.versions.node});
   identity=resolved;
   install=softwareInstallRecipe(root,id,resolved.version,resolved.packageIntegrity,undefined,resolved.registry,resolved.enginesNode);
   operations.push(install);
  }catch(error){
   input.signal?.throwIfAborted();
   if(registryUnavailable){
    if(!pendingRuntimeTools.length)warnings.push('Automatic tool installation is pending: preserve .rigup/.env and correct its private access and ignore state, then prepare a new review.');
    pendingRuntimeTools.push(id);
   }else pending(id,(error as Error).message,'npm-resolution');
   continue;
  }
  if(initialize){
   const prepared=await prepareNativeInitialization(root,id,identity.version,identity.packageIntegrity,{installed:!install,prerequisiteIds:install?[install.id]:[],receipt:nativeReceipt});
   if('pending' in prepared)pending(id,prepared.pending);
   else if('reused' in prepared)warnings.push(id+': verified native initialization reused');
   else operations.push(prepared);
  }
 }
 // Software installations have no prerequisites. Put them together before native initialization.
 operations.sort((a,b)=>Number(a.kind!=='install')-Number(b.kind!=='install'));
 return {...plan,operations,warnings,requirements,...(pendingRuntimeTools.length?{pendingRuntimeTools}:{})};
}
