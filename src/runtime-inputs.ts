import {makeReason,ReasonError,reasonDetail,reasonFallback,renderReason,type ReasonInput,type WithReasonDetail} from './i18n/reasons.js';
import {artifactLocale,t,translate,type MessageKey,type MessageParams} from './i18n/index.js';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import type {SetupOptions} from './types.js';
import {effectiveNpmRegistry,normalizeNpmRegistry} from './integrations/tools/npm-resolution.js';
import {validateTrackerURL} from './analyzer/provider-url.js';
import {researchProviderMetadata} from './research/provider-settings.js';
import {essentialEnvironment,PrivateInputWriteError,readRuntimeFile,renderRuntimeFile,runtimeEnvPath,writeRuntimeFile,type RuntimeFile} from './runtime-private-env.js';

type Consumer='provider'|'npm'|`customer:${string}`;
type Source='project-file'|'calling-environment'|'configuration'|'repository-remote';
type Evidence={configured?:string[];verified?:string[]};
export const runtimeDestination:unique symbol=Symbol('runtimeDestination');
export interface RuntimeInput extends WithReasonDetail {[runtimeDestination]?:ReasonInput;name:string;capability:string;destination:string;required:boolean;state:'present'|'missing'|'optional'|'unverified';source?:Source;reason:string}
export interface RuntimeSetupSummary {
 inputs:RuntimeInput[];
 template:WithReasonDetail&{path:string;state:'not-needed'|'available'|'pending'|'written';needsUpdate:boolean;imported:{name:string;source:Source}[];reason?:string};
 capabilities:(WithReasonDetail&{capability:string;configuration:'configured'|'pending';verification:'passed'|'not-run';reason:string})[];
 providerDiagnostic?:string;
}
interface Declaration extends WithReasonDetail {[runtimeDestination]?:ReasonInput;name:string;capability:string;destination:string;required:boolean;reason:string;comment:string;consumer?:Consumer;seed?:string;seedSource?:Source}
type InputNote=Extract<MessageKey,`artifact.env${string}`>;
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
  try{return {value:validateTrackerURL(tracker.reference).href.replace(/\/$/,''),source:'configuration'};}catch{return {};}
 }
 const result=await exec('git',['-C',root,'remote','-v'],{timeout:5000,maxBuffer:32_768,env:essentialEnvironment()}).catch(()=>undefined);
 const targets=new Set<string>();
 for(const line of result?.stdout.split('\n')??[]){
  const raw=/^\S+\s+(\S+)\s+\(fetch\)$/.exec(line)?.[1];if(!raw)continue;
  const ssh=/^(?:[^@\s]+@)?([A-Za-z0-9.-]+):([^/\s][^\s]*)$/.exec(raw);
  let value=ssh?'https://'+ssh[1]+'/'+ssh[2]:raw;
  try{
   const url=validateTrackerURL(value);
   if(tracker.system==='github'&&url.hostname!=='github.com')continue;
   if(tracker.system==='gitlab'&&['github.com','bitbucket.org'].includes(url.hostname))continue;
   if(!/^\/(?:[^/]+\/)+[^/]+\/?$/.test(url.pathname))continue;
   value=url.href.replace(/\/$/,'').replace(/\.git$/,'');targets.add(value);
  }catch{/* Untrusted or incompatible remotes are not runtime inputs. */}
 }
 return targets.size===1?{value:[...targets][0],source:'repository-remote'}:{};
}

async function declarations(root:string,options:SetupOptions,file:RuntimeFile,modelOverride?:string,onProviderError?:(reason:string)=>void):Promise<Declaration[]>{
 const inputs:Declaration[]=[];
 const locale=artifactLocale(options.documentLanguage);
 const add=(name:string,capability:string,required:boolean,note:InputNote|{key:InputNote;params:MessageParams},consumer?:Consumer,where:ReasonInput=local,seed?:string,seedSource?:Source)=>{
  const destination=reasonFallback(where);
  if(inputs.some(input=>input.name===name&&input.capability===capability&&input.destination===destination))return;
  const {key,params}=typeof note==='string'?{key:note,params:undefined}:note;
  const reason=makeReason(key,params);
  inputs.push({name,capability,required,reason:reason.fallback,[reasonDetail]:reason,[runtimeDestination]:where,
   comment:translate(locale,key,params),consumer,destination,seed,seedSource});
 };
 for(const [name,command] of Object.entries(options.customer?.commands??{}))for(const reference of command.envRefs)
  add(reference,'customer:'+name,true,{key:'artifact.envCustomerCommand',params:{name}},`customer:${name}`);
 for(const reference of options.customer?.envRefs??[])add(reference,'customer',true,'artifact.envCustomerWorkflow',undefined,makeReason('reason.runtime.agentDestination',{agents:options.agents.join(', ')}));
 for(const mcp of options.mcp??[]){
  const hosts=(mcp.agents??options.agents).filter(agent=>options.agents.includes(agent));
  if(hosts.length)for(const reference of [...(mcp.envRefs??[]),...(mcp.command?.envRefs??[]),...(mcp.bearerTokenEnv?[mcp.bearerTokenEnv]:[])])
   add(reference,'mcp:'+mcp.id,true,'artifact.envMcp',undefined,makeReason('reason.runtime.agentDestination',{agents:hosts.join(', ')}));
 }
 for(const reference of options.quality?.gitlab?.openwiki?.envRefs??[])
  add(reference,'gitlab:openwiki',true,'artifact.envCi',undefined,makeReason('reason.runtime.ciDestination'));
 const remoteCommands=['issue','mr','ci'].filter(name=>options.customer?.commands?.[name]);
 if(remoteCommands.length&&['gitlab','github'].includes(options.projectConventions?.tracker?.system??'')){
  const target=await remoteTarget(root,options);
  for(const name of remoteCommands)add('RIGUP_TRACKER_URL','customer:'+name,true,'artifact.envTracker',`customer:${name}`,local,target.value,target.source);
 }
 if(options.sdd==='openspec'||options.tools?.some(tool=>tool.install))add('RIGUP_NPM_REGISTRY','npm',false,'artifact.envRegistry','npm');
 if(options.backend==='native'||options.projectRules===true){
  const environment={...process.env};
  for(const name of providerVariables){const value=file.entries.get(name)?.value;if(value)environment[name]=value;}
  // Only provider selection metadata is read here; values remain in this module.
  const metadata=await researchProviderMetadata(root,modelOverride,options.model,environment).catch(error=>{
   if(!onProviderError)throw error;
   onProviderError(error instanceof Error?error.message:'Invalid research provider configuration');
  });
  if(metadata){
   const provider=metadata.identity.provider,prefix=provider==='anthropic'?'ANTHROPIC':'OPENAI';
   const key=metadata.identity.apiKeyEnv;
   add('RIGUP_PROVIDER','provider',true,'artifact.envProvider','provider',local,provider,process.env.RIGUP_PROVIDER?'calling-environment':'configuration');
   add(key,'provider',true,'artifact.envApiKey','provider');
   add('RIGUP_MODEL_ID','provider',true,'artifact.envModel','provider',local,metadata.identity.model,process.env.RIGUP_MODEL_ID||process.env[prefix+'_MODEL']?'calling-environment':'configuration');
   add('RIGUP_API_KEY_ENV','provider',false,'artifact.envKeyName','provider',local,key,process.env.RIGUP_API_KEY_ENV?'calling-environment':'configuration');
   add('RIGUP_BASE_URL','provider',false,'artifact.envGateway','provider',local,metadata.baseURL,process.env.RIGUP_BASE_URL||process.env[prefix+'_BASE_URL']?'calling-environment':'configuration');
   add('RIGUP_MAX_OUTPUT_TOKENS','provider',false,'artifact.envMaxTokens','provider',local,metadata.maxOutputTokens===undefined?undefined:String(metadata.maxOutputTokens),process.env.RIGUP_MAX_OUTPUT_TOKENS?'calling-environment':'configuration');
   for(const suffix of ['MODEL','BASE_URL'])if(effective(file,prefix+'_'+suffix).value)add(prefix+'_'+suffix,'provider',false,suffix==='MODEL'?'artifact.envProviderModel':'artifact.envProviderBaseUrl','provider');
  }
 }
 return inputs;
}

async function state(root:string,options:SetupOptions,evidence:Evidence={}){
 let providerDiagnostic:string|undefined;
 const file=await readRuntimeFile(root),declared=await declarations(root,options,file,undefined,reason=>{providerDiagnostic=reason;});
 const inputs:RuntimeInput[]=declared.map(input=>{
  const {name,capability,destination,required,reason}=input;
  const base={name,capability,destination,required,reason,[reasonDetail]:input[reasonDetail],[runtimeDestination]:input[runtimeDestination]};
  if(destination!==local)return {...base,state:'unverified'};
  if(file.problem){
   const detail=makeReason('reason.runtime.fixPrivateInput');
   return {...base,state:required?'missing':'optional',reason:detail.fallback,[reasonDetail]:detail};
  }
  const value=effective(file,name,input.seed,input.seedSource);
  return {...base,state:value.value?'present':required?'missing':'optional',...(value.source?{source:value.source}:{})};
 });
 const localInputs=declared.filter(input=>input.destination===local);
 const values=[...new Map(localInputs.map(input=>[input.name,{...input,...effective(file,input.name,input.seed,input.seedSource)}])).values()];
 const text=renderRuntimeFile(file,values,artifactLocale(options.documentLanguage));
 const capabilities=[...new Set([...declared.map(input=>input.capability),...options.agents.map(agent=>'host:'+agent),...(options.quality?.gitlab?['gitlab']:[])])].map(capability=>{
  const configured=!!(evidence.configured?.includes('*')||evidence.configured?.includes(capability));
  const verified=evidence.verified?.includes(capability)??false;
  const reason=makeReason(verified?'reason.runtime.verified':capability.startsWith('host:')?'reason.runtime.verifyAgent':
   capability.startsWith('gitlab')?'reason.runtime.verifyCi':'reason.runtime.verifyConnection');
  return {capability,configuration:configured?'configured' as const:'pending' as const,verification:verified?'passed' as const:'not-run' as const,
   reason:reason.fallback,[reasonDetail]:reason};
 });
 const summary:RuntimeSetupSummary={inputs,template:{path:local,state:file.problem?'pending':localInputs.length?'available':'not-needed',needsUpdate:!file.problem&&text!==file.text,imported:[],...(file.problem?{reason:file.problem,[reasonDetail]:file[reasonDetail]}:{})},capabilities,...(providerDiagnostic?{providerDiagnostic}:{})};
 return {file,values,text,summary};
}

export async function runtimeSetupSummary(root:string,options:SetupOptions,evidence?:Evidence):Promise<RuntimeSetupSummary>{
 return (await state(root,options,evidence)).summary;
}

export async function applyRuntimeInputs(root:string,options:SetupOptions,evidence?:Evidence):Promise<RuntimeSetupSummary>{
 const {file,values,text,summary}=await state(root,options,evidence);
 if(!summary.template.needsUpdate)return summary;
 try{await writeRuntimeFile(root,file,text);}
 catch(error){
  const reason=error instanceof PrivateInputWriteError?error.reason:makeReason('reason.runtime.writeFailed');
  summary.template.state='pending';summary.template.reason=reasonFallback(reason);summary.template[reasonDetail]=reason;
  return summary;
 }
 summary.template.state='written';summary.template.needsUpdate=false;
 summary.template.imported=values.flatMap(input=>input.value&&input.source&&input.source!=='project-file'?[{name:input.name,source:input.source}]:[]);
 return summary;
}

export async function runtimeEnvironment(root:string,options:SetupOptions,consumer:Consumer,modelOverride?:string):Promise<NodeJS.ProcessEnv>{
 const file=await readRuntimeFile(root);
 if(file.problem)throw new ReasonError(file[reasonDetail]??file.problem);
 const inputs=await declarations(root,options,file,consumer==='provider'?modelOverride:undefined,consumer==='provider'?undefined:()=>{}),environment=essentialEnvironment();
 for(const input of inputs.filter(input=>input.consumer===consumer)){
  const {value}=effective(file,input.name,input.seed,input.seedSource);
  if(value!==undefined)environment[input.name]=value;
 }
 return environment;
}

export async function selectedNpmRegistry(root:string):Promise<string|undefined>{
 const file=await readRuntimeFile(root);
 if(file.problem)throw new ReasonError(file[reasonDetail]??file.problem);
 const value=effective(file,'RIGUP_NPM_REGISTRY').value;
 if(!value)return;
 try{
  return normalizeNpmRegistry(value);
 }catch{throw Error('RIGUP_NPM_REGISTRY must use HTTPS or loopback HTTP and omit credentials, query, and fragment');}
}

export async function operationNpmRegistry(root:string,name:string,signal?:AbortSignal):Promise<string>{
 return effectiveNpmRegistry(root,name,await selectedNpmRegistry(root),signal);
}

export function writeRuntimeSummary(summary:RuntimeSetupSummary,write:(text:string)=>void):void{
 if(summary.providerDiagnostic)write(t('runtime.provider',{reason:summary.providerDiagnostic})+'\n');
 write(t('runtime.summary',{status:t(`status.${summary.template.state}`),path:summary.template.path})+'\n');
 if(summary.template.reason)write(t('runtime.pending',{reason:renderReason(summary.template[reasonDetail]??summary.template.reason)})+'\n');
 for(const input of summary.template.imported)write(t('runtime.imported',{name:input.name,source:t(`runtime.source.${input.source}`)})+'\n');
 for(const input of summary.inputs)if(input.state==='missing'||input.state==='unverified')write(t('runtime.missing',{
  capability:input.capability,name:input.name,status:t(`status.${input.state}`),path:renderReason(input[runtimeDestination]??input.destination),
 })+'\n');
 for(const capability of summary.capabilities)if(capability.verification==='not-run')write(t('runtime.unverified',{
  capability:capability.capability,status:t(`status.${capability.configuration}`),reason:renderReason(capability[reasonDetail]??capability.reason),
 })+'\n');
}
