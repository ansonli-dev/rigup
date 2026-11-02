import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
export async function project(fn:(root:string)=>Promise<void>) {
 const root=await realpath(await mkdtemp(join(tmpdir(),'rigup-scan-')));
 try{await fn(root);}finally{await rm(root,{recursive:true,force:true});}
}
