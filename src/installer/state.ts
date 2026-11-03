import {open,rename} from 'node:fs/promises';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
export async function saveDurable(path:string,content:string):Promise<void>{
 const temp=path+'.'+randomUUID()+'.tmp';const file=await open(temp,'wx',0o600);
 try{await file.writeFile(content);await file.sync();}finally{await file.close();}
 await rename(temp,path);const directory=await open(dirname(path),'r');try{await directory.sync();}finally{await directory.close();}
}
