import {parseTree,findNodeAtLocation,type ParseError} from 'jsonc-parser';
import {parse as parseToml} from 'smol-toml';
export type Ownership={kind:'file'}|{kind:'block';start:string;end:string;insert?:{kind:'yaml-sequence';key:'include'}}|{kind:'json-key';path:string[]}|{kind:'toml-table';path:string[]};
export function projectInput(text:string,ownership:Ownership[],preserveLines=false):string|null{if(ownership.some(o=>o.kind === 'file')) return null;
 for(const selector of ownership) {
  if(selector.kind === 'json-key') {
   const errors:ParseError[]=[];const tree=parseTree(text,errors,{allowTrailingComma:true});
   if(errors.length || !tree) throw new Error('ownership JSON parse failed');
   const node=findNodeAtLocation(tree,selector.path);
   if(!node) throw new Error('ownership JSON key missing');
   const removed=text.slice(node.offset,node.offset+node.length);
   text=text.slice(0,node.offset)+'null'+(preserveLines ? '\n'.repeat((removed.match(/\n/g)||[]).length) : '')+text.slice(node.offset+node.length);continue;
  }
  if(selector.kind === 'toml-table') {
   parseToml(text);
   // Only canonical bare table names are supported; ambiguous forms fail closed.
   if(selector.path.some(p=>!/^[-A-Za-z0-9_]+$/.test(p))) throw new Error('ownership TOML selector unsupported');
   const headers=[...text.matchAll(/^\[([^\]\n]+)\][ \t]*(?:#.*)?$/gm)];
   const index=headers.findIndex(h=>h[1] === selector.path.join('.'));
   if(index<0) throw new Error('ownership TOML table missing or unsupported');
   const start=headers[index].index!; const end=headers[index+1]?.index ?? text.length;
   text=text.slice(0,start)+(preserveLines ? '\n'.repeat((text.slice(start,end).match(/\n/g)||[]).length) : '')+text.slice(end);continue;
  }
  if(selector.kind !== 'block') continue;
  const start=text.indexOf(selector.start); const end=text.indexOf(selector.end);
  if(start<0 || end<start || text.indexOf(selector.start,start+selector.start.length)>=0 || text.indexOf(selector.end,end+selector.end.length)>=0) throw new Error('ownership markers ambiguous or missing');
  let last=end+selector.end.length;if(text.slice(last,last+2)==='\r\n')last+=2;else if(text[last]==='\n')last++;
  text=text.slice(0,start)+(preserveLines ? '\n'.repeat((text.slice(start,last).match(/\n/g)||[]).length) : '')+text.slice(last);
 }
 return text;}
export async function remoteInput(version:string|undefined,read:()=>Promise<string>):Promise<string>{return read();}
