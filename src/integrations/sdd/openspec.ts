import type {Agent} from '../../types.js';
import {quoteShell,quoteShellList} from '../../shell-command.js';

export const openspec={id:'openspec',prepare:['openspec-propose'],revise:'openspec-update-change',sync:'openspec-sync-specs',deliver:['openspec-apply-change','openspec-archive-change'],artifacts:['openspec/specs','openspec/changes'],gates:['Retain native artifact dependency checks and archive decisions','Use existing project checks before marking implementation complete']};
export const openspecPackage='@fission-ai/openspec';
const toolNames:Record<Agent,string>={codex:'codex',claude:'claude',opencode:'opencode',omp:'oh-my-pi'};
export const openspecInitArgs=(hosts:Agent[])=>['init','--tools',hosts.map(agent=>toolNames[agent]).join(',')||'none','--profile','core','--no-copilot-cloud'];
export const openspecPreparationCommand=(root:string,hosts:Agent[])=>
 'rigup init '+quoteShell(root)+' --agents '+quoteShellList(hosts)+' --sdd openspec --prepare-openspec';
