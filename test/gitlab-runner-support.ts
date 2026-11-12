import {execFile} from 'node:child_process';
import {stat,realpath} from 'node:fs/promises';
import {delimiter,dirname,isAbsolute,join} from 'node:path';
import {promisify} from 'node:util';

const exec=promisify(execFile);
const version=async(file:string)=>(await exec(file,['--version'],{timeout:5000,maxBuffer:4096,windowsHide:true})).stdout;
const file=async(path:string)=>{try{return (await stat(path)).isFile();}catch{return false;}};

export async function runnerEnvironment(home:string,environment:NodeJS.ProcessEnv=process.env,platform:NodeJS.Platform=process.platform,readVersion=version):Promise<NodeJS.ProcessEnv>{
 const inherited=environment.PATH??environment.Path??'';
 let paths:string[]=[];
 if(platform==='win32'){
  const explicit=environment.RIGUP_GIT_BASH;
  const roots=explicit?[dirname(dirname(explicit)),dirname(dirname(dirname(explicit)))]:[
   ...inherited.split(delimiter).map(path=>dirname(path.replace(/^"|"$/g,''))),
   ...[environment.ProgramFiles,environment['ProgramFiles(x86)']].filter((path):path is string=>!!path).map(path=>join(path,'Git')),
  ];
  for(const root of [...new Set(roots)]){
   if(!isAbsolute(root)||!await file(join(root,'cmd/git.exe')))continue;
   const bash=explicit??join(root,'bin/bash.exe');
   if(!await file(bash)||!await file(join(root,'usr/bin/bash.exe')))continue;
   try{
    if(!/^GNU bash[, ]/m.test(await readVersion(await realpath(bash))))continue;
    paths=[join(root,'bin'),join(root,'usr/bin')];break;
   }catch{}
  }
  if(!paths.length)throw Error('Install Git for Windows with Git Bash, or set RIGUP_GIT_BASH to its native bin/bash.exe. WSL bash is not a native Windows runner shell.');
 }
 const essential=['SystemRoot','SYSTEMROOT','WINDIR','ComSpec','COMSPEC','PATHEXT','TEMP','TMP'];
 return {...Object.fromEntries(essential.flatMap(name=>environment[name]===undefined?[]:[[name,environment[name]]])),
  PATH:[...paths,dirname(process.execPath),inherited].filter(Boolean).join(delimiter),HOME:home,USERPROFILE:home,LANG:'en_US.UTF-8',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:join(home,'gitconfig')};
}

export function redactGitlabEvidence(text:string,secrets:Iterable<string>):string{
 for(const secret of [...secrets].filter(Boolean).sort((a,b)=>b.length-a.length))text=text.split(secret).join('[redacted]');
 return text.replace(/\b(?:glpat|glrt|glcbt|gldt|glptt)-[\w.-]+/gi,'[redacted]')
  .replace(/((?:CI_JOB_TOKEN|PRIVATE[-_]TOKEN|RUNNER_TOKEN|JOB_TOKEN|access_token|password)\s*[=:]\s*)[^\s"'\\]+/gi,'$1[redacted]')
  .replace(/(Authorization:\s*Bearer\s+)[^\s"'\\]+/gi,'$1[redacted]');
}

export async function failedJobEvidence(api:(method:string,path:string,body?:unknown,text?:boolean)=>Promise<any>,base:string,pipelines:number[],secrets:Iterable<string>){
 const evidence:{pipeline:number;id:number;name:string;status:string;trace:string}[]=[];
 for(const pipeline of pipelines){
  const jobs=await api('GET',base+'/pipelines/'+pipeline+'/jobs').catch(()=>[]);
  for(const job of jobs.filter((job:any)=>job.status==='failed'||job.status==='canceled')){
   const trace=await api('GET',base+'/jobs/'+job.id+'/trace',undefined,true).then(value=>redactGitlabEvidence(String(value).slice(0,256_000),secrets),()=> 'Trace unavailable');
   evidence.push({pipeline,id:job.id,name:job.name,status:job.status,trace});
  }
 }
 return evidence;
}

export async function boundedTrace(response:Response):Promise<string>{
 const reader=response.body?.getReader();if(!reader)return '';
 const chunks:Uint8Array[]=[];let bytes=0;
 try{
  while(bytes<256_000){const result=await reader.read();if(result.done)break;const part=result.value.subarray(0,256_000-bytes);chunks.push(part);bytes+=part.length;}
 }finally{await reader.cancel();}
 return Buffer.concat(chunks).toString('utf8');
}
