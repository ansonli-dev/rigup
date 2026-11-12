import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import type {SetupOptions} from './types.js';
import {validateProviderBaseURL} from './analyzer/provider-url.js';
import {researchProviderMetadata} from './research/provider-settings.js';
import {essentialEnvironment,readRuntimeFile,renderRuntimeFile,runtimeEnvPath,writeRuntimeFile,type RuntimeFile} from './runtime-private-env.js';

type Consumer='provider'|'npm'|`customer:${string}`;
type Source='project-file'|'calling-environment'|'configuration'|'repository-remote';
type Evidence={configured?:string[];verified?:string[]};
export interface RuntimeInput {name:string;capability:string;destination:string;required:boolean;state:'present'|'missing'|'optional'|'unverified';source?:Source;reason:string}
export interface RuntimeSetupSummary {
 inputs:RuntimeInput[];
 template:{path:string;state:'not-needed'|'available'|'pending'|'written';needsUpdate:boolean;imported:{name:string;source:Source}[];reason?:string};
 capabilities:{capability:string;configuration:'configured'|'pending';verification:'passed'|'not-run';reason:string}[];
}
interface Declaration {name:string;capability:string;destination:string;required:boolean;reason:string;consumer?:Consumer;seed?:string;seedSource?:Source}
const exec=promisify(execFile);
const local=runtimeEnvPath;
const providerVariables=['RIGUP_PROVIDER','RIGUP_MODEL_ID','RIGUP_API_KEY_ENV','RIGUP_BASE_URL','RIGUP_MAX_OUTPUT_TOKENS','ANTHROPIC_API_KEY','ANTHROPIC_MODEL','ANTHROPIC_BASE_URL','OPENAI_API_KEY','OPENAI_MODEL','OPENAI_BASE_URL'];

export {essentialEnvironment};

function effective(file:RuntimeFile,name:string,seed?:string,seedSource?:Source):{value?:string;source?:Source}{
 const project=file.entries.get(name)?.value;
 if(project)return {value:project,source:'project-file'};
 if(seed)return {value:seed,source:seedSource??'configuration'};
 if(process.env[name])return {value:process.env[name],source:'calling-environment'};
 return {};
}

async function remoteTarget(root:string,options:SetupOptions):Promise<{value?:string;source?:Source}>{
 const tracker=options.projectConventions?.tracker;
 if(!tracker||!['gitlab','github'].includes(tracker.system))return {};
 if(tracker.reference){
  try{return {value:validateProviderBaseURL(tracker.reference).href.replace(/\/$/,''),source:'configuration'};}catch{return {};}
 }
 const result=await exec('git',['-C',root,'remote','-v'],{timeout:5000,maxBuffer:32_768,env:essentialEnvironment()}).catch(()=>undefined);
 const targets=new Set<string>();
 for(const line of result?.stdout.split('\n')??[]){
  const raw=/^\S+\s+(\S+)\s+\(fetch\)$/.exec(line)?.[1];if(!raw)continue;
  const ssh=/^(?:[^@\s]+@)?([A-Za-z0-9.-]+):([^/\s][^\s]*)$/.exec(raw);
  let value=ssh?'https://'+ssh[1]+'/'+ssh[2]:raw;
  try{
   const url=validateProviderBaseURL(value);
   if(tracker.system==='github'&&url.hostname!=='github.com')continue;
   if(tracker.system==='gitlab'&&['github.com','bitbucket.org'].includes(url.hostname))continue;
   if(!/^\/(?:[^/]+\/)+[^/]+\/?$/.test(url.pathname))continue;
   value=url.href.replace(/\/$/,'').replace(/\.git$/,'');targets.add(value);
  }catch{/* Untrusted or incompatible remotes are not runtime inputs. */}
 }
 return targets.size===1?{value:[...targets][0],source:'repository-remote'}:{};
}

async function declarations(root:string,options:SetupOptions,file:RuntimeFile,modelOverride?:string):Promise<Declaration[]>{
 const inputs:Declaration[]=[];
 const add=(name:string,capability:string,required:boolean,reason:string,consumer?:Consumer,destination=local,seed?:string,seedSource?:Source)=>{
  if(!inputs.some(input=>input.name===name&&input.capability===capability&&input.destination===destination))inputs.push({name,capability,required,reason,consumer,destination,seed,seedSource});
 };
 for(const [name,command] of Object.entries(options.customer?.commands??{}))for(const reference of command.envRefs)
  add(reference,'customer:'+name,true,'Selected customer '+name+' command',`customer:${name}`);
 for(const reference of options.customer?.envRefs??[])add(reference,'customer',true,'Selected customer workflow',undefined,'agent host ('+options.agents.join(', ')+')');
 for(const mcp of options.mcp??[])for(const reference of [...(mcp.envRefs??[]),...(mcp.command?.envRefs??[]),...(mcp.bearerTokenEnv?[mcp.bearerTokenEnv]:[])])
  add(reference,'mcp:'+mcp.id,true,'Selected MCP server',undefined,'agent host ('+mcp.agents.join(', ')+')');
 for(const reference of options.quality?.gitlab?.openwiki?.envRefs??[])
  add(reference,'gitlab:openwiki',true,'Selected OpenWiki CI job',undefined,'GitLab CI variables');
 const remoteCommands=['issue','mr','ci'].filter(name=>options.customer?.commands?.[name]);
 if(remoteCommands.length&&['gitlab','github'].includes(options.projectConventions?.tracker?.system??'')){
  const target=await remoteTarget(root,options);
  for(const name of remoteCommands)add('RIGUP_TRACKER_URL','customer:'+name,true,'Confirmed project target for the configured remote command',`customer:${name}`,local,target.value,target.source);
 }
 if(options.sdd==='openspec'||options.tools?.some(tool=>tool.install))add('RIGUP_NPM_REGISTRY','npm',false,'Optional registry override for selected automatic installers','npm');
 if(options.backend==='native'||options.projectRules===true){
  const environment={...process.env};
  for(const name of providerVariables){const value=file.entries.get(name)?.value;if(value)environment[name]=value;}
  // Only provider selection metadata is read here; values remain in this module.
  const metadata=await researchProviderMetadata(root,modelOverride,options.model,environment);
  if(metadata){
   const provider=metadata.identity.provider,prefix=provider==='anthropic'?'ANTHROPIC':'OPENAI';
   const key=metadata.identity.apiKeyEnv;
   add('RIGUP_PROVIDER','provider',true,'Selected Rigup CLI research provider','provider',local,provider,process.env.RIGUP_PROVIDER?'calling-environment':'configuration');
   add(key,'provider',true,'API key for Rigup CLI research','provider');
   add('RIGUP_MODEL_ID','provider',true,'Default CLI research model; --model overrides one run only','provider',local,metadata.identity.model,process.env.RIGUP_MODEL_ID||process.env[prefix+'_MODEL']?'calling-environment':'configuration');
   add('RIGUP_API_KEY_ENV','provider',false,'Override the provider API-key variable name','provider',local,key,process.env.RIGUP_API_KEY_ENV?'calling-environment':'configuration');
   add('RIGUP_BASE_URL','provider',false,'Optional company model gateway','provider',local,metadata.baseURL,process.env.RIGUP_BASE_URL||process.env[prefix+'_BASE_URL']?'calling-environment':'configuration');
   add('RIGUP_MAX_OUTPUT_TOKENS','provider',false,'Optional positive maximum output tokens per generation','provider',local,metadata.maxOutputTokens===undefined?undefined:String(metadata.maxOutputTokens),process.env.RIGUP_MAX_OUTPUT_TOKENS?'calling-environment':'configuration');
   for(const suffix of ['MODEL','BASE_URL'])if(effective(file,prefix+'_'+suffix).value)add(prefix+'_'+suffix,'provider',false,'Provider-specific '+suffix.toLowerCase().replace('_',' ')+' setting','provider');
  }
 }
 return inputs;
}

async function state(root:string,options:SetupOptions,evidence:Evidence={}){
 const file=await readRuntimeFile(root),declared=await declarations(root,options,file);
 const inputs:RuntimeInput[]=declared.map(input=>{
  const {name,capability,destination,required,reason}=input;
  if(destination!==local)return {name,capability,destination,required,reason,state:'unverified'};
  if(file.problem)return {name,capability,destination,required,state:required?'missing':'optional',reason:'Correct the private runtime input file before consuming this value'};
  const value=effective(file,name,input.seed,input.seedSource);
  return {name,capability,destination,required,reason,state:value.value?'present':required?'missing':'optional',...(value.source?{source:value.source}:{})};
 });
 const localInputs=declared.filter(input=>input.destination===local);
 const values=[...new Map(localInputs.map(input=>[input.name,{...input,...effective(file,input.name,input.seed,input.seedSource)}])).values()];
 const text=renderRuntimeFile(file,values);
 const capabilities=[...new Set([...declared.map(input=>input.capability),...options.agents.map(agent=>'host:'+agent),...(options.quality?.gitlab?['gitlab']:[])])].map(capability=>{
  const configured=!!(evidence.configured?.includes('*')||evidence.configured?.includes(capability));
  const verified=evidence.verified?.includes(capability)??false;
  return {capability,configuration:configured?'configured' as const:'pending' as const,verification:verified?'passed' as const:'not-run' as const,
   reason:verified?'Explicit verification completed':capability.startsWith('host:')?'Approve or reload the selected host and run its explicit host check':capability.startsWith('gitlab')?'Run the configured jobs in the target CI runner':'Configuration and input presence do not verify a connection or successful execution'};
 });
 const summary:RuntimeSetupSummary={inputs,template:{path:local,state:file.problem?'pending':localInputs.length?'available':'not-needed',needsUpdate:!file.problem&&text!==file.text,imported:[],...(file.problem?{reason:file.problem}:{})},capabilities};
 return {file,values,text,summary};
}

export async function runtimeSetupSummary(root:string,options:SetupOptions,evidence?:Evidence):Promise<RuntimeSetupSummary>{
 return (await state(root,options,evidence)).summary;
}

export async function applyRuntimeInputs(root:string,options:SetupOptions,evidence?:Evidence):Promise<RuntimeSetupSummary>{
 const {file,values,text,summary}=await state(root,options,evidence);
 if(!summary.template.needsUpdate)return summary;
 try{await writeRuntimeFile(root,file,text);}
 catch{summary.template.state='pending';summary.template.reason='Keep .rigup/.env unchanged; verify private access and effective ignore for .env and .env.rigup-*.tmp, then retry.';return summary;}
 summary.template.state='written';summary.template.needsUpdate=false;
 summary.template.imported=values.flatMap(input=>input.value&&input.source&&input.source!=='project-file'?[{name:input.name,source:input.source}]:[]);
 return summary;
}

export async function runtimeEnvironment(root:string,options:SetupOptions,consumer:Consumer,modelOverride?:string):Promise<NodeJS.ProcessEnv>{
 const file=await readRuntimeFile(root);
 if(file.problem)throw Error(file.problem);
 const inputs=await declarations(root,options,file,consumer==='provider'?modelOverride:undefined),environment=essentialEnvironment();
 for(const input of inputs.filter(input=>input.consumer===consumer)){
  const {value}=effective(file,input.name,input.seed,input.seedSource);
  if(value!==undefined)environment[input.name]=value;
 }
 return environment;
}

export async function selectedNpmRegistry(root:string):Promise<string|undefined>{
 const file=await readRuntimeFile(root);
 if(file.problem)throw Error(file.problem);
 const value=effective(file,'RIGUP_NPM_REGISTRY').value;
 if(!value)return;
 try{
  const url=validateProviderBaseURL(value);
  return url.href.replace(/\/?$/,'/');
 }catch{throw Error('RIGUP_NPM_REGISTRY must use HTTPS or loopback HTTP and omit credentials, query, and fragment');}
}

export function writeRuntimeSummary(summary:RuntimeSetupSummary,write:(text:string)=>void):void{
 write('Runtime inputs: '+summary.template.state+' ('+summary.template.path+')\n');
 if(summary.template.reason)write('Pending: '+summary.template.reason+'\n');
 for(const input of summary.template.imported)write('Imported '+input.name+' from '+input.source+'\n');
 for(const input of summary.inputs)if(input.state==='missing'||input.state==='unverified')write(input.capability+': '+input.name+' '+input.state+' — supply in '+input.destination+'\n');
 for(const capability of summary.capabilities)if(capability.verification==='not-run')write(capability.capability+': '+capability.configuration+'; verification remaining — '+capability.reason+'\n');
}
