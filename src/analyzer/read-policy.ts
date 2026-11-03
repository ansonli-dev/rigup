import {parse as parseToml} from 'smol-toml';
import {parseTree,type Node,type ParseError} from 'jsonc-parser';
import {parseDocument,isMap,isSeq,isScalar,isAlias} from 'yaml';
import {basename,extname} from 'node:path';
export const READ_POLICY_VERSION='2';
export const secretName=/(^\.env($|\.)|\.(pem|key|p12|pfx|keystore)$|credentials|id_rsa|id_ed25519)/i;
const sensitive=/token|password|passwd|secret|authorization|api[-_]?key|private[-_]?key/i;
export function filterContent(path:string,raw:string):string {
 if(secretName.test(basename(path))) throw new Error('sensitive file denied');
 if(raw.includes('\0')) throw new Error('binary file denied');
 const extension=extname(path).toLowerCase();
 let text=raw;
 if(extension === '.toml') {
  const parsed=parseToml(raw);const secrets=new Set<unknown>();
  function collect(value:unknown,hidden=false):void {
   if(Array.isArray(value)) for(const item of value) collect(item,hidden);
   else if(value && typeof value === 'object') for(const [key,item] of Object.entries(value)) collect(item,hidden||sensitive.test(key)||key === 'env'||key === 'headers');
   else if(hidden && !(typeof value === 'string' && /^\$\{[A-Z_][A-Z0-9_]*\}$/.test(value))) secrets.add(value);
  }
  collect(parsed);
  // Tokenize only after the full document has passed TOML syntax validation.
  const tokens=/#.*$|"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'[^']*'/gm;
  text=raw.replace(tokens,token=>{
   if(token.startsWith('#')) return token;
   let value:unknown;try {value=parseToml('value = '+token).value;}catch {throw new Error('unsupported TOML token');}
   if(!secrets.has(value)) return token;
   return '"[REDACTED]"'+'\n'.repeat((token.match(/\n/g)||[]).length);
  });
  if([...secrets].some(value=>typeof value !== 'string')) throw new Error('unsupported non-string sensitive TOML value');
 } else if(extension === '.jsonc') {
  const errors:ParseError[]=[];const tree=parseTree(raw,errors,{allowTrailingComma:true});
  if(errors.length || !tree) throw new Error('unsupported JSONC syntax');
  const spans:{start:number;end:number}[]=[];
  function walk(node:Node,hidden=false):void {
   if(node.type === 'property') {
    const key=String(node.children?.[0].value);const value=node.children?.[1];
    if(value) walk(value,hidden||sensitive.test(key)||key === 'env'||key === 'headers');
   } else if(['string','number','boolean','null'].includes(node.type) && hidden && !/^\$\{[A-Z_][A-Z0-9_]*\}$/.test(String(node.value))) spans.push({start:node.offset,end:node.offset+node.length});
   else for(const child of node.children||[]) walk(child,hidden);
  }
  walk(tree);
  for(const span of spans.sort((a,b)=>b.start-a.start)) text=text.slice(0,span.start)+'"[REDACTED]"'+text.slice(span.end);
 } else if(['.json','.yaml','.yml'].includes(extension)) {
  const doc=parseDocument(raw);if(doc.errors.length) throw new Error('unsupported configuration syntax');
  const spans:{start:number;end:number}[]=[];
  function walk(node:any,hidden=false):void {
   if(isAlias(node)) throw new Error('unsupported YAML alias');
   if(isMap(node)) for(const pair of node.items) {
    const key=String(pair.key);walk(pair.value,hidden || sensitive.test(key) || key === 'env' || key === 'headers');
   }
   else if(isSeq(node)) for(const item of node.items) walk(item,hidden);
   else if(isScalar(node) && hidden && node.range && !/^\$\{[A-Z_][A-Z0-9_]*\}$/.test(String(node.value))) spans.push({start:node.range[0],end:node.range[1]});
  }
  walk(doc.contents);
  for(const span of spans.sort((a,b)=>b.start-a.start)) {
   const original=text.slice(span.start,span.end);
   text=text.slice(0,span.start)+'"[REDACTED]"'+'\n'.repeat((original.match(/\n/g)||[]).length)+text.slice(span.end);
  }
 } else if(/(?:token|password|passwd|secret|authorization|api[-_]?key|private[-_]?key)[\w-]*["']?\s*[:=]/i.test(raw) || /\[.*env.*\]/i.test(raw)) {
  // Unknown sensitive syntax cannot be safely exported using line heuristics.
  throw new Error('unsupported sensitive format');
 }
 return text.replace(/https?:\/\/[^\s"'<>]+/g,url=>{
  try {const parsed=new URL(url);if(parsed.username || parsed.password){parsed.username='';parsed.password='';}for(const key of [...parsed.searchParams.keys()]) if(sensitive.test(key)) parsed.searchParams.set(key,'[REDACTED]');return parsed.toString();}catch{return '[REDACTED-URL]';}
 });
}
