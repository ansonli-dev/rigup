// Runs only behind the durable operation dispatcher. Tool-owned state is written
// by the pinned upstream APIs; Rigup owns only staging and promotion metadata.
import {lstat,readdir,readFile,mkdir,rename,realpath,open,rmdir,writeFile} from 'node:fs/promises';
import {resolve,dirname,basename} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID,createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
const exec=promisify(execFile);
const [action,root,id,staging,control,adapterDigest]=process.argv.slice(2);
const version=id==='openwiki'?'0.7.3':'1.6.2';
const target=id==='openwiki'?'openwiki':'.codegraph';
const require=createRequire(import.meta.url);
let rootInfo;
async function safe(path){
 const parts=path.split('/');
 if(parts.some(part=>!part||part==='.'||part==='..'||/[\\:\0]/.test(part)))throw Error('Invalid native scope');
 if(!sameEntry(await nativeTarget(root),rootInfo))throw Error('Native project root changed');
 let current=root;
 for(const [i,part] of parts.entries()){
  current=resolve(current,part);
  const info=await nativeTarget(current);
  if(!info)continue;
  if(info.isSymbolicLink())throw Error('Native symlink denied');
  if(i<parts.length-1&&!info.isDirectory())throw Error('Native parent is not a directory');
  if(process.platform==='win32'&&(await realpath(current)).toLowerCase()!==current.toLowerCase())throw Error('Native path aliases are not allowed');
 }
 return current;
}
async function safeTree(path,daemonSocket){
 const info=await lstat(path).catch(e=>{if(e.code==='ENOENT')return null;throw e;});if(!info)return;
 if(path===daemonSocket&&info.isSocket())return;
 if(info.isSymbolicLink()||!info.isDirectory()&&!info.isFile())throw Error('Unsafe native state entry');
 if(info.isDirectory())for(const name of await readdir(path))await safeTree(resolve(path,name),daemonSocket);
}
async function nativeTarget(path){return lstat(path,{bigint:true}).catch(e=>{if(e.code==='ENOENT')return null;throw e;});}
function sameEntry(current,previous){
 if(!current||!previous)return current===previous;
 return current.dev===previous.dev&&current.ino===previous.ino&&current.isDirectory()===previous.isDirectory()&&current.isFile()===previous.isFile();
}
async function empty(path){const info=await nativeTarget(path);if(info&&(info.isSymbolicLink()||!info.isDirectory()||(await readdir(path)).length))throw Error('Native target is no longer empty');return info;}

// Keep the retry logic inside the digest-pinned worker and match the delay
// policy of Rigup's other atomic writers.
const retryDelays=[20,50,100,200];
async function renameNative(source,destination,sourceInfo,verifyDestination){
 const from=await safe(source),to=await safe(destination);
 const parents=[...new Set([dirname(from),dirname(to)])];
 const identities=await Promise.all(parents.map(nativeTarget));
 if(identities.some(info=>!info?.isDirectory()))throw Error('Native rename parent is not a directory');
 for(let attempt=0;;attempt++){
  await safe(source);
  await safeTree(from);
  await safe(source);await safe(destination);
  for(const [i,parent] of parents.entries())if(!sameEntry(await nativeTarget(parent),identities[i]))throw Error('Native rename parent changed');
  if(!sourceInfo||!sameEntry(await nativeTarget(from),sourceInfo))throw Error('Native rename source changed');
  await verifyDestination(to);
  try{await rename(from,to);return;}
  catch(error){
   const wait=retryDelays[attempt];
   if(process.platform!=='win32'||wait===undefined||!['EPERM','EACCES','EBUSY'].includes(error.code))throw error;
   await delay(wait);
  }
 }
}
async function quarantine(source,info){
 await renameNative(source,control+'/interrupted-'+randomUUID(),info,async path=>{
  if(await nativeTarget(path))throw Error('Native quarantine destination appeared');
 });
}
async function syncDirectory(path){
 // Windows cannot flush a directory opened for reading. File writes below are still synced.
 if(process.platform==='win32')return;
 const file=await open(path,'r');try{await file.sync();}finally{await file.close();}
}
async function flushTree(path){const st=await lstat(path);if(st.isDirectory()){for(const name of await readdir(path))await flushTree(resolve(path,name));await syncDirectory(path);}else{const file=await open(path,process.platform==='win32'?'r+':'r');try{await file.sync();}finally{await file.close();}}}
async function durable(path,value){
 const destination=await safe(path),before=await nativeTarget(destination);
 if(before&&!before.isFile())throw Error('Native journal destination is not a file');
 const temp=path+'.'+randomUUID()+'.tmp';
 const file=await open(await safe(temp),'wx',0o600);
 let sourceInfo;
 try{await file.writeFile(JSON.stringify(value)+'\n');await file.sync();sourceInfo=await file.stat({bigint:true});}
 finally{await file.close();}
 await renameNative(temp,path,sourceInfo,async to=>{
  if(!sameEntry(await nativeTarget(to),before))throw Error('Native journal destination changed');
 });
 await syncDirectory(dirname(destination));
}
function identity(info){
 if(!info?.isDirectory())throw Error('Native target is not a directory');
 // Preserve the receipt format emitted by previous workers using number stats.
 return String(Number(info.dev))+':'+String(Number(info.ino));
}
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
 const path=await safe(target);
 const marker=JSON.parse(await readFile(await safe(control+'/promotion.json'),'utf8'));
 const actual=identity(await nativeTarget(path));
 if(marker.root!==root||marker.id!==id||marker.target!==target||marker.version!==version||marker.identity!==actual)throw Error('Native promotion ownership does not match');
 // The pinned CodeGraph daemon can serve this verified index during an update.
 await safeTree(path,id==='codegraph'?resolve(path,'daemon.sock'):undefined);
 const state=id==='openwiki'?await openwikiState(root):await codegraphState(await safe(target));
 return {status:'done',message:id==='openwiki'?'OpenWiki initialized; Codex can resume the native page lifecycle':'Complete native CodeGraph index verified',nativeReceipt:{version,target,identity:actual},state};
}
async function initialize(){
 await safeTree(await safe(control));await safeTree(await safe(staging));
 const initialTarget=await empty(await safe(target));
 await mkdir(await safe(control),{recursive:true,mode:0o700});
 await durable(control+'/intent.json',{schemaVersion:1,root,id,target,staging,version,adapterDigest});
 for(const name of ['home','tmp','cache','data','config'])await mkdir(await safe(control+'/'+name),{recursive:true,mode:0o700});
 let output;
 if(id==='codegraph'){
  process.env.CODEGRAPH_DIR=basename(staging);
  const native=require(packagePath);const CodeGraph=native.default??native.CodeGraph;
  // Only this new staging scope is disposable. Never recreate a live index.
  const initialized=CodeGraph.isInitialized(root);
  if(!initialized){const prior=await nativeTarget(await safe(staging));if(prior)await quarantine(staging,prior);}
  const cg=initialized?await CodeGraph.recreate(root):await CodeGraph.init(root,{index:false});
  try {const result=await cg.indexAll();if(!result.success||cg.getIndexState()!=='complete')throw Error('Native indexing did not complete');}
  finally{cg.close();}
  output=staging;await codegraphState(await safe(output));
 }else{
  const native=await import(pathToFileURL(resolve(packagePath,'dist/integrations/core/session-manager.js')).href);
  const state=await import(pathToFileURL(resolve(packagePath,'dist/generation/run-state.js')).href);
  const repo=await safe(staging);await mkdir(repo,{recursive:true,mode:0o700});
  const repoInfo=await nativeTarget(repo);
  // A malformed unpublished checkpoint is retained for inspection. The fresh
  // attempt is still confined to the original authorized staging scope.
  try{await state.readRepositoryRunState(repo);}catch{
   await quarantine(staging,repoInfo);await mkdir(await safe(staging),{mode:0o700});
  }
  await exec('git',['-C',repo,'-c','init.templateDir=','-c','core.hooksPath=/dev/null','init','-q'],{timeout:10000});
  const manager=native.HostSessionManager.create({host:'codex'});
  await manager.begin({root:repo,mode:'init'});
  await openwikiState(repo);output=staging+'/openwiki';
 }
 const path=await safe(output),sourceInfo=await nativeTarget(path);
 await safeTree(path);await flushTree(path);
 const receipt={root,id,target,version,identity:identity(sourceInfo)};
 await durable(control+'/promotion.json',receipt);
 // The marker is durable before promotion. A crash on either side of rename
 // is distinguished by the target directory identity during reconciliation.
 let cleared=false;
 await renameNative(output,target,sourceInfo,async destination=>{
  if(!cleared){
   const current=await empty(destination);
   if(!sameEntry(current,initialTarget))throw Error('Native target changed before promotion');
   if(process.platform!=='win32')return;
   // Windows cannot rename over a directory. Remove the original empty
   // target once and require the name to stay vacant on every retry.
   if(current)await rmdir(destination);
   cleared=true;
  }
  if(await nativeTarget(destination))throw Error('Native target appeared before promotion');
 });
 await syncDirectory(root);
 return query();
}
try{
 if(adapterDigest!==createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex')||!['initialize','query'].includes(action)||!['openwiki','codegraph'].includes(id)||await realpath(root)!==root||control!=='.rigup/native/'+id||staging!==(id==='openwiki'?control+'/repository':'.codegraph-rigup-init'))throw Error('Invalid native adapter parameters');
 rootInfo=await nativeTarget(root);
 if(!rootInfo?.isDirectory())throw Error('Native project root is not a directory');
 const result=action==='query'?await query():await initialize();process.stdout.write(JSON.stringify(result)+'\n');
}catch(error){
 if(action==='initialize'&&rootInfo){try{await writeFile(await safe(control+'/failure.json'),JSON.stringify({message:String(error.message),at:new Date().toISOString()})+'\n',{mode:0o600});}catch{}}
 process.stderr.write('Native '+id+' '+action+' could not be verified: '+error.message+'\n');process.exitCode=1;
}
