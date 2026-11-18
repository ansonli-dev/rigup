import {isAbsolute,posix} from 'node:path';
import {scanInstallationSources,scanNativeEntries} from '../analyzer/repository.js';
import {digest} from '../analyzer/evidence.js';
import {signature} from '../generator/cache.js';
import {assertOpenSpecRuntime} from '../integrations/sdd/openspec-setup.js';
import {selectedChecks,type ProjectCheck} from '../integrations/tools/check-catalog.js';
import {resolveProjectChecks} from '../integrations/tools/quality.js';
import {scopeContains,type SetupPlan} from '../types.js';
import {absentDigest,readFileState} from './file-state.js';

export async function approvedInputs(root:string,plan:SetupPlan,managed:string[],stateRoot?:string){
 if(plan.openSpecRuntime){
  try{await assertOpenSpecRuntime(root,plan.options,plan.openSpecRuntime,stateRoot);}
  catch{throw Error('OpenSpec runtime or project entry changed: openspec/config.yaml');}
 }
 const values=new Map<string,string>();
 const authority=[
  ...plan.harness?.guidance.flatMap(binding=>binding.sourceRef&&['reusable','partial'].includes(binding.coverageStatus)?[binding.sourceRef.path]:[])??[],
  ...plan.harnessNavigation?.notApplicable?.map(binding=>binding.path)??[],
 ];
 const selectors=[...plan.runChecks??[],...plan.options.quality?.preCommit??[],...plan.options.quality?.prePush??[],...plan.options.quality?.gitlab?.checks??[]];
 const scopes=[...managed,...plan.operations.filter(operation=>operation.kind==='initialize').flatMap(operation=>operation.declaredWrites)];
 const profile=selectors.length||plan.options.sdd==='spec-kit'?await scanInstallationSources(root,plan.options,scopes):undefined;
 const paths=new Set(['.rigup/config.yaml','.rigupignore',...authority,...(plan.options.sdd==='spec-kit'?profile?.files.filter(path=>path.startsWith('.specify/'))??[]:[])]);
 for(const path of paths){
  if(managed.includes(path))continue;
  const {bytes}=await readFileState(root,path).catch(()=>{throw Error('Cannot read approved input: '+path);});
  if(!bytes&&authority.includes(path))throw Error('Approved rule source unavailable: '+path);
  values.set(path,bytes?digest(bytes):absentDigest);
 }
 if(plan.options.sdd||plan.options.customSkills?.length){
  const native=profile??await scanNativeEntries(root,plan.options);
  for(const [host,sources] of Object.entries(native.skillSources??{})){
   for(const source of sources){
    if(!isAbsolute(source.identity)&&managed.some(target=>scopeContains(target,source.identity)))continue;
    const key='native '+host+' '+source.identity;
    const prior=values.get(key);
    values.set(key,signature([prior,source]));
   }
  }
 }
 const checks=profile?resolveProjectChecks(profile,plan.runChecks??[],plan.options):[];
 const declarationFiles=new Map<string,Set<string>>();
 const addCheck=({source,command}:ProjectCheck)=>{
  if(command.executable!=='npm'||command.args[0]!=='run'||!command.args[1])return;
  const scripts=declarationFiles.get(source)??new Set<string>();
  const name=command.args[1];
  scripts.add(name);scripts.add('pre'+name);scripts.add('post'+name);
  declarationFiles.set(source,scripts);
 };
 if(profile)for(const {check} of selectedChecks(profile,selectors))if(check)addCheck(check);
 for(const check of plan.harness?.checks??[])addCheck(check);
 for(const check of checks){
  if(check.command?.executable==='npm'&&check.command.args[0]==='run')
   addCheck({command:check.command,source:posix.join(check.command.cwd,'package.json')});
 }
 for(const [path,names] of declarationFiles){
  const input=await readFileState(root,path).catch(()=>{throw Error('Cannot read approved check input: '+path);});
  if(!input.bytes){values.set(path,absentDigest);continue;}
  try{
   const scripts=JSON.parse(input.bytes.toString('utf8')).scripts;
   const declarations=signature([...names].sort().map(name=>[name,scripts?.[name]??null]));
   const referenced=values.get(path);
   values.set(path,referenced?signature([referenced,declarations]):declarations);
  }catch{throw Error('Cannot read approved check input: '+path);}
 }
 return {values:Object.fromEntries(values),checks};
}
