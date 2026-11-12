import {lstat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname,join} from 'node:path';
import {validateProviderBaseURL} from '../analyzer/provider-url.js';
import {isValidMaxOutputTokens} from '../analyzer/provider-loop.js';
import {privateDirectory} from '../generator/cache.js';
import {readDurableRecord} from '../private-record.js';
import type {OnboardingIO} from '../onboarding.js';
import {promptChoice} from '../prompt.js';
import type {SetupOptions} from '../types.js';

type Model=NonNullable<SetupOptions['model']>;
type Provider=Model['provider'];
interface PrivateProvider {provider:Provider;model?:string;apiKeyEnv?:string;baseURL?:string;maxOutputTokens?:number}
export interface ResearchProviderMetadata {identity:{provider:Provider;model?:string;apiKeyEnv:string};baseURL:string;maxOutputTokens?:number}
export interface ResearchProvider {identity:Model;apiKey:string;baseURL:string;maxOutputTokens?:number}

const providers:Provider[]=['anthropic','openai-compatible'];
const envNames:Record<Provider,{key:string;model:string;url:string;defaultURL:string}>={
 anthropic:{key:'ANTHROPIC_API_KEY',model:'ANTHROPIC_MODEL',url:'ANTHROPIC_BASE_URL',defaultURL:'https://api.anthropic.com'},
 'openai-compatible':{key:'OPENAI_API_KEY',model:'OPENAI_MODEL',url:'OPENAI_BASE_URL',defaultURL:'https://api.openai.com/v1'},
};
const envRef=/^[A-Z_][A-Z0-9_]*$/;
const nonEmpty=(value:unknown):value is string=>typeof value==='string'&&!!value.trim()&&value.length<=1024;
const validate=(settings:PrivateProvider)=>providers.includes(settings.provider)&&
 Object.keys(settings).every(key=>['provider','model','apiKeyEnv','baseURL','maxOutputTokens'].includes(key))&&
 (settings.model===undefined||nonEmpty(settings.model))&&
 (settings.apiKeyEnv===undefined||typeof settings.apiKeyEnv==='string'&&envRef.test(settings.apiKeyEnv))&&
 (settings.baseURL===undefined||nonEmpty(settings.baseURL));

async function privateProvider(root:string):Promise<PrivateProvider|undefined>{
 const path=join(homedir(),'.config','rigup','provider.json');
 try{await lstat(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
 await privateDirectory(dirname(path),root);
 const settings=await readDurableRecord<PrivateProvider>(path,'Private research provider configuration',validate);
 if(settings?.maxOutputTokens!==undefined&&!isValidMaxOutputTokens(settings.maxOutputTokens))throw Error('Private research provider configuration: maxOutputTokens must be a positive integer');
 return settings;
}

function outputTokenLimit(value:string|undefined):number|undefined {
 if(value===undefined)return;
 const parsed=/^\d+$/.test(value.trim())?Number(value.trim()):NaN;
 if(!isValidMaxOutputTokens(parsed))throw Error('RIGUP_MAX_OUTPUT_TOKENS must be a positive integer');
 return parsed;
}

export async function researchProviderMetadata(root:string,modelOverride?:string,projectModel?:Model,environment:NodeJS.ProcessEnv=process.env):Promise<ResearchProviderMetadata|undefined>{
 const settings=await privateProvider(root);
 const selected=environment.RIGUP_PROVIDER?.trim();
 if(selected&&!providers.includes(selected as Provider))throw Error('RIGUP_PROVIDER must be anthropic or openai-compatible');
 const configured=(selected as Provider|undefined)||settings?.provider||projectModel?.provider;
 const keyed=configured?[]:providers.filter(provider=>environment[envNames[provider].key]?.trim());
 const candidates=keyed.filter(provider=>{
  const names=envNames[provider];
  return modelOverride||environment.RIGUP_MODEL_ID?.trim()||environment[names.model]?.trim();
 });
 if(candidates.length>1)throw Error('Set RIGUP_PROVIDER to choose between the configured providers');
 // A sole key declares an incomplete provider; request resolution still requires its model.
 const provider=configured||candidates[0]||(keyed.length===1?keyed[0]:undefined);
 if(!provider)return;
 const defaults=envNames[provider],privateSettings=settings?.provider===provider?settings:undefined;
 const projectSettings=projectModel?.provider===provider?projectModel:undefined;
 const model=(modelOverride??environment.RIGUP_MODEL_ID??environment[defaults.model]??privateSettings?.model??projectSettings?.model)?.trim();
 const apiKeyEnv=environment.RIGUP_API_KEY_ENV??privateSettings?.apiKeyEnv??projectSettings?.apiKeyEnv??defaults.key;
 if(!envRef.test(apiKeyEnv))throw Error('RIGUP_API_KEY_ENV must name an environment variable');
 const url=environment.RIGUP_BASE_URL??environment[defaults.url]??privateSettings?.baseURL??defaults.defaultURL;
 const baseURL=validateProviderBaseURL(url).href;
 const maxOutputTokens=outputTokenLimit(environment.RIGUP_MAX_OUTPUT_TOKENS)??privateSettings?.maxOutputTokens;
 if(model!==undefined&&!nonEmpty(model))throw Error('Research model ID is invalid');
 return {identity:{provider,...(model===undefined?{}:{model}),apiKeyEnv},baseURL,...(maxOutputTokens===undefined?{}:{maxOutputTokens})};
}

export async function resolveResearchProvider(root:string,modelOverride?:string,projectModel?:Model,environment:NodeJS.ProcessEnv=process.env):Promise<ResearchProvider|undefined>{
 const metadata=await researchProviderMetadata(root,modelOverride,projectModel,environment);
 if(!metadata?.identity.model)return;
 const {provider,model,apiKeyEnv}=metadata.identity;
 const apiKey=environment[apiKeyEnv]?.trim();
 if(!apiKey)return;
 return {...metadata,identity:{provider,model,apiKeyEnv},apiKey};
}

export async function promptResearchProvider(io:OnboardingIO,modelOverride?:string,environment:NodeJS.ProcessEnv=process.env):Promise<ResearchProvider|undefined>{
 const later='Use Rigup MCP in the agent';
 io.write('Choose the provider for this run, or finish the setup and use Rigup MCP in the agent.\n');
 const answer=await promptChoice(io,[...providers,later],false,[later]);
 if(!Array.isArray(answer)||answer.length!==1||answer[0]===later)return;
 const provider=answer[0] as Provider,defaults=envNames[provider];
 if(!modelOverride)io.write('Model ID (Esc to use the agent)\n');
 const model=(modelOverride??await io.read())?.trim();
 if(!nonEmpty(model)||model==='\x1b')return;
 io.write('Provider base URL (Enter for '+defaults.defaultURL+', Esc to use the agent)\n');
 const url=await io.read();
 if(url===null||url==='\x1b')return;
 const baseURL=validateProviderBaseURL(url.trim()||defaults.defaultURL).href;
 let apiKey=environment[defaults.key]?.trim();
 if(!apiKey){
  io.write('Enter an API key for this run only (Esc to use the agent)\n');
  apiKey=(await io.read(true))?.trim();
 }
 if(!apiKey||apiKey==='\x1b')return;
 const maxOutputTokens=outputTokenLimit(environment.RIGUP_MAX_OUTPUT_TOKENS);
 return {identity:{provider,model,apiKeyEnv:defaults.key},baseURL,apiKey,...(maxOutputTokens===undefined?{}:{maxOutputTokens})};
}
