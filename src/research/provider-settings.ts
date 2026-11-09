import {lstat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname,join} from 'node:path';
import {validateProviderBaseURL} from '../analyzer/provider-url.js';
import {privateDirectory} from '../generator/cache.js';
import {readDurableRecord} from '../private-record.js';
import type {OnboardingIO} from '../onboarding.js';
import {promptChoice} from '../prompt.js';
import type {SetupOptions} from '../types.js';

type Model=NonNullable<SetupOptions['model']>;
type Provider=Model['provider'];
interface PrivateProvider {provider:Provider;model?:string;apiKeyEnv?:string;baseURL?:string}
export interface ResearchProvider {identity:Model;apiKey:string;baseURL:string}

const providers:Provider[]=['anthropic','openai-compatible'];
const envNames:Record<Provider,{key:string;model:string;url:string;defaultURL:string}>={
 anthropic:{key:'ANTHROPIC_API_KEY',model:'ANTHROPIC_MODEL',url:'ANTHROPIC_BASE_URL',defaultURL:'https://api.anthropic.com'},
 'openai-compatible':{key:'OPENAI_API_KEY',model:'OPENAI_MODEL',url:'OPENAI_BASE_URL',defaultURL:'https://api.openai.com/v1'},
};
const envRef=/^[A-Z_][A-Z0-9_]*$/;
const nonEmpty=(value:unknown):value is string=>typeof value==='string'&&!!value.trim()&&value.length<=1024;
const validate=(settings:PrivateProvider)=>providers.includes(settings.provider)&&
 Object.keys(settings).every(key=>['provider','model','apiKeyEnv','baseURL'].includes(key))&&
 (settings.model===undefined||nonEmpty(settings.model))&&
 (settings.apiKeyEnv===undefined||typeof settings.apiKeyEnv==='string'&&envRef.test(settings.apiKeyEnv))&&
 (settings.baseURL===undefined||nonEmpty(settings.baseURL));

async function privateProvider(root:string):Promise<PrivateProvider|undefined>{
 const path=join(homedir(),'.config','rigup','provider.json');
 try{await lstat(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
 await privateDirectory(dirname(path),root);
 return await readDurableRecord<PrivateProvider>(path,'Private research provider configuration',validate);
}

export async function resolveResearchProvider(root:string,modelOverride?:string,legacy?:Model):Promise<ResearchProvider|undefined>{
 const settings=await privateProvider(root);
 const selected=process.env.RIGUP_PROVIDER?.trim();
 if(selected&&!providers.includes(selected as Provider))throw Error('RIGUP_PROVIDER must be anthropic or openai-compatible');
 const configured=(selected as Provider|undefined)||settings?.provider||legacy?.provider;
 const candidates=configured?[]:providers.filter(provider=>{
  const names=envNames[provider];
  return process.env[names.key]?.trim()&&(modelOverride||process.env.RIGUP_MODEL_ID?.trim()||process.env[names.model]?.trim());
 });
 if(candidates.length>1)throw Error('Set RIGUP_PROVIDER to choose between the configured providers');
 const provider=configured||candidates[0];
 if(!provider)return;
 const defaults=envNames[provider],privateSettings=settings?.provider===provider?settings:undefined;
 const legacySettings=legacy?.provider===provider?legacy:undefined;
 const model=(modelOverride??process.env.RIGUP_MODEL_ID??process.env[defaults.model]??privateSettings?.model??legacySettings?.model)?.trim();
 const apiKeyEnv=process.env.RIGUP_API_KEY_ENV??privateSettings?.apiKeyEnv??legacySettings?.apiKeyEnv??defaults.key;
 if(!envRef.test(apiKeyEnv))throw Error('RIGUP_API_KEY_ENV must name an environment variable');
 const url=process.env.RIGUP_BASE_URL??process.env[defaults.url]??privateSettings?.baseURL??defaults.defaultURL;
 const baseURL=validateProviderBaseURL(url).href;
 const apiKey=process.env[apiKeyEnv]?.trim();
 if(!model||!apiKey)return;
 if(!nonEmpty(model))throw Error('Research model ID is invalid');
 return {identity:{provider,model,apiKeyEnv},baseURL,apiKey};
}

export async function promptResearchProvider(io:OnboardingIO,modelOverride?:string):Promise<ResearchProvider|undefined>{
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
 let apiKey=process.env[defaults.key]?.trim();
 if(!apiKey){
  io.write('Enter an API key for this run only (Esc to use the agent)\n');
  apiKey=(await io.read(true))?.trim();
 }
 if(!apiKey||apiKey==='\x1b')return;
 return {identity:{provider,model,apiKeyEnv:defaults.key},baseURL,apiKey};
}
