import {realpath,stat} from 'node:fs/promises';
import {basename,dirname,join,resolve} from 'node:path';

export function absolutePath(value:string){
 const path=resolve(value);
 return process.platform==='darwin'?path.replace(/^\/(tmp|var|etc)(?=\/|$)/,'/private/$1'):path;
}

export async function directoryLocation(value:string):Promise<string>{
 const suffix:string[]=[];
 for(let path=absolutePath(value);;path=dirname(path)){
  try{
   const directory=await realpath(path);
   if(!(await stat(directory)).isDirectory())throw Error('Not a directory: '+path);
   return join(directory,...suffix);
  }catch(error){
   if((error as NodeJS.ErrnoException).code!=='ENOENT'||dirname(path)===path)throw error;
   suffix.unshift(basename(path));
  }
 }
}
