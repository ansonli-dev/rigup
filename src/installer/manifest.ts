import {mkdir,rename,open,link,unlink} from 'node:fs/promises';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {targetPath} from './ownership.js';
export async function atomicProjectWrite(root:string,target:string,content:Buffer,mode?:number,exclusive=false):Promise<void>{
 const path=await targetPath(root,target);await mkdir(dirname(path),{recursive:true});await targetPath(root,target);
 const temporary=path+'.rigup-'+randomUUID()+'.tmp';
 const handle=await open(temporary,'wx',mode??0o600);
 try{
  try{await handle.writeFile(content);if(mode!==undefined)await handle.chmod(mode);await handle.sync();}finally{await handle.close();}
  await targetPath(root,target);
  if(exclusive)await link(temporary,path);else await rename(temporary,path);
 }finally{await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
 const dir=await open(dirname(path),'r');try{await dir.sync();}finally{await dir.close();}
}
