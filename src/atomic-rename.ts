import {setTimeout as delay} from 'node:timers/promises';

const retryDelays=[20,50,100,200];

export async function renameWithRetry(rename:()=>Promise<void>,verify?:()=>Promise<unknown>):Promise<void>{
 for(let attempt=0;;attempt++){
  await verify?.();
  try{await rename();return;}
  catch(error){
   const wait=retryDelays[attempt];
   const code=(error as NodeJS.ErrnoException)?.code;
   if(process.platform!=='win32'||wait===undefined||
    (code!=='EPERM'&&code!=='EACCES'&&code!=='EBUSY'))throw error;
   await delay(wait);
  }
 }
}
