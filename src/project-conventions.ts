import {parseDocument,stringify} from 'yaml';
import {digest,sliceEvidence} from './analyzer/evidence.js';
import {secretName} from './analyzer/read-policy.js';
import {relativeTarget} from './generator/artifacts.js';
import {validateTopicId,type ConventionDraft,type Evidence} from './types.js';

export interface ConventionReceipt {topicId:string;scope:string;target:string}
export interface ConventionPage {
 path:string;
 topicId:string;
 title:string;
 scope:string;
 status:'draft'|'confirmed'|'not-applicable';
 sourceRef?:Evidence;
}

export const conventionKey=(topicId:string,scope:string)=>JSON.stringify([topicId,scope]);
export const documentTargetKey=(target:string)=>target.normalize('NFC').toLowerCase();
export const isConventionScope=(scope:unknown):scope is string=>typeof scope==='string'&&
 (scope==='.'||relativeTarget(scope)&&!/[\x00-\x1f\x7f:]/.test(scope)&&scope.split('/').every(Boolean));
export function validateConventionTarget(target:unknown):asserts target is string{
 if(typeof target!=='string'||target==='.'||!isConventionScope(target)||!target.endsWith('.md')||
  target.split('/').some(part=>['.git','node_modules','dist','.superpowers'].includes(part.toLowerCase())||secretName.test(part))||
  /^\.rigup\/(?:baseline|native|tools|check-results)(?:\/|$)/i.test(target))throw Error('Invalid convention document target');
}

export function validateConventionReceipts(value:unknown):ConventionReceipt[]{
 if(value===undefined)return [];
 if(!Array.isArray(value))throw Error('Invalid convention document receipts');
 const identities=new Set<string>(),targets=new Set<string>();
 for(const item of value){
  if(!item||!isConventionScope(item.scope))throw Error('Invalid convention receipt scope');
  const key=conventionKey(validateTopicId(item.topicId),item.scope);
  validateConventionTarget(item.target);
  const target=documentTargetKey(item.target);
  if(identities.has(key)||targets.has(target))throw Error('Duplicate convention receipt');
  identities.add(key);targets.add(target);
 }
 return value;
}

export function renderConventionSeed(draft:ConventionDraft):{target:string;content:string}{
 const topicId=validateTopicId(draft.topicId);
 if(!isConventionScope(draft.scope))throw Error('Invalid convention scope');
 const target='conventions/'+topicId+'--'+digest(draft.scope)+'.md';
 const content='---\n'+stringify({
  rigup:'team-convention',version:1,topicId,title:draft.title,scope:draft.scope,status:'draft',
  questions:draft.questions,verification:'',result:'',
 })+'---\n';
 return {target,content};
}

export function readConventionDocument(path:string,raw:string,registered=false):{page?:ConventionPage;researchText:string;warnings:string[]}{
 const lines=raw.split('\n');
 const opening=lines[0].trim()==='---';
 const closing=opening?lines.findIndex((line,index)=>index>0&&line.trim()==='---'):-1;
 const header=opening?lines.slice(1,closing<0?undefined:closing).join('\n'):'';
 const document=opening?parseDocument(header):undefined;
 const marked=document?.get('rigup')==='team-convention'||
  /(?:^|[{,])\s*(?:rigup|'rigup'|"rigup")\s*:\s*['"]?team-convention(?:['"\s#,}]|$)/m.test(header);
 if(!registered&&!marked)return {researchText:raw,warnings:[]};
 const blank=lines.map(()=> '').join('\n');
 const invalid=()=>({researchText:blank,warnings:[path+': convention metadata or confirmation unavailable; review the customer document']});
 if(closing<1)return invalid();
 try{
  if(!document||document.errors.length||document.warnings.length)return invalid();
  const value=document.toJS();
  if(value?.rigup!=='team-convention'||value.version!==1||typeof value.title!=='string'||!value.title.trim()||
   value.title.length>1000||/[\x00-\x1f\x7f]/.test(value.title)||!isConventionScope(value.scope)||
   !['draft','confirmed','not-applicable'].includes(value.status))return invalid();
  const page:ConventionPage={path,topicId:validateTopicId(value.topicId),title:value.title,scope:value.scope,status:value.status};
  if(page.status==='draft')return {page,researchText:blank,warnings:[]};
  const body=lines.slice(closing+1).join('\n').trim();
  if(!body||/^(?:\s|[-_*#>.])*(?:TODO|TBD|placeholder|待填写|待确认|待补充)[.!。\s]*$/i.test(body))return invalid();
  if(page.status==='not-applicable')return {page,researchText:blank,warnings:[]};
  const researchLines=lines.map((line,index)=>index<=closing?'':line);
  const start=researchLines.findIndex(line=>line.trim())+1;
  const end=Math.min(lines.length,start+47);
  page.sourceRef=sliceEvidence(path,researchLines,start,end).evidence;
  return {page,researchText:researchLines.join('\n'),warnings:[]};
 }catch{return invalid();}
}
