import {readFile} from 'node:fs/promises';
import type {Agent} from '../../types.js';
import {prepareCustomerMcp} from '../tools/customer-mcp.js';
import {projectMcpArgs} from '../tools/project-mcp-entry.js';
import {agents} from './index.js';

export const rigupLauncherTarget='.rigup/rigup-mcp.mjs';
export const rigupLauncherTemplate=()=>readFile(new URL('../../../templates/rigup-mcp.mjs',import.meta.url),'utf8');

export async function prepareRigupResearchMcp(root:string,agent:Agent){
 const args=projectMcpArgs(agents[agent].mcpTarget,rigupLauncherTarget,[agent]);
 const {assets:[asset]}=await prepareCustomerMcp(root,{id:'rigup',agents:[agent],command:{executable:'node',args,cwd:'.',envRefs:[]}},true);
 return asset;
}
