import {randomUUID} from 'node:crypto';
import {lstat,open,readFile,rm} from 'node:fs/promises';
import {dirname,join,sep} from 'node:path';
import {assertPrivateAccess,createWindowsPrivateDirectory} from '../private-access.js';
import {platformFileMode} from './file-state.js';
import {targetPath} from './ownership.js';

async function probeMode(parent:string,mode:number):Promise<number>{
 const temporary=join(parent,'.rigup-mode-'+randomUUID()+'.tmp');
 const identity=await lstat(parent);
 let file=temporary;
 try{
  if(process.platform==='win32'&&mode===0o600){
   await createWindowsPrivateDirectory(temporary,'Filesystem cannot protect private Rigup records');
   file=join(temporary,'probe');
  }
  const handle=await open(file,'wx',mode);
  try{
   await handle.chmod(mode);
   const info=await handle.stat();
   if(process.platform==='win32'&&mode===0o600)await assertPrivateAccess(file,info,'Filesystem cannot protect private Rigup records');
   return info.mode&0o777;
  }finally{await handle.chmod(0o600).catch(()=>{});await handle.close();}
 }finally{
  const current=await lstat(parent);
  if(current.dev!==identity.dev||current.ino!==identity.ino)throw Error('Filesystem probe parent changed; no project writes performed');
  await rm(temporary,{force:true,recursive:process.platform==='win32'&&mode===0o600});
 }
}

async function mountInfo(path:string):Promise<string>{
 if(process.platform!=='linux')return '';
 try{
  const mounts=(await readFile('/proc/self/mountinfo','utf8')).split('\n').flatMap(line=>{
   const [fields,filesystem]=line.split(' - '),mount=fields?.split(' ')[4]?.replace(/\\([0-7]{3})/g,(_,octal)=>String.fromCharCode(parseInt(octal,8)));
   return mount&&(path===mount||path.startsWith(mount.endsWith(sep)?mount:mount+sep))?[{mount,type:filesystem?.split(' ')[0]}]:[];
  }).sort((a,b)=>b.mount.length-a.mount.length);
  return mounts.length?' ('+mounts[0].type+' mounted at '+mounts[0].mount+')':'';
 }catch{return '';}
}

export async function assertSupportedFileModes(root:string,targets:{target:string;mode?:number}[],probe=probeMode):Promise<void>{
 const parents=new Map<string,Set<number>>();
 for(const target of [...targets,{target:'.rigup/manifest.json',mode:0o600},{target:'.rigup/baseline/probe',mode:0o600}]){
  let parent=dirname(await targetPath(root,target.target));
  for(;;){
   try{if(!(await lstat(parent)).isDirectory())throw Error('Filesystem probe parent is not a directory');break;}
   catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;parent=dirname(parent);}
  }
  const modes=parents.get(parent)??new Set<number>();modes.add(target.mode??0o644);modes.add(0o600);parents.set(parent,modes);
 }
 for(const [parent,modes] of parents)for(const requested of modes){
  const observed=await probe(parent,requested);
  if(observed===platformFileMode(requested))continue;
  const octal=(mode:number)=>'0'+mode.toString(8).padStart(3,'0');
  throw Error('Filesystem at '+parent+await mountInfo(parent)+' cannot retain requested mode '+octal(requested)+' (observed '+octal(observed)+'). No installation writes were started. For WSL drvfs, use a checkout in the Linux home filesystem or enable mount metadata and reconcile existing permissions before resuming. Preserve the interrupted installation journal.');
 }
}
