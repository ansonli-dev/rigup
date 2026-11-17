import type {ProjectProfile} from '../../analyzer/repository.js';
import {quoteShell,quoteShellList} from '../../shell-command.js';
import type {Agent} from '../../types.js';
import {resolveSddBinding,sddDiscoveryNames,unqualifiedSkillName} from '../sdd/binding.js';

export const claudePlugin='superpowers@claude-plugins-official';
export const ompPackage='@loneexile/omp-superpowers';
export const supportedHost=(agent:Agent):agent is 'claude'|'omp'=>agent==='claude'||agent==='omp';
export const superpowersManual:Record<Agent,string>={
 claude:'/plugin install '+claudePlugin,
 omp:'Install or enable Superpowers in the OMP Marketplace or with omp plugin install '+ompPackage,
 codex:'Open /plugins and install or enable Superpowers',
 opencode:'Configure the official Superpowers plugin and restart OpenCode',
};
export const nativePreparationCommand=(root:string,agents:Agent[])=>'rigup init '+quoteShell(root)+' --agents '+quoteShellList(agents)+' --sdd superpowers --prepare-native';

export function superpowersReadiness(profile:ProjectProfile,agent:Agent){
 const sources=profile.skillSources?.[agent]??[];
 try{
  const {binding}=resolveSddBinding('superpowers',agent,profile.nativeEntries?.[agent]??[],sources,profile.files);
  return {status:'ready' as const,binding};
 }catch(error){
  const reason=(error as Error).message;
  const diagnostics=profile.nativeDiagnostics?.filter(item=>item.agent===agent)??[];
  const notice=diagnostics.map(item=>item.detail).filter((value,index,all)=>all.indexOf(value)===index).join('; ');
  const wanted=sddDiscoveryNames('superpowers',false);
  const source=sources.find(item=>wanted.includes(unqualifiedSkillName(item.name)));
  const blocking=source?.problem??(source?'Existing Superpowers entries do not form a complete workflow; reconcile their sources':undefined);
  const missing=reason.startsWith('missing native entry:')&&!source&&!diagnostics.some(item=>item.code!=='omp-claude-provider-filtered');
  return {status:missing?'missing' as const:'manual' as const,reason:[reason,notice,blocking].filter(Boolean).join('; ')};
 }
}
