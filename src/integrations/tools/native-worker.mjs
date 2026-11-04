// Runs only behind the durable operation dispatcher. Tool-owned state is written
// by the pinned upstream APIs; Rigup owns only staging and promotion metadata.
import {lstat,readdir,readFile,mkdir,rename,realpath,open,writeFile} from 'node:fs/promises';
import {resolve,dirname,basename} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID,createHash} from 'node:crypto';
const exec=promisify(execFile);
const [action,root,id,staging,control,adapterDigest]=process.argv.slice(2);
const version=id==='openwiki'?'0.7.3':'1.6.2';
const target=id==='openwiki'?'openwiki':'.codegraph';
const require=createRequire(import.meta.url);
async function safe(path){
 if(!path||path.startsWith('/')||path.split('/').some(p=>!p||p==='.'||p==='..'))throw Error('Invalid native scope');
 let current=root;
 for(const part of path.split('/')){current=resolve(current,part);try{if((await lstat(current)).isSymbolicLink())throw Error('Native symlink denied');}catch(e){if(e.code!=='ENOENT')throw e;}}
 return current;
}
async function safeTree(path){
 const info=await lstat(path).catch(e=>{if(e.code==='ENOENT')return null;throw e;});if(!info)return;
 if(info.isSymbolicLink()||!info.isDirectory()&&!info.isFile())throw Error('Unsafe native state entry');
 if(info.isDirectory())for(const name of await readdir(path))await safeTree(resolve(path,name));
}
async function empty(path){const info=await lstat(path).catch(e=>{if(e.code==='ENOENT')return null;throw e;});if(info&&(!info.isDirectory()||(await readdir(path)).length))throw Error('Native target is no longer empty');}
async function syncDirectory(path){const file=await open(path,'r');try{await file.sync();}finally{await file.close();}}
async function flushTree(path){const st=await lstat(path);if(st.isDirectory()){for(const name of await readdir(path))await flushTree(resolve(path,name));await syncDirectory(path);}else{const file=await open(path,'r');try{await file.sync();}finally{await file.close();}}}
async function durable(path,value){const temp=path+'.'+randomUUID()+'.tmp';const file=await open(temp,'wx',0o600);try{await file.writeFile(JSON.stringify(value)+'\n');await file.sync();}finally{await file.close();}await rename(temp,path);await syncDirectory(dirname(path));}
async function identity(path){const info=await lstat(path);if(!info.isDirectory()||info.isSymbolicLink())throw Error('Native target is not a directory');return String(info.dev)+':'+String(info.ino);}
const packagePath=resolve(root,'.rigup/tools',id,'node_modules',id==='openwiki'?'openwiki':'@colbymchenry/codegraph');
async function openwikiState(path){
 const native=await import(pathToFileURL(resolve(packagePath,'dist/generation/run-state.js')).href);
 const run=await native.readRepositoryRunState(path);
 if(run)return {phase:run.phase,runId:run.runId};
 const last=JSON.parse(await readFile(resolve(path,'openwiki/.last-update.json'),'utf8'));
 if(last.status!=='complete')throw Error('OpenWiki has no resumable run or completed baseline');
 return {phase:'complete'};
}
async function codegraphState(path){
 const {DatabaseSync}=await import('node:sqlite');
 const db=new DatabaseSync(resolve(path,'codegraph.db'),{readOnly:true,allowExtension:false});
 try{
  const metadata=db.prepare('SELECT value FROM project_metadata WHERE key = ?');
  if(metadata.get('index_state')?.value!=='complete'||metadata.get('indexed_with_version')?.value!==version)throw Error('CodeGraph index is incomplete or incompatible');
  const check=db.prepare('PRAGMA quick_check(1)').get();if(Object.values(check??{})[0]!=='ok')throw Error('CodeGraph index integrity check failed');
  return {phase:'complete',files:db.prepare('SELECT COUNT(*) AS count FROM files').get().count,nodes:db.prepare('SELECT COUNT(*) AS count FROM nodes').get().count};
 }finally{db.close();}
}
async function query(){
 await safeTree(await safe(target));
 const marker=JSON.parse(await readFile(await safe(control+'/promotion.json'),'utf8'));
 const actual=await identity(await safe(target));
 if(marker.root!==root||marker.id!==id||marker.target!==target||marker.version!==version||marker.identity!==actual)throw Error('Native promotion ownership does not match');
 const state=id==='openwiki'?await openwikiState(root):await codegraphState(await safe(target));
 return {status:'done',message:id==='openwiki'?'OpenWiki initialized; Codex can resume the native page lifecycle':'Complete native CodeGraph index verified',nativeReceipt:{version,target,identity:actual},state};
}
async function initialize(){
 await safeTree(await safe(control));await safeTree(await safe(staging));await empty(await safe(target));
 await mkdir(await safe(control),{recursive:true,mode:0o700});
 for(const name of ['home','tmp','cache','data','config'])await mkdir(await safe(control+'/'+name),{recursive:true,mode:0o700});
 let output;
 if(id==='codegraph'){
  process.env.CODEGRAPH_DIR=basename(staging);
  const native=require(packagePath);const CodeGraph=native.default??native.CodeGraph;
  // Only this new staging scope is disposable. Never recreate a live index.
  const initialized=CodeGraph.isInitialized(root);
  if(!initialized){const prior=await lstat(await safe(staging)).catch(e=>{if(e.code==='ENOENT')return null;throw e;});if(prior)await rename(await safe(staging),await safe(control+'/interrupted-'+randomUUID()));}
  const cg=initialized?await CodeGraph.recreate(root):await CodeGraph.init(root,{index:false});
  try {const result=await cg.indexAll();if(!result.success||cg.getIndexState()!=='complete')throw Error('Native indexing did not complete');}
  finally{cg.close();}
  output=await safe(staging);await codegraphState(output);
 }else{
  const native=await import(pathToFileURL(resolve(packagePath,'dist/integrations/core/session-manager.js')).href);
  const state=await import(pathToFileURL(resolve(packagePath,'dist/generation/run-state.js')).href);
  const repo=await safe(staging);await mkdir(repo,{recursive:true,mode:0o700});
  // A malformed unpublished checkpoint is retained for inspection. The fresh
  // attempt is still confined to the original authorized staging scope.
  try{await state.readRepositoryRunState(repo);}catch{
   await rename(repo,await safe(control+'/interrupted-'+randomUUID()));await mkdir(repo,{mode:0o700});
  }
  await exec('git',['-C',repo,'-c','init.templateDir=','-c','core.hooksPath=/dev/null','init','-q'],{timeout:10000});
  const manager=native.HostSessionManager.create({host:'codex'});
  await manager.begin({root:repo,mode:'init'});
  await openwikiState(repo);output=await safe(staging+'/openwiki');
 }
 await safeTree(output);await flushTree(output);
 const receipt={root,id,target,version,identity:await identity(output)};
 await durable(await safe(control+'/promotion.json'),receipt);
 // The marker is durable before promotion. A crash on either side of rename
 // is distinguished by the target directory identity during reconciliation.
 await empty(await safe(target));await rename(output,await safe(target));await syncDirectory(root);
 return query();
}
try{
 if(adapterDigest!==createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex')||!['initialize','query'].includes(action)||!['openwiki','codegraph'].includes(id)||await realpath(root)!==root||control!=='.rigup/native/'+id||staging!==(id==='openwiki'?control+'/repository':'.codegraph-rigup-init'))throw Error('Invalid native adapter parameters');
 const result=action==='query'?await query():await initialize();process.stdout.write(JSON.stringify(result)+'\n');
}catch(error){
 if(action==='initialize'){try{await writeFile(await safe(control+'/failure.json'),JSON.stringify({message:String(error.message),at:new Date().toISOString()})+'\n',{mode:0o600});}catch{}}
 process.stderr.write('Native '+id+' '+action+' could not be verified: '+error.message+'\n');process.exitCode=1;
}
