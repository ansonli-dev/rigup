import {valid} from 'semver';
import {isRecord} from '../../private-record.js';
import {makeReason} from '../../i18n/reasons.js';
import {NativeBlocker} from './blockers.js';
import {strictJson} from './host-files.js';
import {ompPackage} from './manual.js';

const registry='https://registry.npmjs.org/';
const latest=registry+'@loneexile%2fomp-superpowers/latest';
const tarballs=registry+ompPackage+'/-/omp-superpowers-';
export interface OmpPin {version:string;integrity:string;tarball:string}

export async function readOmpDownload(url:string,limit:number,timeoutMs:number,request:typeof fetch=fetch,signal?:AbortSignal){
 const timeout=AbortSignal.timeout(timeoutMs);
 const failed=()=>new NativeBlocker('download-failed',makeReason('reason.native.download'),{evidence:[url]});
 let response:Response;
 try{response=await request(url,{redirect:'error',signal:signal?AbortSignal.any([signal,timeout]):timeout});}
 catch{throw failed();}
 if(response.status!==200||response.redirected||!response.body||response.url&&response.url!==url){
  await response.body?.cancel().catch(()=>{});
  throw failed();
 }
 const reader=response.body.getReader(),bytes=Buffer.alloc(limit);
 let offset=0;
 try{
  for(;;){
   const {value,done}=await reader.read().catch(()=>{throw failed();});
   if(done)break;
   if(offset+value.length>limit){
    await reader.cancel().catch(()=>{});
    throw new NativeBlocker('download-failed',makeReason('reason.native.downloadSize'),{evidence:[url]});
   }
   bytes.set(value,offset);offset+=value.length;
  }
 }finally{reader.releaseLock();}
 return bytes.subarray(0,offset);
}

export async function resolveOmpPin(request?:typeof fetch,signal?:AbortSignal):Promise<OmpPin>{
 const bytes=await readOmpDownload(latest,256_000,20_000,request,signal);
 const invalid=()=>new NativeBlocker('download-failed',makeReason('reason.native.metadata'),{evidence:[latest]});
 let metadata:Record<string,unknown>;
 try{metadata=strictJson(bytes.toString('utf8'));}catch{throw invalid();}
 const {version,dist}=metadata;
 if(typeof version!=='string'||!(/^[0-9][A-Za-z0-9.+-]{0,127}$/).test(version)||!valid(version)||!isRecord(dist))throw invalid();
 const {integrity,tarball}=dist;
 if(typeof integrity!=='string'||!/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)||tarball!==tarballs+version+'.tgz')throw invalid();
 const digest=integrity.slice(7);
 if(Buffer.from(digest,'base64').toString('base64')!==digest)throw invalid();
 return {version,integrity,tarball};
}
