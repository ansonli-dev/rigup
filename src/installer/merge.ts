import {diff3Merge} from 'node-diff3';
import {makeReason,reasonDetail,type ReasonCode,type WithReasonDetail} from '../i18n/reasons.js';
export interface ManagedIntent {action:'update'|'remove';binary?:boolean;equals?:(left:string,right:string)=>boolean}
export interface MergeResult extends WithReasonDetail {action:'create'|'update'|'noop'|'keep'|'conflict'|'remove';content?:string;reason?:string}
export function mergeManaged(base:string|undefined,local:string|undefined,next:string|undefined,intent:ManagedIntent):MergeResult {
 const conflict=(code:ReasonCode):MergeResult=>{
  const reason=makeReason(code);
  return {action:'conflict',content:local,reason:reason.fallback,[reasonDetail]:reason};
 };
 const equal=intent.binary?((left:string,right:string)=>left===right):intent.equals??((left:string,right:string)=>left===right);
 if(intent.action==='remove') {
  if(local===undefined)return {action:'noop'};
  if(base===undefined)return conflict('preview.mergeRemoveBaseline');
  return equal(local,base)?{action:'remove'}:conflict('preview.mergeRemoveChanged');
 }
 if(next===undefined)return conflict('preview.mergeMissingContent');
 if(base===undefined) return local===undefined?{action:'create',content:next}:equal(local,next)?{action:'noop',content:local}:conflict('preview.mergeExistingChanged');
 if(local===undefined)return conflict('preview.mergeLocalDeleted');
 if(equal(local,next))return {action:'noop',content:local};
 if(equal(local,base))return {action:'update',content:next};
 if(equal(next,base))return {action:'keep',content:local};
 if(intent.binary)return conflict('preview.mergeBinary');
 const lines=(text:string)=>text.replaceAll('\r\n','\n').split('\n');
 const chunks=diff3Merge(lines(local),lines(base),lines(next));
 if(chunks.some(c=>'conflict' in c))return conflict('preview.mergeOverlapping');
 return {action:'update',content:chunks.flatMap(c=>'ok' in c?c.ok:[]).join('\n')};
}
