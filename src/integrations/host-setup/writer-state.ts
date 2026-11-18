import {createHash} from 'node:crypto';
import {realpath,unlink} from 'node:fs/promises';
import {userInfo} from 'node:os';
import {dirname,join,relative} from 'node:path';
import {syncDirectory} from '../../sync-directory.js';
import {absent,canonicalHostDirectory,statIfPresent} from './host-files.js';
import {ompPackage} from './manual.js';

// Alternate effective homes and projects may still write the same native targets.
export const nativeWriterStateRoot=(override?:string)=>override??join(userInfo().homedir,'.local','state','rigup');

export function ompVerificationPath(writerRoot:string,target:string){
 const key=process.platform==='win32'?target.toLowerCase():target;
 return join(writerRoot,'native-omp-'+createHash('sha256').update(key).digest('hex')+'.unverified.json');
}

export async function unverifiedOmpInstall(plugins:string,override?:string,verifyingTarget?:string){
 const packagePath=join(plugins,'node_modules',ompPackage);
 const exists=await statIfPresent(packagePath).catch(error=>{if(error.code!=='ENOTDIR')throw error;});
 if(!exists)return;
 const target=join(await canonicalHostDirectory(plugins),'node_modules',ompPackage);
 if(verifyingTarget&&relative(target,verifyingTarget)==='')return;
 const writerRoot=nativeWriterStateRoot(override);
 const record=ompVerificationPath(writerRoot,target);
 // A damaged or inaccessible marker cannot establish that verification finished.
 if(await statIfPresent(record).then(Boolean,()=>true))
  return {target,record,directory:await realpath(target).catch(()=>target)};
}

export async function clearOmpVerification(path:string){
 try{await unlink(path);}
 catch(error){if(absent(error))return;throw error;}
 await syncDirectory(dirname(path));
}
