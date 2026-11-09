import {open} from 'node:fs/promises';

export async function syncDirectory(path:string):Promise<void>{
 // Windows directory handles opened for reading lack the write access FlushFileBuffers requires.
 // Callers still sync file contents and use atomic filesystem operations to publish them.
 if(process.platform==='win32')return;
 const handle=await open(path,'r');
 try{await handle.sync();}finally{await handle.close();}
}
