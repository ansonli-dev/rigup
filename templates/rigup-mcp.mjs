import {spawn} from 'node:child_process';
import {access,readFile,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {basename,delimiter,dirname,isAbsolute,join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const host=process.argv[2];
const paths=(process.env.PATH??'').split(delimiter).map(path=>path.replace(/^"|"$/g,'')).filter(isAbsolute);

async function rigupCommand(){
 for(const dir of paths){
  const command=join(dir,process.platform==='win32'?'rigup.exe':'rigup');
  try{await access(command,constants.X_OK);return {command,args:[]};}catch{}
  if(process.platform!=='win32')continue;
  try{
   const modules=basename(dir).toLowerCase()==='.bin'?dirname(dir):join(dir,'node_modules');
   const packageRoot=await realpath(join(modules,'@ansonli.dev','rigup'));
   const manifest=JSON.parse(await readFile(join(packageRoot,'package.json'),'utf8'));
   if(manifest.name!=='@ansonli.dev/rigup'||manifest.bin?.rigup!=='dist/cli.js')continue;
   const entry=join(packageRoot,'dist','cli.js');
   if((await realpath(entry)).toLowerCase()!==entry.toLowerCase())continue;
   return {command:process.execPath,args:[entry]};
  }catch{}
 }
 throw Error('Install Rigup and put its npm bin directory on PATH.');
}

try{
 if(!['claude','codex','opencode','omp'].includes(host))throw Error('Unsupported Rigup MCP host.');
 const {command,args}=await rigupCommand();
 const child=spawn(command,[...args,'mcp',root,'--host',host],{cwd:root,stdio:'inherit',windowsHide:true});
 child.once('error',()=>{console.error('Rigup MCP could not start.');process.exitCode=1;});
 child.once('exit',code=>{process.exitCode=code??1;});
}catch(error){
 console.error(error.message);
 process.exitCode=1;
}
