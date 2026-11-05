import {open,constants} from 'node:fs/promises';
import {digest} from '../analyzer/evidence.js';
import {targetPath} from './ownership.js';

export const absentDigest=digest('rigup:absent');
export interface FileState {bytes?:Buffer;digest:string;mode?:number}
export async function readFileState(root:string,target:string):Promise<FileState>{
 const path=await targetPath(root,target);
 let handle;
 try{handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {digest:absentDigest};throw error;}
 try{
  const info=await handle.stat();if(!info.isFile())throw Error('target must be a regular file');
  const bytes=await handle.readFile();return {bytes,digest:digest(bytes),mode:info.mode&0o777};
 }finally{await handle.close();}
}
export function matchesFileState(actual:FileState,hash:string,mode?:number):boolean{return actual.digest===hash&&actual.mode===mode;}

export async function* readFileStates(root:string,targets:readonly string[]){
 const batchSize=8;
 for(let start=0;start<targets.length;start+=batchSize){
  yield* await Promise.all(targets.slice(start,start+batchSize).map(async target=>({target,state:await readFileState(root,target)})));
 }
}
