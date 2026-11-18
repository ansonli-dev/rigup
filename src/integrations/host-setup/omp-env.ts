import {join} from 'node:path';
import {readNativeFile} from './host-files.js';

const overlayKeys=['PI_CONFIG_FILES','OMP_CONFIG_FILES'];
const pathKeys=new Set([...overlayKeys,'PI_CONFIG_DIR','OMP_CONFIG_DIR','PI_CODING_AGENT_DIR','OMP_CODING_AGENT_DIR',
 'OMP_PROFILE','PI_PROFILE','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_STATE_HOME','XDG_CACHE_HOME','HOME','USERPROFILE']);

function dotenvKeys(text:string){
 const keys=new Set<string>();
 const empty=/[\t ]*(?:#[^\r\n]*)?(?:\r?\n|$)/y;
 const assignment=/[\t ]*(?:export[\t ]+)?([A-Za-z_][A-Za-z0-9_]*)[\t ]*=[\t ]*/y;
 const quoted=/"(?:[^"\\]|\\[\s\S])*"|'[^']*'|`[^`]*`/y;
 let offset=text.startsWith('\uFEFF')?1:0;
 while(offset<text.length){
  empty.lastIndex=assignment.lastIndex=offset;
  if(empty.test(text)){offset=empty.lastIndex;continue;}
  const key=assignment.exec(text)?.[1];
  if(!key)return;
  let end=assignment.lastIndex;
  if(['"',"'",'`'].includes(text[end])){
   quoted.lastIndex=end;
   if(!quoted.test(text))return;
   end=quoted.lastIndex;
  }
  const newline=text.indexOf('\n',end);
  offset=newline===-1?text.length:newline+1;
  if(pathKeys.has(key))keys.add(key);
 }
 return [...keys];
}

export async function analyzeOmpEnv(home:string,env:NodeJS.ProcessEnv,{base,agent}:{base:string;agent:string}){
 const files:string[]=[],unreadable:string[]=[],observed:{file:string;key:string}[]=[];
 for(const dir of new Set([home,base,agent])){
  const file=join(dir,'.env');
  try{
   const data=await readNativeFile(file);
   if(!data)continue;
   const keys=dotenvKeys(data.bytes.toString('utf8'));
   if(!keys)unreadable.push(file);
   else for(const key of keys)observed.push({file,key});
  }catch{unreadable.push(file);}
  files.push(file);
 }
 for(const key of overlayKeys)if(env[key]?.trim())observed.push({file:'<environment>',key});
 return {files,pathKeys:observed,unreadable};
}
