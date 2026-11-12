import {readFile,realpath,lstat} from 'node:fs/promises';
import {resolve,relative,isAbsolute,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {filterContent} from './read-policy.js';
import type {Evidence} from '../types.js';
export interface EvidenceRead {content:string;evidence:Evidence}
export type ReadEvidence=(path:string,startLine:number,endLine?:number)=>Promise<EvidenceRead>;
export const digest=(text:string|Buffer)=>createHash('sha256').update(text).digest('hex');
export class EvidenceRangeError extends Error {
 constructor(readonly lineCount:number){super('evidence range beyond file');this.name='EvidenceRangeError';}
}
export function validEvidenceRange(startLine:number,endLine:number,lastLine=Infinity):boolean {
 return Number.isInteger(startLine)&&Number.isInteger(endLine)&&startLine>=1&&endLine>=startLine&&endLine<=lastLine;
}
export function sliceEvidence(path:string,lines:readonly string[],startLine:number,endLine?:number):EvidenceRead {
 endLine??=lines.length;
 if(!validEvidenceRange(startLine,endLine))throw new Error('invalid evidence range');
 if(endLine>lines.length)throw new EvidenceRangeError(lines.length);
 const content=lines.slice(startLine-1,endLine).join('\n');
 return {content,evidence:{path,startLine,endLine,digest:digest(content)}};
}
export async function safePath(root:string,path:string):Promise<string>{
 const base=await realpath(root);const target=resolve(base,path);const rel=relative(base,target);
 if(isAbsolute(rel) || rel === '..' || rel.startsWith('..'+sep)) throw new Error('path escapes root');
 let current=base;
 for(const part of rel.split(sep).filter(Boolean)){current=resolve(current,part);if((await lstat(current)).isSymbolicLink()) throw new Error('symlink denied');}
 return target;
}
export async function readEvidence(root:string,path:string,startLine:number,endLine:number):Promise<EvidenceRead>{
 if(!validEvidenceRange(startLine,endLine))throw new Error('invalid evidence range');
 const file=await safePath(root,path);const text=filterContent(path,await readFile(file,'utf8'));const lines=text.split('\n');
 return sliceEvidence(path,lines,startLine,endLine);
}
