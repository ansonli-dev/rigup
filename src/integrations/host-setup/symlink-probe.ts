import {mkdir,mkdtemp,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

export async function symlinksAllowed(platform=process.platform,createLink=symlink):Promise<boolean>{
 if(platform!=='win32')return true;
 const scratch=await mkdtemp(join(tmpdir(),'rigup-omp-symlink-')).catch(()=>undefined);
 if(!scratch)return true;
 try{
  const target=join(scratch,'target');
  try{await mkdir(target);}catch{return true;}
  try{await createLink(target,join(scratch,'link'));return true;}
  catch(error){return (error as NodeJS.ErrnoException).code!=='EPERM';}
 }finally{await rm(scratch,{recursive:true,force:true,maxRetries:3});}
}
