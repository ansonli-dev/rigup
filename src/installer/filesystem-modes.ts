import type {FileHandle} from 'node:fs/promises';

const unsupported=new Set(['EACCES','EINVAL','ENOSYS','ENOTSUP','EOPNOTSUPP','EPERM']);

export async function stagedFileMode(file:FileHandle,requested:number,path:string):Promise<number>{
 try{await file.chmod(requested);}catch(error){
  if(!unsupported.has((error as NodeJS.ErrnoException).code??''))throw error;
 }
 const actual=(await file.stat()).mode&0o777;
 if(process.platform!=='win32'&&(requested&0o100)&&!(actual&0o100))
  throw Error('The filesystem cannot retain executable permission for '+path);
 return actual;
}
