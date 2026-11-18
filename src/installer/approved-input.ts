import {isAbsolute,posix,relative,resolve,sep} from 'node:path';
import {readFile} from 'node:fs/promises';
import {scanInstallationSources,scanNativeEntries} from '../analyzer/repository.js';
import {digest,safePath} from '../analyzer/evidence.js';
import {loadResearchIgnore,researchPathExcluded,workflowEvidenceKind} from '../analyzer/research-ignore.js';
import {signature} from '../generator/cache.js';
import {assertOpenSpecRuntime} from '../integrations/sdd/openspec-setup.js';
import {selectedChecks,type ProjectCheck} from '../integrations/tools/check-catalog.js';
import {resolveProjectChecks} from '../integrations/tools/quality.js';
import {scopeContains,type SetupPlan} from '../types.js';
import {absentDigest,readFileState} from './file-state.js';
import {checkClaimSelection} from './claim.js';

export function approvedAuthorityPaths(plan:SetupPlan):Set<string>{
 return new Set([
  ...plan.harness?.guidance.flatMap(binding=>binding.sourceRef&&['reusable','partial'].includes(binding.coverageStatus)?[binding.sourceRef.path]:[])??[],
  ...plan.harnessNavigation?.notApplicable?.map(binding=>binding.path)??[],
 ]);
}

export async function resolveAuthorityTarget(root:string,path:string):Promise<string>{
 const target=relative(root,await safePath(root,path)).split(sep).join('/');
 if(researchPathExcluded(path)||researchPathExcluded(target))throw Error('Approved rule source unavailable: '+path);
 return target;
}

export async function approvedInputs(root:string,plan:SetupPlan,managed:string[],stateRoot?:string){
 if(plan.openSpecRuntime){
  try{await assertOpenSpecRuntime(root,plan.options,plan.openSpecRuntime,stateRoot);}
  catch{throw Error('OpenSpec runtime or project entry changed: openspec/config.yaml');}
 }
 const values=new Map<string,string>();
 if(plan.claim){
  await checkClaimSelection(root,plan);
  const config='.rigup/config.yaml';
  values.set(config,(await readFileState(root,config)).digest);
  const sources=new Set(plan.assets.filter(asset=>['customer-template','customer-skill'].includes(asset.source.kind)).map(asset=>asset.source.ref));
  const configDigests=Object.entries(plan.claim.configDigests??{});
  for(const [path] of configDigests)if(path!==config)sources.add(path);
  if(!plan.claim.configDigests&&plan.options.profile)sources.add(resolve(root,plan.options.profile));
  for(const source of sources)values.set(source,digest(await readFile(source).catch(()=>{throw Error('Cannot read approved input: '+source);})));
  for(const [path,expected] of configDigests){
   if(values.get(path)!==expected)throw Error('Claim configuration changed while resolving options: '+path);
  }
  return {values:Object.fromEntries(values),checks:[]};
 }
 const authority=approvedAuthorityPaths(plan);
 const ignore=authority.size?await loadResearchIgnore(root):undefined;
 const workflow=plan.options.projectRules?'all':plan.options.sdd==='spec-kit'?'spec-kit':undefined;
 const selectors=[...plan.runChecks??[],...plan.options.quality?.preCommit??[],...plan.options.quality?.prePush??[],...plan.options.quality?.gitlab?.checks??[]];
 const scopes=[...managed,...plan.operations.filter(operation=>operation.kind==='initialize').flatMap(operation=>operation.declaredWrites)];
 const profile=selectors.length||plan.options.sdd==='spec-kit'?await scanInstallationSources(root,plan.options,scopes):undefined;
 const paths=new Set(['.rigup/config.yaml','.rigupignore',...authority,...(plan.options.sdd==='spec-kit'?profile?.files.filter(path=>path.startsWith('.specify/'))??[]:[])]);
 for(const path of paths){
  if(managed.includes(path))continue;
  const isAuthority=authority.has(path);
  const actual=isAuthority?await resolveAuthorityTarget(root,path).catch(()=>{throw Error('Cannot read approved input: '+path);}):path;
  if(isAuthority&&[path,actual].some(target=>ignore?.excludes(target,false)||
    workflow&&workflowEvidenceKind(target,false,workflow)))throw Error('Approved rule source unavailable: '+path);
  const content=managed.includes(actual)?undefined:await readFileState(root,actual).catch(()=>{throw Error('Cannot read approved input: '+path);});
  if(isAuthority&&(!content?.bytes&&!managed.includes(actual)||await resolveAuthorityTarget(root,path)!==actual))throw Error('Approved rule source unavailable: '+path);
  const hash=content?.digest??absentDigest;
  values.set(path,actual===path?hash:signature([actual,hash]));
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
