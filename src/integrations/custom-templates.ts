import {readFile,stat} from 'node:fs/promises';
import {resolve,isAbsolute,posix} from 'node:path';
import {safePath,digest} from '../analyzer/evidence.js';
export interface CustomerTemplateAsset {logicalId:string;target:string;content:string;ownership:{kind:'file'};consumer:string;source:{kind:'customer-template';ref:string;digest:string}}
export async function renderCustomerTemplate(root:string,input:{source:string;target:string;values?:Record<string,string|number|boolean>},allowedRoots:string[],consumer:string):Promise<CustomerTemplateAsset>{
 const target=input.target;
 if(!target || isAbsolute(target) || target.includes('\\') || target.split('/').some(p=>p === '..'||p === '.') || posix.normalize(target) !== target || !target.endsWith('.md') || target.endsWith('/SKILL.md') || !allowedRoots.some(base=>target.startsWith(base.replace(/\/$/,'')+'/'))) throw new Error('template.target: outside allowed context targets or fixed flow');
 if(!consumer.trim()) throw new Error('template.consumer: required');
 if(target.includes('/skills/') && !/\/(references|assets)\//.test(target)) throw new Error('template.target: fixed flow cannot be replaced');
 const source=resolve(root,input.source);
 const sourcePath=await safePath('/',source);
 if((await stat(sourcePath)).size>1_000_000) throw new Error('template.source: exceeds size budget');
 const text=await readFile(sourcePath,'utf8');
 if(text.includes('\0')) throw new Error('template.source: binary templates unsupported');
 const values=input.values ?? {};
 const content=text.replace(/\{\{([\s\S]*?)\}\}/g,(_,name:string)=>{
  if(!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) throw new Error('template.placeholder: expressions unsupported');
  if(!Object.hasOwn(values,name)) throw new Error('template.values.'+name+': required');
  const value=values[name];
  if(!['string','number','boolean'].includes(typeof value) || typeof value === 'number' && !Number.isFinite(value)) throw new Error('template.values.'+name+': scalar required');
  return String(value);
 });
 if(/\{\{|\}\}/.test(content)) throw new Error('template.placeholder: unresolved or malformed placeholder');
 return {logicalId:'template:'+target,target,content,ownership:{kind:'file'},consumer,source:{kind:'customer-template',ref:source,digest:digest(text+'\0'+JSON.stringify(Object.entries(values).sort()))}};
}
