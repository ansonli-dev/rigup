import {parse as parseToml} from 'smol-toml';
import {parseTree,createScanner,SyntaxKind,type Node,type ParseError} from 'jsonc-parser';
import {parseDocument,Parser,isMap,isSeq,isScalar,isAlias} from 'yaml';
import {extname} from 'node:path';
export const READ_POLICY_VERSION='6';
export const secretName=/(^\.env($|\.)|^(?:\.auth|\.netrc|_netrc|\.git-credentials|\.npmrc|\.pypirc|\.pgpass|\.dockercfg)(?:[.~].*)?$|\.(pem|key|p12|pfx|keystore)(?:\.(?:bak|old|backup|orig|save|tmp)|~)?$|credentials|id_rsa|id_ed25519)/i;
const sensitive=/token|password|passwd|secret|credential|authorization|api[-_]?key|private[-_]?key|^(?:auth|authentication|creds|cookies?|localStorage|sessionStorage)$/i;
const credentialFlag=/^--?(?:(?:(?:access|private|job|refresh|auth)[-_]?)?token|password|passwd|secret|client[-_]?secret|api[-_]?key|authorization|auth|user|u|proxy-user|oauth2-bearer|credentials?)$/i;
const credentialAssignment=/(?:token|password|passwd|secret|credentials?|creds|authorization|api[-_]?key|private[-_]?key)[\w-]*["']?\s*[:=]|(?:^|[\s"'])auth(?:entication)?["']?\s*[:=]/i;
function redactComment(token:string):string {
 if(!sensitive.test(token)&&!credentialAssignment.test(token)&&! /\b(?:auth(?:entication)?|cookies?|localStorage|sessionStorage|api\s+key|private\s+key|access\s+key)\b/i.test(token))return token;
 const prefix=token.startsWith('/*')?'/*':token.startsWith('//')?'//':'#';
 return prefix+' [REDACTED]'+(token.match(/\r\n|\r|\n/g)??[]).join('')+(prefix==='/*'?' */':'');
}
export function filterContent(path:string,raw:string):string {
 if(path.split(/[\\/]/).some(part=>secretName.test(part))) throw new Error('sensitive file denied');
 if(/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/.test(raw))throw Error('private key material denied');
 if(raw.includes('\0')) throw new Error('binary file denied');
 const extension=extname(path).toLowerCase();
 let text=raw;
 if(extension === '.toml') {
  const parsed=parseToml(raw);const secrets=new Set<unknown>();
  function collect(value:unknown,hidden=false):void {
   if(Array.isArray(value)){let next=false;for(const item of value){collect(item,hidden||next);next=typeof item==='string'&&credentialFlag.test(item);}}
   else if(value && typeof value === 'object') for(const [key,item] of Object.entries(value)) collect(item,hidden||sensitive.test(key)||key === 'env'||key === 'environment'||key === 'headers');
   else if((hidden||typeof value==='string'&&credentialAssignment.test(value)) && !(typeof value === 'string' && /^\$\{[A-Z_][A-Z0-9_]*\}$/.test(value))) secrets.add(value);
  }
  collect(parsed);
  // Tokenize only after the full document has passed TOML syntax validation.
  const tokens=/#.*$|"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'[^']*'/gm;
  text=raw.replace(tokens,token=>{
   if(token.startsWith('#')) return redactComment(token);
   let value:unknown;try {value=parseToml('value = '+token).value;}catch {throw new Error('unsupported TOML token');}
   if(!secrets.has(value)) return token;
   return '"[REDACTED]"'+'\n'.repeat((token.match(/\n/g)||[]).length);
  });
  if([...secrets].some(value=>typeof value !== 'string')) throw new Error('unsupported non-string sensitive TOML value');
 } else if(extension === '.jsonc') {
  const errors:ParseError[]=[];const tree=parseTree(raw,errors,{allowTrailingComma:true});
  if(errors.length || !tree) throw new Error('unsupported JSONC syntax');
  const spans:{start:number;end:number;replacement?:string}[]=[];
  function walk(node:Node,hidden=false):void {
   if(node.type === 'property') {
    const key=String(node.children?.[0].value);const value=node.children?.[1];
    if(value) walk(value,hidden||sensitive.test(key)||key === 'env'||key === 'environment'||key === 'headers');
   } else if(node.type==='array'){let next=false;for(const item of node.children??[]){walk(item,hidden||next);next=item.type==='string'&&credentialFlag.test(item.value);}}
   else if(['string','number','boolean','null'].includes(node.type) && (hidden||node.type==='string'&&credentialAssignment.test(node.value)) && !/^\$\{[A-Z_][A-Z0-9_]*\}$/.test(String(node.value))) spans.push({start:node.offset,end:node.offset+node.length});
   else for(const child of node.children||[]) walk(child,hidden);
  }
  walk(tree);
  const scanner=createScanner(raw,false);
  for(let kind=scanner.scan();kind!==SyntaxKind.EOF;kind=scanner.scan())if(kind===SyntaxKind.LineCommentTrivia||kind===SyntaxKind.BlockCommentTrivia){const start=scanner.getTokenOffset(),end=start+scanner.getTokenLength();const original=raw.slice(start,end),replacement=redactComment(original);if(replacement!==original)spans.push({start,end,replacement});}
  for(const span of spans.sort((a,b)=>b.start-a.start)) text=text.slice(0,span.start)+(span.replacement??'"[REDACTED]"')+text.slice(span.end);
 } else if(['.json','.yaml','.yml'].includes(extension)) {
  const doc=parseDocument(raw);if(doc.errors.length) throw new Error('unsupported configuration syntax');
  const spans:{start:number;end:number;replacement?:string}[]=[];
  function walk(node:any,hidden=false):void {
   if(isAlias(node)) throw new Error('unsupported YAML alias');
   if(isMap(node)) for(const pair of node.items) {
    const key=String(pair.key);walk(pair.value,hidden || sensitive.test(key) || key === 'env' || key === 'environment' || key === 'headers');
   }
   else if(isSeq(node)){let next=false;for(const item of node.items){walk(item,hidden||next);next=isScalar(item)&&typeof item.value==='string'&&credentialFlag.test(item.value);}}
   else if(isScalar(node) && (hidden||typeof node.value==='string'&&credentialAssignment.test(node.value)) && node.range && !/^\$\{[A-Z_][A-Z0-9_]*\}$/.test(String(node.value))) spans.push({start:node.range[0],end:node.range[1]});
  }
  walk(doc.contents);
  function comments(value:unknown):void {
   if(Array.isArray(value)){for(const item of value)comments(item);return;}
   if(!value||typeof value!=='object')return;
   const token=value as Record<string,unknown>;
   if(token.type==='comment'&&typeof token.offset==='number'&&typeof token.source==='string'){
    const replacement=redactComment(token.source);if(replacement!==token.source)spans.push({start:token.offset,end:token.offset+token.source.length,replacement});
   }else for(const item of Object.values(token))comments(item);
  }
  for(const token of new Parser().parse(raw))comments(token);
  for(const span of spans.sort((a,b)=>b.start-a.start)) {
   const original=text.slice(span.start,span.end);
   text=text.slice(0,span.start)+(span.replacement??'"[REDACTED]"'+'\n'.repeat((original.match(/\n/g)||[]).length))+text.slice(span.end);
  }
 } else if(credentialAssignment.test(raw) || /\[.*env.*\]/i.test(raw)) {
  // Unknown sensitive syntax cannot be safely exported using line heuristics.
  throw new Error('unsupported sensitive format');
 }
 return text.replace(/https?:\/\/[^\s"'<>]+/g,url=>{
  try {const parsed=new URL(url);if(parsed.username || parsed.password){parsed.username='';parsed.password='';}for(const key of [...parsed.searchParams.keys()]) if(sensitive.test(key)) parsed.searchParams.set(key,'[REDACTED]');return parsed.toString();}catch{return '[REDACTED-URL]';}
 });
}
