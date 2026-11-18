import {parse as parseToml} from 'smol-toml';
import {parseTree,createScanner,SyntaxKind,type Node,type ParseError} from 'jsonc-parser';
import {parseDocument,Parser,isMap,isSeq,isScalar,isAlias} from 'yaml';
import {extname} from 'node:path';
export const READ_POLICY_VERSION='9';
export const secretName=/(^\.env($|\.)|^(?:\.auth|\.netrc|_netrc|\.git-credentials|\.npmrc|\.pypirc|\.pgpass|\.dockercfg)(?:[.~].*)?$|\.(pem|key|p12|pfx|keystore)(?:\.(?:bak|old|backup|orig|save|tmp)|~)?$|credentials|id_rsa|id_ed25519)/i;
const envExample=/^\.env\.example$/i;
export const evidenceSecretName=(name:string)=>secretName.test(name)&&!envExample.test(name);
const sensitive=/token|password|passwd|secret|credential|authorization|api[-_]?key|private[-_]?key|^(?:auth|authentication|creds|cookies?|set[-_]?cookie|localStorage|sessionStorage)$/i;
const credentialFlag=/^--?(?:(?:(?:access|private|job|refresh|auth)[-_]?)?token|password|passwd|secret|client[-_]?secret|api[-_]?key|authorization|auth|user|u|proxy-user|oauth2-bearer|cookies?|b|credentials?)$/i;
const credentialAssignment=/(?:token|password|passwd|secret|credentials?|creds|authorization|api[-_]?key|private[-_]?key)[\w-]*["']?\s*[:=]|(?:^|[\s"'])auth(?:entication)?["']?\s*[:=]/i;
const structuredAssignment=new RegExp(credentialAssignment.source+'|(?:set[-_]?)?cookies?["\']?\\s*[:=]','i');
const structuredCredentialAssignment=(value:string)=>structuredAssignment.test(value);
const environmentReference=/\[.*env.*\]/i;
const environmentSection=/^[ \t]*(?:[-*+>][ \t]+)?\[.*env.*\][ \t]*(?:[#;].*)?$/i;
const proseAssignment=/^([ \t]*)(["']?)([A-Za-z_][\w.-]*)\2([ \t]*[:=][ \t]*)(.*)$/;
const inlineLiterals=/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\\./g;
const inlineClosers=new Map([['(',')'],['[',']'],['{','}']]);
const atSameLineEnding=(line:string,body:string)=>body+(line.endsWith('\r')?'\r':'');

function closedInlineValue(line:string,matches:RegExpMatchArray[],environment:RegExpExecArray|null):boolean {
 const syntax=line.replace(inlineLiterals,literal=>'x'.repeat(literal.length));
 if(/["'`]|<<|(?:\\|[+?:=|]|&&)\s*$/.test(syntax))return false;
 // A matched selector inside a closed string cannot continue into a surrounding code block.
 const outside=matches.filter(match=>syntax[match.index!+match[0].length-1]!=='x');
 const start=outside[0]?.index??(environment&&syntax[environment.index]==='['?environment.index:undefined);
 if(start===undefined)return true;
 const last=outside.at(-1);
 if(last){
  const value=syntax.slice(last.index!+last[0].length).trim();
  if(!value||/^[|>&*!](?!=)/.test(value))return false;
 }
 const pending:string[]=[];
 for(const [token] of syntax.slice(start).matchAll(/[()[\]{}]/g)){
  const closer=inlineClosers.get(token);
  if(closer)pending.push(closer);
  else if(pending.length&&pending.pop()!==token)return false;
 }
 return pending.length===0;
}

// Scan complete literals as well so quoted examples of delimiters never open a span.
const multilineTokens=/"""[^]*?(?:"""|$)|'''[^]*?(?:'''|$)|\/\*[^]*?(?:\*\/|$)|(?<!`)`(?!`)(?:\\[^]|[^`\\])*(?:`(?!`)|$)|"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'/g;
const emptyBatchAssignment=/^[ \t]*@?set[ \t]+(?:"[A-Za-z_]\w*="|[A-Za-z_]\w*=)[ \t]*$/i;

function redactInline(lines:string[],assignment:RegExp,options:{keep?:(index:number)=>boolean;batch?:boolean}={}):string {
 const assignments=new RegExp(assignment.source,'gi');
 const unchecked=lines.slice();
 const multiline=[...lines.join('\n').matchAll(multilineTokens)]
  .filter(([token])=>token.includes('\n'))
  .map(({0:token,index})=>({start:index!,end:index!+token.length}));
 let offset=0,span=0;
 const visible=lines.map((raw,index)=>{
  const start=offset;
  offset+=raw.length+1;
  const line=raw.replace(/\r$/,'');
  if(options.keep?.(index)){unchecked[index]='[REDACTED]';return raw;}
  const matches=[...line.matchAll(assignments)];
  const environment=environmentReference.exec(line);
  if(!matches.length&&!environment)return raw;
  while(multiline[span]&&multiline[span].end<=start)span++;
  const inMultiline=multiline[span]&&multiline[span].start<start+line.length;
  const clearsBatchVariable=options.batch&&emptyBatchAssignment.test(line);
  if(inMultiline||environmentSection.test(line)||!clearsBatchVariable&&!closedInlineValue(line,matches,environment))
   throw Error('unsupported sensitive format');
  const standalone=proseAssignment.exec(line.replace(/^([ \t]*)(?:[-*+>]|\d+[.)])[ \t]+/,'$1'));
  if(standalone&&sensitive.test(standalone[3])){
   // An indented continuation can contain the value even after a nonempty first line.
   let next=index+1;
   while(next<lines.length&&!lines[next].trim())next++;
   if((/^[ \t]*/.exec(lines[next]??'')?.[0].length??0)>standalone[1].length)throw Error('unsupported sensitive format');
  }
  unchecked[index]='[REDACTED]';
  return atSameLineEnding(raw,'[REDACTED]');
 });
 // A credential key and its separator can fall on different lines.
 if(assignment.test(unchecked.join('\n')))throw Error('unsupported sensitive format');
 return visible.join('\n');
}
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
 const lines=raw.split('\n'),handled=new Set<number>();
 for(let index=0;index<lines.length;index++){
  const match=proseAssignment.exec(lines[index].replace(/\r$/,''));
  if(!match||!sensitive.test(match[3]))continue;
  handled.add(index);
  const [,indent,quote,key,separator,remainder]=match;
  const value=remainder.trim();
  lines[index]=atSameLineEnding(lines[index],indent+quote+key+quote+separator+'[REDACTED]');
  if(/^[&*!]/.test(value)||value.endsWith('\\')||
     /^[|>]/.test(value)&&!/^[|>](?:[1-9][+-]?|[+-][1-9]?)?(?:\s+#.*)?$/.test(value))throw Error('unsupported sensitive format');
  if(/^[\[{]/.test(value)){
   try{JSON.parse(value);}catch{throw Error('unsupported sensitive format');}
  }
  const delimiter=/^("|'|\x60)\1\1/.exec(value)?.[0]??(/^["'\x60]/.test(value)?value[0]:undefined);
  const closes=(text:string)=>delimiter&&text.replace(/\\[\s\S]/g,'').includes(delimiter);
  if(delimiter&&!closes(value.slice(delimiter.length))){
   while(index+1<lines.length){
    const closed=closes(lines[index+1]);
    index++;
    lines[index]=atSameLineEnding(lines[index],'');
    if(closed)break;
   }
  }
  while(index+1<lines.length&&(!lines[index+1].trim()||/^[ \t]*/.exec(lines[index+1])![0].length>indent.length)){
   index++;
   lines[index]=atSameLineEnding(lines[index],'');
  }
  if(!value&&/^\s*-(?:\s|$)/.test(lines[index+1]??''))throw Error('unsupported sensitive format');
 }
 return redactInline(lines,structuredAssignment,{keep:index=>handled.has(index)});
}

export const filterContent=(path:string,raw:string)=>filter(path,raw,false);

// Legacy apply snapshots depend on the v0.8 inventory's file admission.
export const filterLegacyInstallationContent=(path:string,raw:string)=>filter(path,raw,true);

function filter(path:string,raw:string,legacy:boolean):string{
 const parts=path.split(/[\\/]/);
 if(parts.some(legacy?part=>secretName.test(part):evidenceSecretName)) throw new Error('sensitive file denied');
 if(/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/.test(raw))throw Error('private key material denied');
 if(raw.includes('\0')) throw new Error('binary file denied');
 const extension=extname(path).toLowerCase();
 let text=raw;
 if(!legacy&&envExample.test(parts.at(-1)??'')){
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
 } else if(extension === '.jsonc'||!legacy&&extension === '.json') {
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
 } else if(['.yaml','.yml'].includes(extension)||legacy&&extension==='.json') {
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
 } else if(legacy){
  if(credentialAssignment.test(raw)||environmentReference.test(raw))throw Error('unsupported sensitive format');
 } else if(/\.(?:mdx?|rst|adoc|txt)$/.test(extension)&&(structuredCredentialAssignment(raw)||environmentReference.test(raw))){
  text=filterProse(raw);
 } else if(credentialAssignment.test(raw)||environmentReference.test(raw)){
  const declarations=/^\s*(?:readonly\s+)?[$\w]+\??\s*:\s*(?:string|number|boolean|undefined|unknown|never|symbol|bigint)(?:\[\])?\s*;[ \t]*$/gm;
  const lines=raw.split('\n');
  const withoutDeclarations=/\.(?:[cm]?ts|tsx)$/.test(extension)
   ?raw.replace(declarations,declaration=>declaration.replace(/[^\r\n]/g,' ')).split('\n'):undefined;
  text=redactInline(lines,credentialAssignment,{
   keep:withoutDeclarations&& (index=>withoutDeclarations[index]!==lines[index]),
   batch:/\.(?:bat|cmd)$/.test(extension),
  });
 }
 const urls=legacy?/https?:\/\/[^\s"'<>]+/g:/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;
 return text.replace(urls,url=>{
  try {const parsed=new URL(url);if(parsed.username || parsed.password){parsed.username='';parsed.password='';}for(const key of [...parsed.searchParams.keys()]) if(sensitive.test(key)) parsed.searchParams.set(key,'[REDACTED]');return parsed.toString();}catch{return '[REDACTED-URL]';}
 });
}
