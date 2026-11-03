import {diff3Merge} from 'node-diff3';
export interface ManagedIntent {action:'update'|'remove';binary?:boolean}
export interface MergeResult {action:'create'|'update'|'noop'|'keep'|'conflict'|'remove';content?:string;reason?:string}
export function mergeManaged(base:string|undefined,local:string|undefined,next:string|undefined,intent:ManagedIntent):MergeResult {
 const conflict=(reason:string):MergeResult=>({action:'conflict',content:local,reason});
 if(intent.action==='remove') {
  if(local===undefined)return {action:'noop'};
  if(base===undefined)return conflict('No trusted baseline for removal');
  return local===base?{action:'remove'}:conflict('User changed the managed item; removal requires resolution');
 }
 if(next===undefined)return conflict('Update requires generated content');
 if(base===undefined) return local===undefined?{action:'create',content:next}:conflict('Existing item has no trusted baseline; explicit adoption required');
 if(local===undefined)return conflict('User deleted the managed item; explicit restore required');
 if(local===next)return {action:'noop',content:local};
 if(local===base)return {action:'update',content:next};
 if(next===base)return {action:'keep',content:local};
 if(intent.binary)return conflict('Binary edits cannot be merged');
 const chunks=diff3Merge(local.split('\n'),base.split('\n'),next.split('\n'));
 if(chunks.some(c=>'conflict' in c))return conflict('Overlapping edits require resolution');
 return {action:'update',content:chunks.flatMap(c=>'ok' in c?c.ok:[]).join('\n')};
}
