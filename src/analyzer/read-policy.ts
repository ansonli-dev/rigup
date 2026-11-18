import {parse as parseToml} from 'smol-toml';
import {parseTree,createScanner,SyntaxKind,type Node,type ParseError} from 'jsonc-parser';
import {parseDocument,Parser,isMap,isSeq,isScalar,isAlias} from 'yaml';
import {extname} from 'node:path';
export const READ_POLICY_VERSION='8';
export const secretName=/(^\.env($|\.)|^(?:\.auth|\.netrc|_netrc|\.git-credentials|\.npmrc|\.pypirc|\.pgpass|\.dockercfg)(?:[.~].*)?$|\.(pem|key|p12|pfx|keystore)(?:\.(?:bak|old|backup|orig|save|tmp)|~)?$|credentials|id_rsa|id_ed25519)/i;
const envExample=/^\.env\.example$/i;
export const evidenceSecretName=(name:string)=>secretName.test(name)&&!envExample.test(name);
const sensitive=/token|password|passwd|secret|credential|authorization|api[-_]?key|private[-_]?key|^(?:auth|authentication|creds|cookies?|set[-_]?cookie|localStorage|sessionStorage)$/i;
const credentialFlag=/^--?(?:(?:(?:access|private|job|refresh|auth)[-_]?)?token|password|passwd|secret|client[-_]?secret|api[-_]?key|authorization|auth|user|u|proxy-user|oauth2-bearer|cookies?|b|credentials?)$/i;
const credentialAssignment=/(?:token|password|passwd|secret|credentials?|creds|authorization|api[-_]?key|private[-_]?key)[\w-]*["']?\s*[:=]|(?:^|[\s"'])auth(?:entication)?["']?\s*[:=]/i;
const structuredCredentialAssignment=(value:string)=>credentialAssignment.test(value)||/(?:set[-_]?)?cookies?[\"']?\s*[:=]/i.test(value);
function redactComment(token:string):string {
 if(!sensitive.test(token)&&!credentialAssignment.test(token)&&! /\b(?:auth(?:entication)?|cookies?|localStorage|sessionStorage|api\s+key|private\s+key|access\s+key)\b/i.test(token))return token;
 const prefix=token.startsWith('/*')?'/*':token.startsWith('//')?'//':'#';
 return prefix+' [REDACTED]'+(token.match(/\r\n|\r|\n/g)??[]).join('')+(prefix==='/*'?' */':'');
}
function filterEnvExample(raw:string):string {
 const entry=/^([ \t]*(?:export[ \t]+)?([a-z_]\w*)[ \t]*=[ \t]*)("(?:\\[\s\S]|[^"\\])*"|'[^']*'|\x60[^\x60]*\x60|[^#\r\n]*)([ \t]*#[^\r\n]*)?$/gim;
 const placeholder=/^(?:\$\{[A-Z_]\w*\}|\$[A-Z_]\w*|<[\w -]+>|(?:your|example|placeholder)[-_][\w-]+|change[-_]?me|replace[-_]?me)$/i;
 let result='',offset=0;
 const comments=(text:string)=>{
  if(text.split(/\r?\n/).some(line=>line.trim()&&!line.trimStart().startsWith('#')))throw Error('unsupported env example syntax');
  return text.replace(/#[^\r\n]*/g,redactComment);
 };
 for(const match of raw.matchAll(entry)){
  result+=comments(raw.slice(offset,match.index));
  const [,prefix,key,value,comment]=match;
  const unquoted=value.trim().replace(/^(['"\x60])([\s\S]*)\1$/,'$2');
  const sensitiveValue=sensitive.test(key)||structuredCredentialAssignment(unquoted);
  const visible=sensitiveValue&&unquoted&&!placeholder.test(unquoted)?'"[REDACTED]"'+(value.match(/\r\n|\r|\n/g)??[]).join(''):value;
  result+=prefix+visible+(comment?redactComment(comment.trimStart()):'');
  offset=match.index+match[0].length;
 }
 return result+comments(raw.slice(offset));
}

function filterProse(raw:string):string {
 const lines=raw.split('\n'),unchecked:string[]=[];
 const assignment=/^([ \t]*)(["']?)([A-Za-z_][\w.-]*)\2([ \t]*[:=][ \t]*)(.*)$/;
 for(let index=0;index<lines.length;index++){
  const match=assignment.exec(lines[index]);
  if(!match||!sensitive.test(match[3])){unchecked.push(lines[index]);continue;}
  const [,indent,quote,key,separator,remainder]=match;
  const value=remainder.trim();
  lines[index]=indent+quote+key+quote+separator+'[REDACTED]';
  if(/^[|>][+\d-]?(?:\s+#.*)?$/.test(value)||!value){
   while(index+1<lines.length&&(!lines[index+1].trim()||/^[ \t]*/.exec(lines[index+1])![0].length>indent.length))lines[++index]='';
   continue;
  }
  if(/^[\[{]/.test(value)){
   try{JSON.parse(value);}catch{throw Error('unsupported sensitive format');}
  }
  const delimiter=/^("|'|\x60)\1\1/.exec(value)?.[0]??(/^["'\x60]/.test(value)?value[0]:undefined);
  const closes=(text:string)=>delimiter&&text.replace(/\\[\s\S]/g,'').includes(delimiter);
  if(delimiter&&!closes(value.slice(delimiter.length))){
   while(index+1<lines.length){
    const closed=closes(lines[index+1]);
    lines[++index]='';
    if(closed)break;
   }
  }
 }
 if(credentialAssignment.test(unchecked.join('\n')))throw Error('unsupported sensitive format');
 return lines.join('\n');
}

export function filterContent(path:string,raw:string):string {
 const parts=path.split(/[\\/]/);
 if(parts.some(evidenceSecretName)) throw new Error('sensitive file denied');
 if(/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/.test(raw))throw Error('private key material denied');
 if(raw.includes('\0')) throw new Error('binary file denied');
 const extension=extname(path).toLowerCase();
 let text=raw;
 if(envExample.test(parts.at(-1)??'')){
  text=filterEnvExample(raw);
 }else if(extension === '.toml') {
  const parsed=parseToml(raw);const secrets=new Set<unknown>();
  function collect(value:unknown,hidden=false):void {
   if(Array.isArray(value)){let next=false;for(const item of value){collect(item,hidden||next);next=typeof item==='string'&&credentialFlag.test(item);}}
   else if(value && typeof value === 'object') for(const [key,item] of Object.entries(value)) collect(item,hidden||sensitive.test(key)||key === 'env'||key === 'environment'||key === 'headers');
   else if((hidden||typeof value==='string'&&structuredCredentialAssignment(value)) && !(typeof value === 'string' && /^\$\{[A-Z_][A-Z0-9_]*\}$/.test(value))) secrets.add(value);
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
 } else if(extension === '.jsonc'||extension === '.json') {
  const errors:ParseError[]=[];const tree=parseTree(raw,errors,{allowTrailingComma:true});
  if(errors.length || !tree) throw new Error('unsupported JSONC syntax');
  const spans:{start:number;end:number;replacement?:string}[]=[];
  function walk(node:Node,hidden=false):void {
   if(node.type === 'property') {
    const key=String(node.children?.[0].value);const value=node.children?.[1];
    if(value) walk(value,hidden||sensitive.test(key)||key === 'env'||key === 'environment'||key === 'headers');
   } else if(node.type==='array'){let next=false;for(const item of node.children??[]){walk(item,hidden||next);next=item.type==='string'&&credentialFlag.test(item.value);}}
   else if(['string','number','boolean','null'].includes(node.type) && (hidden||node.type==='string'&&structuredCredentialAssignment(node.value)) && !/^\$\{[A-Z_][A-Z0-9_]*\}$/.test(String(node.value))) spans.push({start:node.offset,end:node.offset+node.length});
   else for(const child of node.children||[]) walk(child,hidden);
  }
  walk(tree);
  const scanner=createScanner(raw,false);
  for(let kind=scanner.scan();kind!==SyntaxKind.EOF;kind=scanner.scan())if(kind===SyntaxKind.LineCommentTrivia||kind===SyntaxKind.BlockCommentTrivia){const start=scanner.getTokenOffset(),end=start+scanner.getTokenLength();const original=raw.slice(start,end),replacement=redactComment(original);if(replacement!==original)spans.push({start,end,replacement});}
  for(const span of spans.sort((a,b)=>b.start-a.start)) text=text.slice(0,span.start)+(span.replacement??'"[REDACTED]"')+text.slice(span.end);
 } else if(['.yaml','.yml'].includes(extension)) {
  const doc=parseDocument(raw);if(doc.errors.length) throw new Error('unsupported configuration syntax');
  const spans:{start:number;end:number;replacement?:string}[]=[];
  function walk(node:any,hidden=false):void {
   if(isAlias(node)) throw new Error('unsupported YAML alias');
   if(isMap(node)) for(const pair of node.items) {
    const key=String(pair.key);walk(pair.value,hidden || sensitive.test(key) || key === 'env' || key === 'environment' || key === 'headers');
   }
   else if(isSeq(node)){let next=false;for(const item of node.items){walk(item,hidden||next);next=isScalar(item)&&typeof item.value==='string'&&credentialFlag.test(item.value);}}
   else if(isScalar(node) && (hidden||typeof node.value==='string'&&structuredCredentialAssignment(node.value)) && node.range && !/^\$\{[A-Z_][A-Z0-9_]*\}$/.test(String(node.value))) spans.push({start:node.range[0],end:node.range[1]});
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
 } else if(/\.(?:mdx?|rst|adoc|txt)$/.test(extension)&&credentialAssignment.test(raw)){
  text=filterProse(raw);
 } else {
  const declarations=/^\s*(?:readonly\s+)?[$\w]+\??\s*:\s*(?:string|number|boolean|undefined|unknown|never|symbol|bigint)(?:\[\])?\s*;[ \t]*$/gm;
  const values=/\.(?:[cm]?ts|tsx)$/.test(extension)?raw.replace(declarations,''):raw;
  // Unknown sensitive syntax cannot be safely exported using line heuristics.
  if(credentialAssignment.test(values)||/\[.*env.*\]/i.test(values))throw new Error('unsupported sensitive format');
 }
 return text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi,url=>{
  try {const parsed=new URL(url);if(parsed.username || parsed.password){parsed.username='';parsed.password='';}for(const key of [...parsed.searchParams.keys()]) if(sensitive.test(key)) parsed.searchParams.set(key,'[REDACTED]');return parsed.toString();}catch{return '[REDACTED-URL]';}
 });
}
