import {execFile,spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {constants,lstat,open,readdir,readFile,realpath} from 'node:fs/promises';
import {delimiter,dirname,join} from 'node:path';
import {promisify} from 'node:util';
import ignore from 'ignore';
import {digest} from '../../analyzer/evidence.js';
import {signature} from '../../generator/cache.js';
import {defaultStateRoot} from '../../installer/lock.js';
import {atomicProjectWrite} from '../../installer/manifest.js';
import {installStandaloneOpenSpec} from '../../installer/operations.js';
import {ownedContent,replaceOwned,targetPath} from '../../installer/ownership.js';
import {readTarget} from '../../installer/preview.js';
import {readFileState} from '../../installer/file-state.js';
import {npmPathDirectories} from '../../npm-command.mjs';
import {readDurableRecord,saveDurable} from '../../private-record.js';
import {essentialEnvironment,hasGitMetadata} from '../../runtime-private-env.js';
import {readVerifiedToolInstall,type ToolInstallReceipt} from '../tools/installed-state.js';
import {softwareInstallRecipe,toolPackage} from '../tools/recipes.js';
import type {OpenSpecPreparation} from './openspec-setup.js';

const exec=promisify(execFile);
const projectTool=toolPackage('openspec');
const ignoreTarget='.rigup/.gitignore';
export const localIgnoreOwnership={kind:'block' as const,start:'# rigup:start',end:'# rigup:end'};
export const localIgnoreContent=[localIgnoreOwnership.start,'/baseline/','/manifest.json','/native/','/tools/','/check-results/','/.env','/.env.rigup-*.tmp',localIgnoreOwnership.end,''].join('\n');

export interface OpenSpecPreparationRecord {
 version:1;
 root:string;
 approval:OpenSpecPreparation;
 approvalDigest:string;
 complete:boolean;
 projectReceipt?:ToolInstallReceipt;
 projectPayloadDigest?:string;
 installedCliIdentity?:string;
}
const preparationPath=(root:string,stateRoot:string)=>join(stateRoot,'openspec-preparation-'+signature(root)+'.json');
export function readOpenSpecPreparation(root:string,stateRoot=defaultStateRoot()){
 return readDurableRecord<OpenSpecPreparationRecord>(preparationPath(root,stateRoot),'OpenSpec preparation',value=>
  value.version===1&&value.root===root&&typeof value.complete==='boolean'&&value.approval?.root===root&&value.approvalDigest===signature(value.approval));
}
export function saveOpenSpecPreparation(record:OpenSpecPreparationRecord,stateRoot:string){
 return saveDurable(preparationPath(record.root,stateRoot),JSON.stringify(record));
}

async function projectPayloadDigest(modules:string){
 // OpenSpec can execute code from both its package and installed dependencies.
 const hash=createHash('sha256');
 let entries=0,bytes=0;
 async function visit(directory:string){
  const children=await readdir(join(modules,directory),{withFileTypes:true});
  children.sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
  for(const child of children){
   const target=directory+child.name;
   if(child.name==='.bin'&&(!directory||directory.endsWith('/node_modules/')))continue;
   if(++entries>16_000)throw Error('OpenSpec package exceeds verification budget');
   if(child.isDirectory()){await visit(target+'/');continue;}
   if(!child.isFile())throw Error('OpenSpec package contains an unexpected file type');
   const handle=await open(await targetPath(modules,target),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
   try{
    const {size}=await handle.stat();
    bytes+=size;
    if(bytes>128_000_000)throw Error('OpenSpec package exceeds verification budget');
    const data=Buffer.alloc(size);
    if((await handle.read(data)).bytesRead!==size||(await handle.stat()).size!==size)throw Error('OpenSpec package changed during verification');
    hash.update(JSON.stringify([target,digest(data)]));
   }finally{await handle.close();}
  }
 }
 await visit('');
 return hash.digest('hex');
}

function openSpecModules(root:string,prefix=projectTool.prefix){
 return targetPath(root,prefix+'/node_modules');
}

export async function verifiedProjectOpenSpec(root:string,stateRoot?:string){
 const record=await readOpenSpecPreparation(root,stateRoot);
 if(!record?.projectReceipt)return;
 const identity=await readVerifiedToolInstall(root,'openspec',record.projectReceipt);
 if(!identity)throw Error('Project OpenSpec installation differs from its receipt. Reconcile .rigup/tools/openspec before continuing.');
 const modules=await openSpecModules(root);
 const payload=await projectPayloadDigest(modules);
 if(payload!==record.projectPayloadDigest)throw Error('Project OpenSpec payload differs from its receipt. Reconcile .rigup/tools/openspec before continuing.');
 const packageRoot=await targetPath(modules,projectTool.name);
 const metadata=JSON.parse(await readFile(await targetPath(packageRoot,'package.json'),'utf8'));
 const relative=typeof metadata.bin==='string'?metadata.bin:metadata.bin?.openspec;
 if(typeof relative!=='string'||!/^[\w./-]+\.(?:c|m)?js$/i.test(relative))throw Error('Invalid OpenSpec CLI entry');
 const entry=await targetPath(packageRoot,relative.replace(/^\.\//,''));
 return {file:process.execPath,args:[entry],source:'project' as const,version:identity.version,
  identity:signature({root,entry,payload,receipt:record.projectReceipt})};
}

async function gitIgnoreCheck(root:string,target:string,proposed:string,writeIgnore?:()=>Promise<void>){
 if(!ignore().add(proposed).ignores(target.slice('.rigup/'.length)+'/'))
  throw Error(target+' must be effectively ignored. Repair the user ignore rules before preparing OpenSpec.');
 if(!await hasGitMetadata(root)){await writeIgnore?.();return;}
 const path=(await npmPathDirectories(root,process.env.PATH??process.env.Path??'')).join(delimiter);
 const env={...essentialEnvironment()};
 for(const name of Object.keys(env))if(/^path$/i.test(name))delete env[name];
 env.PATH=path;
 const git=(args:string[])=>exec('git',['-C',root,...args],{env,maxBuffer:256_000,timeout:5000});
 if((await git(['rev-parse','--is-inside-work-tree'])).stdout.trim()!=='true')throw Error('Cannot verify the Git worktree for '+target);
 const tracked=await git(['ls-files','-z','--',':(icase,literal)'+target]);
 if(tracked.stdout)throw Error(target+' has tracked files. Preserve them and reconcile the OpenSpec install scope.');
 await writeIgnore?.();
 try{await git(['check-ignore','--quiet','--no-index','--',target+'/']);}
 catch{throw Error(target+' must be effectively ignored by Git. Repair the ignore rules before preparing OpenSpec.');}
}

async function protectProjectOpenSpec(root:string){
 const previous=await readFileState(root,ignoreTarget);
 const text=previous.bytes?.toString('utf8');
 const prior=ownedContent(text,localIgnoreOwnership);
 const block=prior?.split(/\r?\n/).includes('/tools/')?prior:
  prior?prior.replace(localIgnoreOwnership.end,'/tools/\n'+localIgnoreOwnership.end):localIgnoreContent;
 const candidate=replaceOwned(text,localIgnoreOwnership,block)!;
 await gitIgnoreCheck(root,projectTool.prefix,candidate,candidate===text?undefined:async()=>{
  await atomicProjectWrite(root,ignoreTarget,Buffer.from(candidate),previous.mode??0o644,false,async()=>{
   const current=await readFileState(root,ignoreTarget);
   if(current.digest!==previous.digest||current.mode!==previous.mode)throw Error('OpenSpec ignore file changed during preparation');
  });
 });
}

export async function installProjectOpenSpec(root:string,record:OpenSpecPreparationRecord,stateRoot:string,signal?:AbortSignal,recover?:boolean){
 const {approval}=record;
 if(approval.kind!=='project-install')throw Error('Invalid OpenSpec project approval');
 const {version,packageIntegrity,registry,enginesNode}=approval.install;
 await protectProjectOpenSpec(root);
 const operation=softwareInstallRecipe(root,'openspec',version,packageIntegrity,undefined,registry,enginesNode);
 const result=await installStandaloneOpenSpec(root,operation,record.approvalDigest,{
  signal,stateRoot,verifyInstallScope:async target=>{
   const rules=await readTarget(root,ignoreTarget);
   if(!rules)throw Error('OpenSpec tool ignore file disappeared');
   await gitIgnoreCheck(root,target,rules.toString('utf8'));
  },verifyInstallPayload:async target=>{
   const payload=await projectPayloadDigest(await openSpecModules(root,target));
   if(record.projectPayloadDigest&&record.projectPayloadDigest!==payload)throw Error('Staged OpenSpec payload changed after verification');
   if(!record.projectPayloadDigest){
    record.projectPayloadDigest=payload;
    await saveOpenSpecPreparation(record,stateRoot);
   }
  },
 },recover);
 if(result.status!=='done'||!result.receipt)throw Error(result.message);
 if(!record.projectPayloadDigest||await projectPayloadDigest(await openSpecModules(root))!==record.projectPayloadDigest)
  throw Error('Project OpenSpec payload differs from the verified staging');
 record.projectReceipt=result.receipt;
 await saveOpenSpecPreparation(record,stateRoot);
}

export async function forwardProjectOpenSpec(cwd:string,argv:string[],stateRoot?:string,signal?:AbortSignal):Promise<number>{
 let root=await realpath(cwd);
 for(;;root=dirname(root)){
  const command=await verifiedProjectOpenSpec(root,stateRoot);
  if(command){
   const child=spawn(command.file,[...command.args,...argv],{cwd:root,stdio:'inherit',signal,windowsHide:true});
   return new Promise((done,fail)=>{
    child.once('error',fail);child.once('exit',code=>done(code??1));
   });
  }
  if(dirname(root)===root||await lstat(join(root,'.git')).catch(()=>undefined))break;
 }
 throw Error('No verified project OpenSpec installation. Run Rigup OpenSpec preparation from the project root.');
}
