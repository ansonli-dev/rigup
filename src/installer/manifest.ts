import {writeFile,mkdir,rename,chmod,open} from 'node:fs/promises';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {targetPath} from './ownership.js';
export async function atomicProjectWrite(root:string,target:string,content:Buffer,mode?:number):Promise<void>{
 const path=await targetPath(root,target);await mkdir(dirname(path),{recursive:true});await targetPath(root,target);
 const temporary=path+'.rigup-'+randomUUID()+'.tmp';
 const handle=await open(temporary,'wx',mode??0o600);try{await handle.writeFile(content);if(mode!==undefined)await handle.chmod(mode);await handle.sync();}finally{await handle.close();}await rename(temporary,path);const dir=await open(dirname(path),'r');try{await dir.sync();}finally{await dir.close();}
}
