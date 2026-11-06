import {realpath} from 'node:fs/promises';
import {resolve,isAbsolute,relative} from 'node:path';
import {stringify} from 'smol-toml';
import type {SetupOptions,SetupRequirement} from '../../types.js';
import type {Ownership} from '../../managed-input.js';
import {agents} from '../agents/index.js';
export {agents} from '../agents/index.js';
export interface McpAsset {logicalId:string;target:string;content:string;ownership:Ownership;source:{kind:'customer-mcp';ref:string}}

export async function prepareCustomerMcp(root:string,input:NonNullable<SetupOptions['mcp']>[number]):Promise<{assets:McpAsset[];operations:never[];warnings:string[];requirements:SetupRequirement[]}>{
 if(!/^[a-z0-9][a-z0-9._-]*$/.test(input.id)||['__proto__','constructor','prototype'].includes(input.id))throw Error('mcp.id: invalid');
 if(!input.agents.length||input.agents.some(a=>!Object.hasOwn(agents,a)))throw Error('mcp.agents: invalid');
 if((input.url===undefined)===(input.command===undefined))throw Error('mcp: choose command or URL');
 const assets:McpAsset[]=[],requirements:SetupRequirement[]=[];
 const refs=[...new Set([...(input.envRefs??[]),...(input.command?.envRefs??[])])];
 if(refs.some(ref=>!/^[_A-Za-z][_A-Za-z0-9]*$/.test(ref)))throw Error('mcp.envRefs: invalid');
 if(input.url){
  const url=new URL(input.url);
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||[...url.searchParams.keys()].some(k=>/token|password|secret|key|auth|cookies?/i.test(k)))throw Error('mcp.url: credentials or unsupported transport');
  if(refs.length)throw Error('mcp: remote authentication mapping requires explicit adapter');
 }
 const command=input.command;
 let cwd:string|undefined;
 const variable=/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
 let argumentReferences:string[]=[];
 if(command){
  if(typeof command.executable!=='string'||!command.executable||!Array.isArray(command.args)||command.args.some(arg=>typeof arg!=='string'))throw Error('mcp.command: invalid executable or arguments');
  if(typeof command.cwd!=='string'||isAbsolute(command.cwd)||command.cwd.split(/[\\/]/).includes('..'))throw Error('mcp.command.cwd: project relative directory required');
  const project=await realpath(root);
  cwd=await realpath(resolve(project,command.cwd));
  const rel=relative(project,cwd);
  if(rel==='..'||rel.startsWith('../')||isAbsolute(rel))throw Error('mcp.command.cwd: directory escapes project');
  argumentReferences=command.args.flatMap(arg=>Array.from(arg.matchAll(variable),match=>match[1]));
  if(argumentReferences.some(name=>!refs.includes(name)))throw Error('mcp.command.args: declare each environment reference');
 }
 for(const agent of new Set(input.agents)){
  const host=agents[agent];
  if(command&&(agent==='codex'&&argumentReferences.length||agent==='claude'&&resolve(root,command.cwd)!==resolve(root))){
   const reason=agent==='codex'
    ?'Use a server that reads environment variables directly, or select a project-owned command for argument expansion.'
    :'Select a project-owned command that starts from the project root for Claude Code.';
   requirements.push({integrationId:'mcp:'+agent+':'+input.id,reason});
   continue;
  }
  let content:string;
  if(input.url){
   if(agent==='codex')content=stringify({mcp_servers:{[input.id]:{url:input.url}}});
   else content=JSON.stringify(agent==='opencode'?{type:'remote',url:input.url,enabled:true}:{type:'http',url:input.url},null,2);
  }else if(command){
   const {executable,args}=command;
   if(agent==='codex')content=stringify({mcp_servers:{[input.id]:{command:executable,args,cwd,env_vars:refs}}});
   else if(agent==='opencode'){
    const expand=(arg:string)=>arg.replace(variable,(_,name)=>'{env:'+name+'}');
    content=JSON.stringify({type:'local',command:[executable,...args.map(expand)],cwd,enabled:true,environment:Object.fromEntries(refs.map(name=>[name,'{env:'+name+'}']))},null,2);
   }else{
    const env=Object.fromEntries(refs.map(name=>[name,'$'+'{'+name+'}']));
    content=JSON.stringify({type:'stdio',command:executable,args,env,...(agent==='omp'?{cwd}:{})},null,2);
   }
  }else throw Error('MCP transport unavailable');
  assets.push({logicalId:'mcp:'+agent+':'+input.id,target:host.mcpTarget,content,ownership:agent==='codex'?{kind:'toml-table',path:[host.key,input.id]}:{kind:'json-key',path:[host.key,input.id]},source:{kind:'customer-mcp',ref:input.id}});
 }
 return {assets,requirements,operations:[],warnings:['MCP configured candidate only; not connected or started']};
}
