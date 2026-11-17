import {constants} from 'node:fs';
import {lstat,open,realpath} from 'node:fs/promises';
import {dirname,isAbsolute,join,parse,relative,resolve,sep} from 'node:path';
import {visit} from 'jsonc-parser';
import {isRecord} from '../../private-record.js';
export {withinPath} from '../../npm-command.mjs';

const windows=process.platform==='win32';
export const absent=(error:unknown)=>(error as NodeJS.ErrnoException)?.code==='ENOENT';
export const statIfPresent=(path:string)=>lstat(path,{bigint:true}).catch(error=>{if(!absent(error))throw error;return undefined;});
type Info=NonNullable<Awaited<ReturnType<typeof statIfPresent>>>;
export const stamp=(info:Info)=>[info.dev,info.ino,info.mode,info.nlink,info.size,info.mtimeNs,info.ctimeNs].join(':');
const trustedOwner=(info:Info)=>windows||info.uid===0n||info.uid===BigInt(process.getuid!());
const unsafeWrite=(info:Info)=>!windows&&(info.mode&0o022n)!==0n;

export function absoluteHostPath(value:string){
 const root=parse(value).root;
 if(!isAbsolute(value)||/[\x00-\x1f\x7f-\x9f\u2028-\u202e\u2066-\u2069]/.test(value)||value.length>8192||
    windows&&(!/^[a-z]:[\\/]$/i.test(root)||/[<>:"|?*]/.test(value.slice(root.length)))||
    value.slice(root.length).split(windows?/[\\/]/:/\//).some(part=>
     part==='..'||windows&&(/[ .]$/.test(part)||/^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(part))))
  throw Error('An absolute, unambiguous path is required');
 const path=resolve(value);
 return process.platform==='darwin'?path.replace(/^\/(tmp|var|etc)(?=\/|$)/,'/private/$1'):path;
}

function parents(path:string){
 const base=parse(path).root;
 const result=[base];
 for(const part of relative(base,path).split(sep).filter(Boolean))result.push(join(result.at(-1)!,part));
 return result;
}

// Check every existing component, even when the destination itself does not exist.
export async function checkedDirectory(path:string){
 const dirs=parents(absoluteHostPath(path));
 let info:Info|undefined;
 for(const directory of dirs){
  info=await statIfPresent(directory);
  if(!info)return;
  if(!info.isDirectory()||info.isSymbolicLink()||!trustedOwner(info)||
      unsafeWrite(info)&&(directory===dirs.at(-1)||(info.mode&0o1000n)===0n))
   throw Error('Directory is not trusted or uses a link');
 }
 return info;
}

export async function checkedFile(path:string,{hardlinks=false,limit=256_000}={}){
 await checkedDirectory(dirname(path));
 const before=await statIfPresent(path);
 if(!before)return;
 if(!before.isFile()||!trustedOwner(before)||unsafeWrite(before)||!hardlinks&&before.nlink!==1n||before.size>BigInt(limit))
  throw Error('File is not a trusted, bounded regular file');
 return before;
}

export async function readNativeFile(path:string,limit=256_000){
 const before=await checkedFile(path,{limit});
 if(!before)return;
 const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  if(stamp(await file.stat({bigint:true}))!==stamp(before))throw Error('Native metadata changed during read');
  const bytes=Buffer.alloc(Number(before.size));
  let offset=0;
  while(offset<bytes.length){
   const {bytesRead}=await file.read(bytes,offset,bytes.length-offset,offset);
   if(!bytesRead)throw Error('Native metadata changed during read');
   offset+=bytesRead;
  }
  const after=await statIfPresent(path);
  if(!after||stamp(after)!==stamp(before)||relative(path,await realpath(path))!=='')throw Error('Native metadata changed during read');
  return {bytes,identity:stamp(after)};
 }finally{await file.close();}
}

export function strictJson(text:string){
 const objects:Set<string>[]=[];
 let invalid=false;
 visit(text,{
  onError:()=>{invalid=true;},onObjectBegin:()=>{objects.push(new Set());},
  onObjectEnd:()=>{objects.pop();},
  onObjectProperty:key=>{const fields=objects.at(-1)!;if(fields.has(key))invalid=true;fields.add(key);},
 },{disallowComments:true});
 const value:unknown=JSON.parse(text);
 if(invalid||!isRecord(value))throw Error('Invalid or duplicate native metadata');
 return value;
}

export async function nativeJson(path:string,limit?:number){
 const file=await readNativeFile(path,limit);
 return file?{identity:file.identity,value:strictJson(file.bytes.toString('utf8'))}:undefined;
}
