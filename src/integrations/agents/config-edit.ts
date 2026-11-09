import {parseTree,findNodeAtLocation,getNodeValue,modify,applyEdits,type Node,type ParseError} from 'jsonc-parser';
import {parse as parseToml} from 'smol-toml';

function assertUniqueKeys(node:Node):void {
 const children=node.children??[];
 if(node.type==='object'){
  const names=new Set<string>();
  for(const child of children){
   const name=child.children![0].value as string;
   if(names.has(name))throw new Error('configuration JSONC has a duplicate property');
   names.add(name);
  }
 }
 for(const child of children)assertUniqueKeys(child);
}

function jsonTree(text:string):Node {
 const errors:ParseError[]=[];const tree=parseTree(text,errors,{allowTrailingComma:true});
 if(errors.length||!tree)throw new Error('configuration JSONC cannot be parsed safely');
 assertUniqueKeys(tree);
 return tree;
}

export function parseConfigJsonValue(text:string):unknown {
 return getNodeValue(jsonTree(text));
}

export function jsonValue(text:string,path:string[]):string|undefined {
 const tree=jsonTree(text);
 if(tree.type!=='object')throw new Error('configuration JSONC must be an object');
 const node=findNodeAtLocation(tree,path);return node?text.slice(node.offset,node.offset+node.length):undefined;
}
export function editJson(text:string,path:string[],next:string|undefined):string {
 jsonValue(text,path);
 for(let n=1;n<path.length;n++){const value=jsonValue(text,path.slice(0,n));if(value!==undefined){const errors:ParseError[]=[];const node=parseTree(value,errors);if(!node||node.type!=='object')throw new Error('configuration parent is not an object');}}
 let value:unknown=undefined;if(next!==undefined){jsonTree(next);value=JSON.parse(next);}
 return applyEdits(text,modify(text,path,value,{formattingOptions:{insertSpaces:true,tabSize:2}}));
}
export function tomlRange(text:string,path:string[]):{start:number;end:number}|undefined {
 parseToml(text);
 if(!path.length||path.some(p=>!/^[-A-Za-z0-9_]+$/.test(p)))throw new Error('TOML table selector unsupported');
 const headers=[...text.matchAll(/^\[([^\]\n]+)\][ \t]*(?:#.*)?\r?$/gm)];
 // Quoted/array table headers cannot be safely range-edited by this bounded adapter.
 if(text.split('\n').some(line=>/^\s*\[/.test(line)&&!/^\[[-A-Za-z0-9_.]+\][ \t]*(?:#.*)?\r?$/.test(line)))throw new Error('TOML header form unsupported');
 const i=headers.findIndex(h=>h[1]===path.join('.'));if(i<0)return;
 return {start:headers[i].index!,end:headers[i+1]?.index??text.length};
}
export function editToml(text:string,path:string[],next:string|undefined):string {
 const range=tomlRange(text,path);
 if(next!==undefined){const parsed=parseToml(next);if(!next.startsWith('['+path.join('.')+']'))throw new Error('generated TOML selector mismatch');const headers=[...next.matchAll(/^\[/gm)];if(headers.length!==1)throw new Error('generated TOML may only contain the owned table');if(!parsed)throw new Error('generated TOML invalid');}
 const result=range?text.slice(0,range.start)+(next??'')+text.slice(range.end):text+(next===undefined?'':(text&&!text.endsWith('\n')?'\n':'')+next);
 parseToml(result);return result;
}
