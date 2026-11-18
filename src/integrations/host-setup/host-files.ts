import {lstat,readFile} from 'node:fs/promises';
export {absolutePath as absoluteHostPath,directoryLocation as canonicalHostDirectory} from '../../path-location.js';
import {parse,visit} from 'jsonc-parser';
import {isRecord} from '../../private-record.js';
export {withinPath} from '../../npm-command.mjs';

export const absent=(error:unknown)=>(error as NodeJS.ErrnoException)?.code==='ENOENT';
export const statIfPresent=(path:string)=>lstat(path,{bigint:true}).catch(error=>{if(!absent(error))throw error;return undefined;});
type Info=NonNullable<Awaited<ReturnType<typeof statIfPresent>>>;
export const stamp=(info:Info)=>[info.size,info.mode,info.mtimeNs].join(':');

export async function checkedDirectory(path:string){
 const info=await statIfPresent(path);
 if(info&&!info.isDirectory())throw Error('Not a directory: '+path);
 return info;
}

export async function checkedFile(path:string,{limit=256_000}={}){
 const info=await statIfPresent(path);
 if(info&&(!info.isFile()||info.size>BigInt(limit)))throw Error('Expected a bounded regular file: '+path);
 return info;
}

export async function readNativeFile(path:string,limit=256_000){
 if(!await checkedFile(path,{limit}))return;
 const bytes=await readFile(path);
 if(bytes.length>limit)throw Error('Native metadata exceeds the read limit: '+path);
 return {bytes};
}

export function strictJson(text:string,{jsonc=false}={}){
 const options={disallowComments:!jsonc,allowTrailingComma:jsonc};
 const objects:Set<string>[]=[];
 let invalid=false;
 visit(text,{
  onError:()=>{invalid=true;},onObjectBegin:()=>{objects.push(new Set());},
  onObjectEnd:()=>{objects.pop();},
  onObjectProperty:key=>{const fields=objects.at(-1)!;if(fields.has(key))invalid=true;fields.add(key);},
 },options);
 const value:unknown=jsonc?parse(text,undefined,options):JSON.parse(text);
 if(invalid||!isRecord(value))throw Error('Invalid or duplicate native metadata');
 return value;
}

export async function nativeJson(path:string,limit?:number){
 const file=await readNativeFile(path,limit);
 return file?{value:strictJson(file.bytes.toString('utf8'))}:undefined;
}
