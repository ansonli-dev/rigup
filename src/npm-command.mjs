import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {constants,statSync} from 'node:fs';
import {access,lstat,readFile,realpath} from 'node:fs/promises';
import {basename,delimiter,dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';

/** @param {string[]} args */
export function npmCommand(args) {
 if(process.platform!=='win32')return {executable:'npm',args};
 // npm.cmd is a batch file. Use the npm CLI from this Node installation
 // so project arguments are passed as argv, without a command interpreter.
 const cli=join(dirname(process.execPath),'node_modules','npm','bin','npm-cli.js');
 if(!statSync(cli,{throwIfNoEntry:false})?.isFile())throw Error('Native npm CLI unavailable beside Node.js');
 return {executable:process.execPath,args:[cli,...args]};
}

/** @param {string} root @param {string} path */
export function withinPath(root,path){
 const rel=relative(root,path);
 return rel===''||rel!=='..'&&!rel.startsWith('..'+sep)&&!isAbsolute(rel);
}

/** @param {string} root @param {string} path */
export async function npmPathDirectories(root,path){
 const node=process.platform==='win32'?'node.exe':'node';
 const directories=await Promise.all(path.split(delimiter).filter(dir=>isAbsolute(dir)&&!withinPath(root,dir)).map(async dir=>{
  const canonical=await realpath(dir).catch(()=>undefined);
  if(!canonical||withinPath(root,canonical))return;
  const interpreter=await realpath(join(canonical,node)).catch(()=>undefined);
  if(!interpreter||!withinPath(root,interpreter))return canonical;
 }));
 return [...new Set(directories.filter(dir=>dir!==undefined))];
}

/** @param {string} name @param {string} root @param {string[]} directories */
export async function externalExecutable(name,root,directories){
 for(const directory of directories){
  const path=join(directory,name);
  try{
   if(withinPath(root,path))continue;
   const canonical=await realpath(path);
   if(withinPath(root,canonical)||!(await lstat(canonical)).isFile())continue;
   await access(path,constants.X_OK);return path;
  }catch{/* Try the next path entry. */}
 }
}

/** @typedef {'openwiki'|'codegraph'} ToolId */
/** @typedef {{executable:string,args:string[],launcher:string,version?:string}} ToolProgram */
/** @typedef {{state:'available',program:ToolProgram,path:string}|{state:'missing'}|{state:'repair',reason:string}} ExternalTool */

const toolNames={openwiki:'openwiki',codegraph:'@colbymchenry/codegraph'};
const bundledNode=process.platform==='win32'?'node.exe':'node';
const platformCodeGraph='@colbymchenry/codegraph-'+process.platform+'-'+process.arch;

export function consumerPath(){
 return process.env.RIGUP_CONSUMER_PATH??process.env.PATH??process.env.Path??'';
}

/** @param {string} path */
function unquotePath(path){
 return process.platform==='win32'?path.replace(/(^|;)"([^"]+)"(?=;|$)/g,'$1$2'):path;
}

/** @param {string} root @param {string} path */
export async function checkHostNode(root,path){
 for(const directory of unquotePath(path).split(delimiter)){
  const path=resolve(root,directory,bundledNode);
  try{
   const actual=await realpath(path);
   if(!(await lstat(actual)).isFile())continue;
   await access(path,constants.X_OK);
   if(!isAbsolute(directory)||withinPath(root,path)||withinPath(root,actual))return 'The host PATH selects Node from a relative or project location. Put a trusted Node.js installation first and reload the host.';
   return;
  }catch{/* A missing entry does not shadow later PATH directories. */}
 }
 return 'Node.js is unavailable on the host PATH. Put a trusted Node.js installation on PATH and reload the host.';
}

/** @param {string} base @param {string} child */
async function regularChild(base,child){
 const path=resolve(base,child);
 if(path===base||!withinPath(base,path))throw Error('Unsafe package entry');
 const canonical=await realpath(path),info=await lstat(canonical);
 if(!withinPath(base,canonical)||!info.isFile())throw Error('Invalid package entry');
 return canonical;
}

/** @param {string} base */
async function packageManifest(base){
 const file=await regularChild(base,'package.json');
 if((await lstat(file)).size>64_000)throw Error('Invalid package manifest');
 return JSON.parse(await readFile(file,'utf8'));
}

/** @param {string} base */
async function codeGraphBundle(base){
 const executable=await regularChild(base,bundledNode);
 const entry=await regularChild(base,'lib/dist/bin/codegraph.js');
 await access(executable,constants.X_OK);
 return {executable,args:['--liftoff-only','--disable-warning=ExperimentalWarning',entry]};
}

/** @param {string} pkg @param {any} manifest */
export async function verifyCodeGraphPayload(pkg,manifest){
 if(manifest.name!==toolNames.codegraph||!manifest.optionalDependencies||!Object.keys(manifest.optionalDependencies).some(name=>name.startsWith(toolNames.codegraph+'-')))return;
 for(const modules of [join(pkg,'node_modules'),dirname(dirname(pkg))]){
  try{
   const supplied=join(modules,platformCodeGraph);
   const bundle=await realpath(supplied);
   if(!withinPath(await realpath(modules),bundle))continue;
   const metadata=await packageManifest(bundle);
   if(metadata.name!==platformCodeGraph||metadata.version!==manifest.version)continue;
   return await codeGraphBundle(bundle);
  }catch{
   // npm can lay out the optional package beside the wrapper or under it.
  }
 }
 throw Error('Missing usable '+platformCodeGraph+' platform package. Repair the CodeGraph installation.');
}

/** @param {ToolId} id @param {string} pkg @param {string} launcher @param {string} [expected] */
async function npmTool(id,pkg,launcher,expected){
 const base=await realpath(pkg);
 const meta=await packageManifest(base);
 const entry=typeof meta.bin==='string'?meta.bin:meta.bin?.[id];
 if(meta.name!==toolNames[id]||typeof entry!=='string'||!/^\.?[\w./-]+\.(?:c|m)?js$/i.test(entry))throw Error('Invalid '+id+' npm entry');
 const binary=await regularChild(base,entry);
 if(expected&&binary!==expected)throw Error('The '+id+' launcher differs from its npm entry');
 const bundle=id==='codegraph'?await verifyCodeGraphPayload(base,meta):undefined;
 return {...(bundle??{executable:process.execPath,args:[binary]}),launcher,version:typeof meta.version==='string'?meta.version:undefined};
}

/** @param {ToolId} id @param {string} binary */
function linkedPackage(id,binary){
 for(let dir=dirname(binary);dir!==dirname(dir);dir=dirname(dir)){
  if(basename(dir)!==id)continue;
  const parent=dirname(dir);
  if(id==='openwiki'?basename(parent)==='node_modules':basename(parent)==='@colbymchenry'&&basename(dirname(parent))==='node_modules')return dir;
 }
}

/** @param {string} root @param {ToolId} id @param {string} path @returns {Promise<ExternalTool>} */
export async function resolveExternalTool(root,id,path){
 const dirs=await npmPathDirectories(root,unquotePath(path));
 const windows=process.platform==='win32';
 for(const directory of dirs){
  const executable=await externalExecutable(id+(windows?'.exe':''),root,[directory]);
  const shim=windows&&!executable?await externalExecutable(id+'.cmd',root,[directory]):undefined;
  const launcher=executable??shim;
  if(!launcher)continue;
  try{
   const canonical=await realpath(launcher);
   const linked=!windows?linkedPackage(id,canonical):undefined;
   let program;
   if(linked)program=await npmTool(id,linked,launcher,canonical);
   else if(executable)program={executable:canonical,args:[],launcher};
   else {
    const modules=basename(directory).toLowerCase()==='.bin'?dirname(directory):join(directory,'node_modules');
    const pkg=join(modules,toolNames[id]);
    if(await lstat(pkg).catch(()=>undefined)){
     const packageScope=await realpath(pkg);
     if(withinPath(root,packageScope)||!withinPath(await realpath(modules),packageScope))throw Error('Unsafe npm package path');
     program=await npmTool(id,packageScope,launcher);
    }else if(id==='codegraph'&&basename(directory).toLowerCase()==='bin'){
     const bundle=await codeGraphBundle(dirname(directory));
     program={...bundle,launcher};
    }else throw Error('Missing npm package for '+id+' launcher');
   }
   if(withinPath(root,program.executable)||program.args.some(arg=>isAbsolute(arg)&&withinPath(root,arg)))throw Error('Tool program redirects into the project');
   return {state:'available',program,path:dirs.join(delimiter)};
  }catch(error){
   return {state:'repair',reason:error instanceof Error?error.message:'Invalid '+id+' launcher'};
  }
 }
 return {state:'missing'};
}

/** @param {ToolId} id @param {string} root @param {string} mode @param {string[]} args */
async function launchToolMcp(id,root,mode,args){
 const path=process.env.PATH??process.env.Path??'';
 const external=mode==='path'?await resolveExternalTool(root,id,path):undefined;
 if(external&&external.state!=='available')throw Error(external.state==='repair'?external.reason:id+' is missing from the host PATH. Reconfigure the integration.');
 const safePath=external?.path??(await npmPathDirectories(root,unquotePath(path))).join(delimiter);
 let program=external?.program;
 if(mode==='project'){
  const expected=join(root,'.rigup','tools',id,'node_modules',toolNames[id]);
  if(await realpath(expected)!==expected)throw Error('Project tool package redirects');
  program=await npmTool(id,expected,expected);
 }
 if(!program)throw Error('Invalid tool launcher arguments');
 const env={...process.env};
 for(const name of Object.keys(env))if(/^path$/i.test(name))delete env[name];
 env.PATH=safePath;
 if(id==='codegraph'){
  env.CODEGRAPH_HOST_PPID??=String(process.ppid);
  env.CODEGRAPH_NO_DOWNLOAD='1';
 }
 const child=spawn(program.executable,[...program.args,...args],{cwd:root,env,stdio:'inherit',windowsHide:true});
 const interrupt=()=>child.kill('SIGINT'),terminate=()=>child.kill('SIGTERM');
 process.on('SIGINT',interrupt);process.on('SIGTERM',terminate);
 try{
  return await new Promise((done,fail)=>{
   child.once('error',fail);child.once('exit',code=>done(code??1));
  });
 }finally{
  process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',terminate);
 }
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
 const [id,mode,...args]=process.argv.slice(2);
 try{
  if(id!=='openwiki'&&id!=='codegraph')throw Error('Unknown Rigup tool');
  process.exitCode=await launchToolMcp(id,process.cwd(),mode,args);
 }catch(error){
  process.stderr.write((error instanceof Error?error.message:'Tool unavailable')+'\n');process.exitCode=1;
 }
}
