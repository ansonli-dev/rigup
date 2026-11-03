import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm,readFile,writeFile,mkdir,copyFile,lstat,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,relative,dirname,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
const exec=promisify(execFile);
const relativePath=p=>typeof p==='string'&&p&&!isAbsolute(p)&&!p.includes('\\')&&!p.split('/').includes('..');
function checkEnv(root,snapshot){const env={...process.env,PWD:snapshot};for(const key of Object.keys(env))if(/^GIT_|^npm_/i.test(key)||key==='NODE_PATH')delete env[key];env.PATH=(env.PATH??'').split(':').filter(p=>!p.startsWith(root+'/node_modules/')).join(':');return env;}
async function commandResult(command,snapshot,root){
 if(!command||typeof command.executable!=='string'||!Array.isArray(command.args)||command.args.some(a=>typeof a!=='string')||!relativePath(command.cwd)||!Array.isArray(command.envRefs))throw Error('Invalid structured snapshot command');
 const startedAt=new Date().toISOString(),start=Date.now();const missing=command.envRefs.filter(name=>!process.env[name]);
 if(missing.length)return {command,status:'pending',exitCode:3,startedAt,finishedAt:new Date().toISOString(),durationMs:0,reason:'Missing environment references: '+missing.join(', ')};
 const cwd=resolve(snapshot,command.cwd);const canonical=await realpath(cwd);if(relative(snapshot,canonical).startsWith('..'))throw Error('Snapshot command cwd escapes isolated tree');
 const child=spawn(command.executable,command.args,{cwd,env:checkEnv(root,snapshot),shell:false,detached:true,stdio:'ignore'});
 const result=await new Promise(resolveResult=>{
  let timedOut=false;const timeout=setTimeout(()=>{timedOut=true;try{process.kill(-child.pid,'SIGKILL');}catch{}},60000);
  child.once('error',()=>{clearTimeout(timeout);resolveResult({exitCode:1,status:'failed',reason:'Executable unavailable in isolated snapshot; configure snapshot dependencies explicitly'});});
  child.once('close',(code,signal)=>{clearTimeout(timeout);let remaining=false;try{process.kill(-child.pid,0);remaining=true;process.kill(-child.pid,'SIGKILL');}catch{}
   resolveResult({exitCode:timedOut||remaining?1:code??1,status:!timedOut&&!remaining&&code===0?'passed':'failed',...(code!==0||timedOut||remaining?{reason:'Snapshot check failed; dependencies must be available inside the snapshot, never the worktree'}:{})});});
 });
 return {command,...result,startedAt,finishedAt:new Date().toISOString(),durationMs:Date.now()-start};
}
export async function runSnapshot({root,mode,commands,input='',maxCommits=100,reportPaths=[]}){
 root=await realpath(root);if(!['pre-commit','pre-push','ci'].includes(mode)||!Array.isArray(commands)||!Number.isSafeInteger(maxCommits)||maxCommits<1)throw Error('Invalid snapshot selection');
 const git=async args=>(await exec('git',['-C',root,...args],{maxBuffer:128*1024*1024})).stdout.trim();
 const commits=[];
 if(mode==='pre-commit')commits.push({tree:await git(['write-tree'])});
 else if(mode==='ci'){const commit=await git(['rev-parse','--verify','HEAD']);if(process.env.CI_COMMIT_SHA&&process.env.CI_COMMIT_SHA!==commit)throw Error('CI input commit does not match checkout');commits.push({commit,tree:await git(['rev-parse',commit+'^{tree}'])});}
 else {
  const ids=new Set();for(const line of input.trim().split('\n').filter(Boolean)){
   const fields=line.trim().split(/\s+/);if(fields.length!==4||![fields[1],fields[3]].every(v=>/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(v)))throw Error('Invalid pre-push reference input');
   const [,local,,remote]=fields;if(/^0+$/.test(local))continue;const range=/^0+$/.test(remote)?local:remote+'..'+local;
   for(const commit of (await git(['rev-list','--reverse','--max-count='+String(maxCommits+1),range])).split('\n').filter(Boolean))ids.add(commit);
  }
  if(ids.size>maxCommits)throw Error('Push exceeds configured snapshot commit budget; review the range explicitly');
  for(const commit of ids)commits.push({commit,tree:await git(['rev-parse',commit+'^{tree}'])});
 }
 const snapshots=[];let exitCode=0;
 for(const selected of commits){
  const entries=(await exec('git',['-C',root,'ls-tree','-rz',selected.tree],{maxBuffer:128*1024*1024})).stdout.split('\0').filter(Boolean);
  for(const entry of entries){const mode=entry.split(' ')[0],path=entry.slice(entry.indexOf('\t')+1);if(!['100644','100755'].includes(mode)||!relativePath(path))throw Error('Snapshot contains symlink/submodule/unsupported path; configure a safe snapshot adapter');}
  const snapshot=await realpath(await mkdtemp(join(tmpdir(),'project-check-')));
  try{
   const archive=(await exec('git',['-C',root,'archive','--format=tar',selected.tree],{encoding:'buffer',maxBuffer:128*1024*1024})).stdout;
   await new Promise((done,reject)=>{const tar=spawn('tar',['-xf','-','-C',snapshot],{stdio:['pipe','ignore','ignore']});tar.once('error',reject);tar.once('close',code=>code===0?done():reject(Error('Cannot extract isolated Git snapshot')));tar.stdin.on('error',reject);tar.stdin.end(archive);});
   const results=[];for(const command of commands){const result=await commandResult(command,snapshot,root);results.push(result);if(!exitCode&&result.exitCode)exitCode=result.exitCode;}
   const record={...selected,mode,environment:{node:process.version,platform:process.platform},checkedAt:new Date().toISOString(),commands:results,artifacts:[]};
   if(mode==='ci')for(const path of reportPaths){
    if(!relativePath(path))throw Error('Invalid existing report path');const source=join(snapshot,path);try{const stat=await lstat(source);if(!stat.isFile()||relative(snapshot,await realpath(source)).startsWith('..'))throw Error('Report must be a regular file in snapshot');const target=join(root,'rigup-reports',selected.commit,path);await mkdir(dirname(target),{recursive:true});await copyFile(source,target);record.artifacts.push(relative(root,target));}catch(e){if(e.code!=='ENOENT')throw e;record.artifacts.push(path+': not produced');}
   }
   snapshots.push(record);
  }finally{await rm(snapshot,{recursive:true,force:true});}
 }
 return {exitCode,snapshots};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{const [mode,path]=process.argv.slice(2);const config=JSON.parse(await readFile(path,'utf8'));const root=await realpath(process.cwd());let input='';if(mode==='pre-push')for await(const chunk of process.stdin)input+=chunk;
 const commands=mode==='pre-commit'?config.preCommit:mode==='pre-push'?config.prePush:config.ci;
 const report=await runSnapshot({root,mode,commands:commands??[],input,maxCommits:config.maxCommits??100,reportPaths:config.reportPaths??[]});
 if(mode==='ci'){await mkdir(join(root,'rigup-reports'),{recursive:true});await writeFile(join(root,'rigup-reports/checks.json'),JSON.stringify(report,null,2)+'\n');}
 process.stdout.write(JSON.stringify(report)+'\n');process.exitCode=report.exitCode;
 }catch{process.stderr.write('Snapshot check unavailable; inspect the selected range, dependencies and snapshot configuration. Worktree fallback is disabled.\n');process.exitCode=1;}
}
