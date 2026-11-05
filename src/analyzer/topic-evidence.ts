import type {Evidence} from '../types.js';
import type {RepositoryReader} from './backend.js';
import {dependencyLock} from './stage-context.js';

const MAX_REQUESTS=8,MAX_LINES=48,MAX_MATCHES=6,MAX_BYTES=12_000;

type Operation={read:{path:string;start:number;end:number}}|{search:{query:string;scope:string}};
interface TopicEvidenceResult {
 topicId:string;
 operation?:Operation;
 status:'complete'|'limited'|'unavailable';
 refs:Evidence[];
 reason?:string;
}
export interface TopicEvidenceBatch {from:'analysis'|'plan';results:TopicEvidenceResult[]}
const record=(value:unknown)=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const within=(path:string,scope:string)=>scope==='.'||path===scope||path.startsWith(scope+'/');

export function topicEvidenceRequests(data:unknown):unknown[] {
 const requests=record(data).topicEvidenceRequests;
 if(requests===undefined)return [];
 if(!Array.isArray(requests)||requests.length>MAX_REQUESTS)throw new Error('Expected at most eight topic evidence requests');
 return requests;
}

function operationFor(request:Record<string,unknown>,paths:Set<string>):Operation|undefined {
 if(request.read!==undefined&&request.search===undefined){
  const {path,start,end}=record(request.read);
  if(typeof path==='string'&&paths.has(path)&&typeof start==='number'&&typeof end==='number'&&Number.isSafeInteger(start)&&Number.isSafeInteger(end)&&start>=1&&end>=start&&end-start<MAX_LINES)return {read:{path,start,end}};
 }
 if(request.search!==undefined&&request.read===undefined){
  const {query,scope}=record(request.search);
  if(typeof query==='string'&&query.trim()&&query.length<=120&&!/[\x00-\x1f\x7f]/.test(query)&&typeof scope==='string'&&[...paths].some(path=>within(path,scope)))return {search:{query,scope}};
 }
 return undefined;
}

/** Keep only verified range metadata. The next stage exports the selected bodies. */
export async function collectTopicEvidence(from:TopicEvidenceBatch['from'],requests:unknown[],topics:Set<string>,reader:RepositoryReader):Promise<TopicEvidenceBatch> {
 const paths=new Set((await reader.list()).filter(path=>!dependencyLock(path)));
 const results:TopicEvidenceResult[]=[];
 let bytes=0;
 for(const value of requests){
  const request=record(value),topicId=typeof request.topicId==='string'&&topics.has(request.topicId)?request.topicId:'';
  const operation=topicId?operationFor(request,paths):undefined;
  if(!operation){results.push({topicId,status:'unavailable',refs:[],reason:'Topic, operation, path, scope or range outside the research contract'});continue;}
  try{
   const excerpts='read'in operation?[await reader.read(operation.read.path,operation.read.start,operation.read.end)]:
    (await reader.search(operation.search.query,{paths:new Set([...paths].filter(path=>within(path,operation.search.scope))),limit:MAX_MATCHES+1}))
     .filter(({evidence})=>paths.has(evidence.path)&&within(evidence.path,operation.search.scope));
   const refs:Evidence[]=[];
   for(const {content,evidence} of excerpts.slice(0,MAX_MATCHES)){
    const size=Buffer.byteLength(content);
    if(bytes+size>MAX_BYTES)break;
    refs.push(evidence);bytes+=size;
   }
   const limited=refs.length<excerpts.length;
   results.push({topicId,operation,status:limited?'limited':'complete',refs,...(limited?{reason:'Matching excerpts were limited by the batch bounds'}:{})});
  }catch{
   results.push({topicId,operation,status:'unavailable',refs:[],reason:'Source unavailable under the repository read policy or budget'});
  }
 }
 return {from,results};
}
