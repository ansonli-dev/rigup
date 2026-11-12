import {diff3Merge} from 'node-diff3';
export interface ManagedIntent {action:'update'|'remove';binary?:boolean;equals?:(left:string,right:string)=>boolean}
export interface MergeResult {action:'create'|'update'|'noop'|'keep'|'conflict'|'remove';content?:string;reason?:string}
export function mergeManaged(base:string|undefined,local:string|undefined,next:string|undefined,intent:ManagedIntent):MergeResult {
 const conflict=(reason:string):MergeResult=>({action:'conflict',content:local,reason});
 const equal=intent.binary?((left:string,right:string)=>left===right):intent.equals??((left:string,right:string)=>left===right);
 if(intent.action==='remove') {
  if(local===undefined)return {action:'noop'};
  if(base===undefined)return conflict('No trusted baseline for removal');
  return equal(local,base)?{action:'remove'}:conflict('User changed the managed item; removal requires resolution');
 }
 if(next===undefined)return conflict('Update requires generated content');
 if(base===undefined) return local===undefined?{action:'create',content:next}:equal(local,next)?{action:'noop',content:local}:conflict('Existing item differs from generated content and has no trusted baseline. Preserve it, move it aside or move local text outside the managed selector, then review again before applying.');
 if(local===undefined)return conflict('User deleted the managed item; explicit restore required');
 if(equal(local,next))return {action:'noop',content:local};
 if(equal(local,base))return {action:'update',content:next};
 if(equal(next,base))return {action:'keep',content:local};
 if(intent.binary)return conflict('Binary edits cannot be merged');
 const lines=(text:string)=>text.replaceAll('\r\n','\n').split('\n');
 const chunks=diff3Merge(lines(local),lines(base),lines(next));
 if(chunks.some(c=>'conflict' in c))return conflict('Overlapping edits require resolution');
 return {action:'update',content:chunks.flatMap(c=>'ok' in c?c.ok:[]).join('\n')};
}
