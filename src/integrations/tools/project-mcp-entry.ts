// Native clients may launch stdio from a repository subdirectory. Resolve the
// nearest host configuration, then load the project-owned Node entry in place.
const projectEntry=`
const {existsSync,realpathSync}=require('node:fs');
const {dirname,join}=require('node:path');
const {pathToFileURL}=require('node:url');
const [config,script,...args]=process.argv.slice(1);
let root=realpathSync(process.cwd());
while(!existsSync(join(root,config))||!existsSync(join(root,script))){
 const parent=dirname(root);
 if(parent===root||existsSync(join(root,'.git'))){
  console.error('Rigup MCP could not locate its project configuration.');
  process.exit(1);
 }
 root=parent;
}
try{
 const entry=join(root,script);
 const actual=realpathSync(entry);
 const equal=process.platform==='win32'?actual.toLowerCase()===entry.toLowerCase():actual===entry;
 if(!equal)throw Error('Project entry redirects');
 process.chdir(root);
 process.argv=[process.execPath,entry,...args];
 import(pathToFileURL(entry).href).catch(()=>{console.error('Rigup MCP could not load its project entry.');process.exitCode=1;});
}catch{
 console.error('Rigup MCP project entry is unavailable. Prepare and apply the project setup.');
 process.exitCode=1;
}`.trim();

export function projectMcpArgs(config:string,entry:string,args:string[]):string[]{
 return ['-e',projectEntry,'--',config,entry,...args];
}
