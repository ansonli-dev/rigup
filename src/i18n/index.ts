import {AsyncLocalStorage} from 'node:async_hooks';
import {en} from './en.js';
import {zhCN} from './zh-CN.js';

export type Locale='en'|'zh-CN';
export type MessageKey=keyof typeof en;
export type MessageParams=Record<string,string|number>;

const catalogues={en,'zh-CN':zhCN};
let defaultLocale:Locale='en';
const activeLocale=new AsyncLocalStorage<{locale:Locale}>();

export function artifactLocale(documentLanguage:string|undefined):Locale{
 return /^zh(?:-|$)/i.test(documentLanguage??'')?'zh-CN':'en';
}

export function resolveLocale(documentLanguage:string|undefined,env:NodeJS.ProcessEnv):Locale{
 if(documentLanguage&&documentLanguage!=='auto')return artifactLocale(documentLanguage);
 const system=env.LC_ALL||env.LC_MESSAGES||env.LANG||Intl.DateTimeFormat().resolvedOptions().locale;
 return /^zh(?:[-_.@]|$)/i.test(system)?'zh-CN':'en';
}

export function withLocale<T>(locale:Locale,run:()=>T):T{
 return activeLocale.run({locale},run);
}

export function setLocale(locale:Locale):void{
 const current=activeLocale.getStore();
 if(current)current.locale=locale;
 else defaultLocale=locale;
}

export function currentLocale():Locale{
 return activeLocale.getStore()?.locale??defaultLocale;
}

export function translate(locale:Locale,key:MessageKey,params:MessageParams={}):string{
 return catalogues[locale][key].replace(/\{(\w+)\}/g,(match,name:string)=>
  Object.hasOwn(params,name)?String(params[name]):match);
}

export function t(key:MessageKey,params?:MessageParams):string{
 return translate(currentLocale(),key,params);
}
