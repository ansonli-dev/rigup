import {realpath} from 'node:fs/promises';
import {dirname,join,matchesGlob,relative} from 'node:path';
import {parse} from 'yaml';
import type {ProjectProfile} from '../../analyzer/repository.js';
import {isRecord} from '../../private-record.js';
import {sddDiscoveryNames} from '../sdd/binding.js';
import {canonicalHostDirectory,checkedDirectory,nativeJson,readNativeFile,statIfPresent,withinPath} from './host-files.js';
import {ompPackage} from './manual.js';
import {assertOmpEnvironmentFiles,ompLocations} from './omp-locations.js';
import {storePackage,verifyOmpStore} from './omp-archive.js';
import {ompVersion} from './pins.js';
import {bindingFrom} from './receipt.js';
import {nativeChildEnv,type HostRuntime} from './runtime.js';
export {downloadOmp,installOmpStore,parseOmpTar} from './omp-archive.js';

const strings=(value:unknown):string[]=>Array.isArray(value)&&value.every(x=>typeof x==='string')?value:[];
const asRecord=(value:unknown)=>isRecord(value)?value:{};

export async function inspectOmp(runtime:Pick<HostRuntime,'root'|'home'|'env'|'stateRoot'>,{forWrite=true}={}){
 const {root,home,env}=runtime,resolved=await ompLocations(home,env);
 const [agent,base,plugins,state,cache]=await Promise.all([resolved.agent,resolved.base,resolved.plugins,resolved.state,resolved.cache].map(canonicalHostDirectory));
 const locations={...resolved,agent,base,plugins,state,cache};
 const store=storePackage(runtime),target=join(plugins,'node_modules',ompPackage);
 const lock=join(plugins,'omp-plugins.lock.json'),manifest=join(plugins,'package.json');
 const overrides=['.omp','.pi'].map(dir=>join(root,dir,'plugin-overrides.json'));
 const projectPlugins=join(root,'.omp','plugins');
 const json=async(path:string,label:string)=>{
  try{return (await nativeJson(path))?.value;}
  catch{throw Error('Invalid, redirected or unreadable OMP '+label+'; reconcile it manually');}
 };
 if([agent,base,plugins,state,cache].some(path=>withinPath(root,path)))throw Error('OMP locations overlap the project');
 const projectDir=join(root,'.omp');
 const paths=[agent,base,plugins,state,cache,projectDir,projectPlugins,join(root,'.pi'),join(root,'.claude'),dirname(target),store];
 for(const dir of paths)await checkedDirectory(dir);
 if(forWrite)await assertOmpEnvironmentFiles(home,env,locations);
 let settings:Record<string,unknown>={};
 for(const directory of [agent,projectDir]){
  let value=await json(join(directory,'settings.json'),'settings')??{};
  let first:Record<string,unknown>|undefined;
  for(const name of ['config.yml','config.yaml']){
   const path=join(directory,name);
   try{
    const data=await readNativeFile(path);
    if(!data)continue;
    const parsed:unknown=parse(data.bytes.toString('utf8'),{uniqueKeys:true,maxAliasCount:20});
    if(!isRecord(parsed)||first||directory===projectDir&&name==='config.yaml')throw Error('unsupported settings overlay');
    first=parsed;
   }catch{throw Error('Invalid, redirected or ambiguous OMP '+name+'; reconcile it manually');}
  }
  value=first??value;
  if(value.skills!==undefined&&!isRecord(value.skills))throw Error('Unrecognized OMP skill settings');
  settings={...settings,...value,skills:{...asRecord(settings.skills),...asRecord(value.skills)}};
 }
 const skills=asRecord(settings.skills);
 for(const [key,value] of [['enabledProviders',settings.enabledProviders],['disabledProviders',settings.disabledProviders],
  ['disabledExtensions',settings.disabledExtensions],['ignoredSkills',skills.ignoredSkills],['includeSkills',skills.includeSkills],
  ['customDirectories',skills.customDirectories],['extensions',settings.extensions]] as const)
  if(value!==undefined&&(!Array.isArray(value)||value.some(x=>typeof x!=='string')))throw Error('Unrecognized OMP '+key+' settings');
 const disabled=strings(settings.disabledProviders),extensions=strings(settings.disabledExtensions);
 const projectOverrides=(await Promise.all(overrides.map(path=>json(path,'project plugin overrides')))).find(value=>value!==undefined);
 if(projectOverrides?.disabled!==undefined&&(!Array.isArray(projectOverrides.disabled)||projectOverrides.disabled.some(value=>typeof value!=='string')))
  throw Error('Unrecognized OMP project plugin overrides');
 if(skills.enabled===false||skills.enablePiProject===false||disabled.includes('omp-plugins')||extensions.includes(ompPackage)||
    strings(projectOverrides?.disabled).includes(ompPackage))
  throw Error('The OMP plugin, provider, or skills are explicitly disabled');
 if(strings(skills.customDirectories).length||strings(settings.extensions).length||sddDiscoveryNames('superpowers',false).some(name=>
    strings(skills.ignoredSkills).some(pattern=>matchesGlob(name,pattern))||extensions.includes('skill:'+name)||
    strings(skills.includeSkills).length&&!strings(skills.includeSkills).some(pattern=>matchesGlob(name,pattern))))
  throw Error('OMP custom configuration excludes required skills or may shadow their sources; prepare manually');
 // These legacy/project records can shadow the same package without the user lock.
 for(const directory of [plugins,projectPlugins]){
  const legacy=await json(join(directory,'installed_plugins.json'),'legacy plugin registry');
  if(Object.hasOwn(asRecord(legacy?.plugins),ompPackage))throw Error('An existing OMP plugin registry shadows this package');
  if(directory===projectPlugins){
   const localLock=await json(join(directory,'omp-plugins.lock.json'),'project plugin lock');
   const pkg=await json(join(directory,'package.json'),'project plugin dependencies');
   if(Object.hasOwn(asRecord(localLock?.plugins),ompPackage)||Object.hasOwn(asRecord(pkg?.dependencies),ompPackage)||
      await statIfPresent(join(directory,'node_modules',ompPackage)))
    throw Error('A project OMP plugin installation shadows this package');
  }
 }
 const pkg=await json(manifest,'plugin dependencies');
 const stateFile=await json(lock,'plugin lock');
 if(stateFile&&(!isRecord(stateFile.plugins)||stateFile.settings!==undefined&&!isRecord(stateFile.settings))||
    pkg?.dependencies!==undefined&&!isRecord(pkg.dependencies))
  throw Error('Unrecognized OMP plugin lock or dependency shape');
 const entry=asRecord(stateFile?.plugins)[ompPackage],dependency=asRecord(pkg?.dependencies)[ompPackage];
 if(entry!==undefined&&(!isRecord(entry)||entry.enabled!==true||entry.enabledFeatures!==undefined&&entry.enabledFeatures!==null))
  throw Error('OMP Superpowers is disabled or its lock entry is unrecognized');
 if(isRecord(entry)&&entry.version!==ompVersion)throw Error('OMP Superpowers has a different version; reconcile it manually');
 if(dependency!==undefined)throw Error('OMP Superpowers is registered as a managed dependency; reconcile it manually');
 const type=await statIfPresent(target);
 const stored=await verifyOmpStore(store);
 if(type){
  const actual=await realpath(target).catch(()=>undefined);
  if(!type.isSymbolicLink()||!stored||!actual||relative(store,actual)!=='')
   throw Error('Existing OMP Superpowers is not linked to the verified store; reconcile it manually');
 }else if(entry!==undefined)throw Error('OMP Superpowers lock entry exists without its link; reconcile it manually');
 const status=entry!==undefined&&type?'linked':'missing';
 return {status,store,stored,locations,plugins,target,lock,manifest,paths:[...paths,target,lock,manifest,...overrides]};
}

export function ompRecognized(current:Awaited<ReturnType<typeof inspectOmp>>,profile:ProjectProfile){
 return current.status==='linked'&&bindingFrom(profile,'omp',current.store,ompPackage);
}

export const ompArgs=(path:string)=>['plugin','link',path,'--json'];
export function ompCommand(runtime:HostRuntime,path:string,temp:string){
 return {executable:runtime.program.file,args:[...runtime.program.args,...ompArgs(path)],env:nativeChildEnv(runtime,temp)};
}
