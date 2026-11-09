import {parseDocument,isSeq} from 'yaml';
import {lstat,realpath} from 'node:fs/promises';
import {isAbsolute,relative,resolve,sep} from 'node:path';
import type {Ownership} from '../managed-input.js';
import {relativeTarget} from '../generator/artifacts.js';
import {jsonValue,editJson,tomlRange,editToml} from '../integrations/agents/config-edit.js';
export function validateOwnership(selector:Ownership):void {
 if(!selector||!['file','block','json-key','toml-table'].includes(selector.kind))throw new Error('invalid ownership selector');
 if(selector.kind==='block'&&selector.insert&&(selector.insert.kind!=='yaml-sequence'||selector.insert.key!=='include'))throw new Error('unsupported block insertion anchor');
 if(selector.kind==='block'&&(!selector.start||!selector.end||selector.start===selector.end))throw new Error('invalid ownership markers');
 if((selector.kind==='json-key'||selector.kind==='toml-table')&&(!Array.isArray(selector.path)||!selector.path.length||selector.path.some(p=>typeof p!=='string'||!p||['__proto__','constructor','prototype'].includes(p))))throw new Error('invalid ownership key path');
}
function blockRange(text:string,o:Extract<Ownership,{kind:'block'}>):{start:number;end:number}|undefined {
 const start=text.indexOf(o.start),end=text.indexOf(o.end);
 if(start<0&&end<0)return;
 if(start<0||end<start||text.indexOf(o.start,start+o.start.length)>=0||text.indexOf(o.end,end+o.end.length)>=0)throw new Error('ownership markers malformed or ambiguous');
 let last=end+o.end.length;if(text.slice(last,last+2)==='\r\n')last+=2;else if(text[last]==='\n')last++;
 return {start,end:last};
}
export function ownedContent(text:string|undefined,selector:Ownership):string|undefined {
 validateOwnership(selector);if(text===undefined)return;
 if(selector.kind==='file')return text;
 if(selector.kind==='json-key')return jsonValue(text,selector.path);
 const range=selector.kind==='block'?blockRange(text,selector):tomlRange(text,selector.path);
 return range?text.slice(range.start,range.end):undefined;
}
export function replaceOwned(text:string|undefined,selector:Ownership,next:string|undefined):string|undefined {
 validateOwnership(selector);if(selector.kind==='file')return next;
 if(selector.kind==='json-key')return editJson(text??'{}\n',selector.path,next);
 if(selector.kind==='toml-table')return editToml(text??'',selector.path,next);
 const range=blockRange(text??'',selector);
 if(!range&&selector.insert&&next!==undefined){
  const doc=parseDocument(text??'');if(doc.errors.length)throw new Error('YAML configuration invalid');const node=doc.get(selector.insert.key,true);
  if(!isSeq(node)||node.flow||!node.range)throw new Error('YAML include requires manual block-sequence normalization');
  const end=node.range[2];return (text??'').slice(0,end)+((text??'')[end-1]==='\n'?'':'\n')+next+(text??'').slice(end);
 }
 return range?(text??'').slice(0,range.start)+(next??'')+(text??'').slice(range.end):(text??'')+(next===undefined?'':(text&&!text.endsWith('\n')?'\n':'')+next);
}
export async function targetPath(root:string,target:string):Promise<string>{
 if(!relativeTarget(target))throw new Error('target escapes root');
 root=await realpath(root);const destination=resolve(root,target);
 const within=relative(root,destination);
 if(!within||within==='..'||within.startsWith('..'+sep)||isAbsolute(within))throw new Error('target escapes root');
 let current=root;
 for(const part of target.split('/')){
  current=resolve(current,part);
  try{
   const st=await lstat(current);
   if(st.isSymbolicLink())throw new Error('target symlink denied');
   if(current!==destination&&!st.isDirectory())throw new Error('target parent not directory');
   if(process.platform==='win32'&&(await realpath(current)).toLowerCase()!==current.toLowerCase())throw new Error('Windows target aliases are not allowed');
  }catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 }
 return current;
}
export function selectorsOverlap(a:Ownership,b:Ownership):boolean {
 if(a.kind==='file'||b.kind==='file')return true;
 if(a.kind!==b.kind)return true;
 if(a.kind==='block'&&b.kind==='block')return a.start===b.start||a.end===b.end;
 if('path' in a&&'path' in b)return a.path.slice(0,Math.min(a.path.length,b.path.length)).every((v,i)=>v===b.path[i]);
 return true;
}
