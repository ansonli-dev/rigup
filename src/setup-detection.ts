import {scanNativeEntries} from './analyzer/repository.js';
import {agents,projectCommandRoots} from './integrations/agents/index.js';
import {resolveSddBinding,sddDiscoveryNames,unqualifiedSkillName} from './integrations/sdd/binding.js';
import {codegraph} from './integrations/tools/codegraph.js';
import {openwiki} from './integrations/tools/openwiki.js';
import {externalExecutable,npmPathDirectories} from './npm-command.mjs';
import type {Agent,SetupOptions} from './types.js';

export async function detectCommands(root:string){
 const path=process.env.RIGUP_CONSUMER_PATH??process.env.PATH??process.env.Path??'';
 const dirs=await npmPathDirectories(root,process.platform==='win32'?path.replace(/(^|;)"([^"]+)"(?=;|$)/g,'$1$2'):path);
 const found=async(name:string)=>{
  const suffixes=process.platform==='win32'?['.exe','.cmd']:[''];
  for(const suffix of suffixes)if(await externalExecutable(name+suffix,root,dirs))return true;
  return false;
 };
 const hosts=Object.keys(agents) as Agent[];
 const tools=[openwiki,codegraph];
 const [installed,registerable]=await Promise.all([
  Promise.all(hosts.map(found)),Promise.all(tools.map(tool=>found(tool.software))),
 ]);
 return {agents:hosts.filter((_,index)=>installed[index]),tools:new Set(tools.filter((_,index)=>registerable[index]).map(tool=>tool.id))};
}

export async function detectSdd(root:string,options:SetupOptions,write:(text:string)=>void):Promise<SetupOptions['sdd']>{
 const markers={superpowers:['docs/superpowers'],openspec:['openspec/config.yaml','openspec/config.yml'],'spec-kit':['.specify']};
 const ids=['superpowers','openspec','spec-kit'] as const;
 const hostScopes=options.agents.flatMap(agent=>[agents[agent].skillDirectory,...projectCommandRoots[agent]]);
 const candidates=await Promise.all(ids.map(async sdd=>{
  const profile=await scanNativeEntries(root,{agents:options.agents,backend:options.backend,sdd,
   scope:[...hostScopes,...markers[sdd]],readBudget:options.readBudget});
  const names=sddDiscoveryNames(sdd);
  const sources=options.agents.flatMap(agent=>profile.skillSources?.[agent]??[]).filter(source=>names.includes(unqualifiedSkillName(source.name)));
  const projectFiles=new Set(profile.files);
  const hasProject=profile.files.some(file=>markers[sdd].some(marker=>file===marker||file.startsWith(marker+'/')))||
   sources.some(source=>projectFiles.has(source.identity));
  const missing=options.agents.flatMap(agent=>{
   try{
    resolveSddBinding(sdd,agent,profile.nativeEntries?.[agent]??[],profile.skillSources?.[agent]??[],profile.files);
    return [];
   }catch(error){return [agent+': '+(error as Error).message];}
  });
  return {sdd,hasProject,hasSources:sources.length>0,missing};
 }));
 const project=candidates.filter(candidate=>candidate.hasProject);
 const available=candidates.filter(candidate=>!candidate.missing.length);
 for(const candidate of candidates.filter(item=>item.hasProject||item.hasSources&&item.missing.length)){
  write('Detected '+candidate.sdd+(candidate.hasProject?' project evidence':' sources')+(candidate.missing.length?' · '+candidate.missing[0]:'')+'\n');
 }
 if(project.length===1)return project[0].sdd;
 if(!project.length&&available.length===1){
  write('Detected '+available[0].sdd+' sources for the selected agents\n');return available[0].sdd;
 }
 if(!project.length&&available.length>1)write('Detected multiple SDDs: '+available.map(candidate=>candidate.sdd).join(', ')+'\n');
}
