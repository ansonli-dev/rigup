import {resolve,isAbsolute} from 'node:path';
import {stringify} from 'smol-toml';
import type {SetupOptions} from '../../types.js';
import type {Ownership} from '../../managed-input.js';
import {agents} from '../agents/index.js';
export {agents} from '../agents/index.js';
export interface McpAsset {logicalId:string;target:string;content:string;ownership:Ownership;source:{kind:'customer-mcp';ref:string}}
export async function prepareCustomerMcp(root:string,input:NonNullable<SetupOptions['mcp']>[number],runnerId=input.id):Promise<{assets:McpAsset[];operations:never[];warnings:string[]}>{
 if(!/^[a-z0-9][a-z0-9._-]*$/.test(input.id) || ['__proto__','constructor','prototype'].includes(input.id)) throw new Error('mcp.id: invalid');
 if(!/^[a-z0-9][a-z0-9._-]*$/.test(runnerId)) throw new Error('mcp runner id invalid');
 if(!input.agents.length || input.agents.some(a=>!Object.hasOwn(agents,a))) throw new Error('mcp.agents: invalid');
 if((input.url === undefined) === (input.command === undefined)) throw new Error('mcp: choose command or URL');
 const assets:McpAsset[]=[];
 const refs=[...new Set([...(input.envRefs||[]),...(input.command?.envRefs||[])])];
 if(refs.some(ref=>!/^[_A-Za-z][_A-Za-z0-9]*$/.test(ref))) throw new Error('mcp.envRefs: invalid');
 if(input.url) {
  const url=new URL(input.url);
  if(!['http:','https:'].includes(url.protocol) || url.username || url.password || [...url.searchParams.keys()].some(k=>/token|password|secret|key|auth/i.test(k))) throw new Error('mcp.url: credentials or unsupported transport');
  if(refs.length) throw new Error('mcp: remote authentication mapping requires explicit adapter');
 }
 let runner:string|undefined;
 if(input.command) {
  const command=input.command;
  if(typeof command.executable !== 'string' || !command.executable || !Array.isArray(command.args) || command.args.some(arg=>typeof arg !== 'string')) throw new Error('mcp.command: invalid executable or arguments');
  if(isAbsolute(command.cwd)||command.cwd.split(/[\\/]/).includes('..')) throw new Error('mcp.command.cwd: project relative directory required');
  const target='.rigup/mcp/'+runnerId+'.mjs';runner=resolve(root,target);
  const content=`import {spawn} from 'node:child_process';\nimport {realpathSync} from 'node:fs';\nimport {resolve,relative,isAbsolute} from 'node:path';\nimport {fileURLToPath} from 'node:url';\nconst config=${JSON.stringify({...command,envRefs:refs})};\nconst root=realpathSync(fileURLToPath(new URL('../..',import.meta.url)));\nconst cwd=realpathSync(resolve(root,config.cwd));\nconst rel=relative(root,cwd);\nif(rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('MCP cwd escapes project');\nconst args=config.args.map(arg=>arg.replace(/\\$\\{([A-Za-z_][A-Za-z0-9_]*)\\}/g,(_,name)=>{if(!config.envRefs.includes(name)||process.env[name] === undefined) throw new Error('Missing declared MCP environment reference: '+name);return process.env[name];}));\nconst child=spawn(config.executable,args,{cwd,stdio:'inherit',shell:false});\nfor(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>child.kill(signal));\nchild.on('error',()=>{process.exitCode=1;});\nchild.on('exit',(code,signal)=>{process.exitCode=code ?? (signal ? 1 : 0);});\n`;
  assets.push({logicalId:'mcp-runner:'+runnerId,target,content,ownership:{kind:'file'},source:{kind:'customer-mcp',ref:input.id}});
 }
 for(const agent of [...new Set(input.agents)]) {
  const host=agents[agent];let content:string;
  const env=Object.fromEntries(refs.map(ref=>[ref,'${'+ref+'}']));
  const base=input.url ? {type:'http',url:input.url} : {type:'stdio',command:'node',args:[runner!],env};
  if(agent === 'codex') content=stringify({mcp_servers:{[input.id]:input.url ? {url:input.url} : {command:'node',args:[runner!],env_vars:refs}}});
  else if(agent === 'opencode') content=JSON.stringify(input.url ? {type:'remote',url:input.url,enabled:true} : {type:'local',command:['node',runner!],enabled:true,environment:Object.fromEntries(refs.map(ref=>[ref,'{env:'+ref+'}']))},null,2);
  else content=JSON.stringify(base,null,2);
  assets.push({logicalId:'mcp:'+agent+':'+input.id,target:host.mcpTarget,content,ownership:agent === 'codex' ? {kind:'toml-table',path:[host.key,input.id]} : {kind:'json-key',path:[host.key,input.id]},source:{kind:'customer-mcp',ref:input.id}});
 }
 return {assets,operations:[],warnings:['MCP configured candidate only; not connected or started']};
}
