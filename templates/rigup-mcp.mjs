import {execFile,spawn} from 'node:child_process';
import {access,readFile,realpath,lstat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {basename,delimiter,dirname,isAbsolute,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

const root=fileURLToPath(new URL('../',import.meta.url));
const host=process.argv[2];
const requiredVersion='__RIGUP_VERSION__';
const validVersion=value=>typeof value==='string'&&/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(value);
const paths=(process.env.PATH??'').split(delimiter).map(path=>path.replace(/^"|"$/g,'')).filter(isAbsolute);

async function rigupCommand(){
 for(const dir of paths){
  const command=join(dir,process.platform==='win32'?'rigup.exe':'rigup');
  try{await access(command,constants.X_OK);return {command,args:[]};}catch{}
  if(process.platform!=='win32')continue;
  const shim=join(dir,'rigup.cmd');
  try{await access(shim,constants.X_OK);}catch{continue;}
  try{
   const modules=basename(dir).toLowerCase()==='.bin'?dirname(dir):join(dir,'node_modules');
   const packageRoot=await realpath(join(modules,'@ansonli.dev','rigup'));
   const manifest=JSON.parse(await readFile(join(packageRoot,'package.json'),'utf8'));
   if(manifest.name!=='@ansonli.dev/rigup'||manifest.bin?.rigup!=='dist/cli.js')throw Error('Invalid Rigup npm entry');
   const entry=join(packageRoot,'dist','cli.js');
   if((await realpath(entry)).toLowerCase()!==entry.toLowerCase())throw Error('Invalid Rigup npm entry');
   return {command:process.execPath,args:[entry]};
  }catch{}
  throw Error('Cannot resolve the first Rigup PATH command at '+shim+'; repair its npm installation before loading required version '+requiredVersion+'.');
 }
 throw Error('Install Rigup and put its npm bin directory on PATH.');
}

async function verifyVersion(command,args){
 if(!validVersion(requiredVersion))throw Error('Rigup project launcher version is unavailable; review and regenerate setup.');
 try{
  const directory=join(root,'.rigup'),path=join(directory,'manifest.json');
  if(!(await lstat(directory)).isDirectory())throw Error('Invalid metadata directory');
  const info=await lstat(path);
  if(!info.isFile()||info.nlink!==1||info.size>8_000_000)throw Error('Invalid manifest');
  const manifest=JSON.parse(await readFile(path,'utf8'));
  if(manifest.schemaVersion!==1||typeof manifest.installId!=='string'||!Array.isArray(manifest.assets))throw Error('Invalid manifest');
  if(manifest.versions?.rigup!==undefined&&manifest.versions.rigup!==requiredVersion)throw Error('Version disagreement');
 }catch(error){
  if(error.code!=='ENOENT')throw Error('Rigup manifest and project launcher are invalid or disagree; review and regenerate setup with Rigup '+requiredVersion+'.');
 }
 let observed='unavailable';
 try{
  const {stdout}=await promisify(execFile)(command,[...args,'--version'],{cwd:root,timeout:5000,killSignal:'SIGKILL',maxBuffer:1024,windowsHide:true});
  if(validVersion(stdout.trim()))observed=stdout.trim();
 }catch{/* The selected CLI output is untrusted and may contain secrets. */}
 if(observed!==requiredVersion)throw Error('Rigup version mismatch: project requires '+requiredVersion+', selected CLI reports '+observed+' at '+(args[0]??command)+'. Update that PATH installation or review the project with its matching Rigup version.');
}

try{
 if(!['claude','codex','opencode','omp'].includes(host))throw Error('Unsupported Rigup MCP host.');
 const {command,args}=await rigupCommand();
 await verifyVersion(command,args);
 const child=spawn(command,[...args,'mcp',root,'--host',host],{cwd:root,stdio:'inherit',windowsHide:true});
 child.once('error',()=>{console.error('Rigup MCP could not start.');process.exitCode=1;});
 child.once('exit',code=>{process.exitCode=code??1;});
}catch(error){
 console.error(error.message);
 process.exitCode=1;
}
