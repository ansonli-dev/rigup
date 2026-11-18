import {realpath} from 'node:fs/promises';
import {dirname,join,matchesGlob,relative,sep} from 'node:path';
import {parse} from 'yaml';
import type {ProjectProfile} from '../../analyzer/repository.js';
import {isRecord} from '../../private-record.js';
import {sddDiscoveryNames} from '../sdd/binding.js';
import {NativeBlocker} from './blockers.js';
import {canonicalHostDirectory,checkedDirectory,checkedFile,nativeJson,readNativeFile,statIfPresent,strictJson,withinPath} from './host-files.js';
import {ompPackage} from './manual.js';
import {analyzeOmpEnv} from './omp-env.js';
import {ompLocations} from './omp-locations.js';
import type {OmpPin} from './omp-pin.js';
import {bindingFrom} from './receipt.js';
import {nativeChildEnv,type HostRuntime} from './runtime.js';
export {downloadOmp,installOmpStore,parseOmpTar} from './omp-archive.js';

const strings=(value:unknown):string[]=>typeof value==='string'?[value]:Array.isArray(value)?value.filter(x=>typeof x==='string'):[];
const asRecord=(value:unknown)=>isRecord(value)?value:{};
const disabled=(reason:string,evidence:string[])=>new NativeBlocker('host-plugin-disabled',reason,{evidence});

const bunLockLimit=1_048_576;
type OmpInspection='existing'|'registry-preflight'|'registry-receipt';

async function readRegistryReceipt(target:string,bunLock:string,registered:boolean){
 const path=join(target,'package.json');
 try{
  const manifest=(await nativeJson(path))?.value;
  const file=await readNativeFile(bunLock,bunLockLimit);
  const packages=file&&strictJson(file.bytes.toString('utf8'),{jsonc:true}).packages;
  const tuple=asRecord(packages)[ompPackage],version=manifest?.version;
  if(!registered||manifest?.name!==ompPackage||typeof version!=='string'||
     !Array.isArray(tuple)||tuple.length!==4||tuple[0]!==ompPackage+'@'+version||
     typeof tuple[1]!=='string'||!isRecord(tuple[2])||typeof tuple[3]!=='string')throw Error('Invalid registry receipt');
  return {version,integrity:tuple[3] as string};
 }catch{
  throw new NativeBlocker('omp-not-recognized-after-install','Could not verify the OMP registry receipt.',{evidence:[bunLock,path]});
 }
}

export async function inspectOmp(runtime:Pick<HostRuntime,'root'|'home'|'env'|'stateRoot'>,mode:OmpInspection='existing'){
 const {root,home,env}=runtime,resolved=await ompLocations(home,env);
 const [agent,base,plugins,state,cache]=await Promise.all([resolved.agent,resolved.base,resolved.plugins,resolved.state,resolved.cache].map(canonicalHostDirectory));
 const locations={...resolved,agent,base,plugins,state,cache};
 const modules=join(plugins,'node_modules'),target=join(modules,ompPackage);
 const lock=join(plugins,'omp-plugins.lock.json'),manifest=join(plugins,'package.json'),bunLock=join(plugins,'bun.lock');
 const overrides=['.omp','.pi'].map(dir=>join(root,dir,'plugin-overrides.json'));
 const projectPlugins=join(root,'.omp','plugins');
 const json=async(path:string,label:string)=>{
  try{return (await nativeJson(path))?.value;}
  catch{throw new NativeBlocker('prerequisite-unverified','Invalid, redirected or unreadable OMP '+label+'.',{evidence:[path]});}
 };
 const overlap=[agent,base,plugins,state,cache].find(path=>withinPath(root,path));
 if(overlap)throw new NativeBlocker('prerequisite-unverified','OMP user locations must be outside the project.',{evidence:[overlap]});
 const projectDir=join(root,'.omp');
 const paths=[agent,base,plugins,state,cache,projectDir,projectPlugins,join(root,'.pi'),join(root,'.claude'),modules,dirname(target)];
 for(const dir of paths)try{await checkedDirectory(dir);}
 catch{throw new NativeBlocker('prerequisite-unverified','An OMP destination is redirected or is not a directory.',{evidence:[dir]});}
 let settings:Record<string,unknown>={};
 const settingsPaths:string[]=[],shadowEvidence:string[]=[];
 for(const directory of [agent,projectDir]){
  let path=join(directory,'settings.json'),value:Record<string,unknown>|undefined;
  for(const name of directory===agent?['config.yml','config.yaml']:['config.yml']){
   const config=join(directory,name);
   try{
    const data=await readNativeFile(config);
    if(!data)continue;
    const parsed:unknown=parse(data.bytes.toString('utf8'),{uniqueKeys:true,maxAliasCount:20});
    if(parsed!==null&&!isRecord(parsed))throw Error('Invalid OMP settings');
    value=parsed??{};path=config;break;
   }catch{throw new NativeBlocker('prerequisite-unverified','Invalid, redirected or unreadable OMP settings.',{evidence:[config]});}
  }
  value??=await json(path,'settings');
  if(!value)continue;
  settingsPaths.push(path);
  if(value.skills!==undefined&&!isRecord(value.skills))
   throw new NativeBlocker('prerequisite-unverified','Unrecognized OMP skill settings.',{evidence:[path]});
  if(strings(asRecord(value.skills).customDirectories).length)shadowEvidence.push(path+' (skills.customDirectories)');
  if(strings(value.extensions).length)shadowEvidence.push(path+' (extensions)');
  settings={...settings,...value,skills:{...asRecord(settings.skills),...asRecord(value.skills)}};
 }
 const skills=asRecord(settings.skills);
 const extensions=strings(settings.disabledExtensions);
 if(skills.enabled===false||skills.enablePiProject===false||strings(settings.disabledProviders).includes('omp-plugins')||extensions.includes(ompPackage))
  throw disabled('The OMP plugin, provider, or skills are explicitly disabled.',settingsPaths);
 const ignored=strings(skills.ignoredSkills),included=strings(skills.includeSkills);
 if(sddDiscoveryNames('superpowers',false).some(name=>ignored.some(pattern=>matchesGlob(name,pattern))||extensions.includes('skill:'+name)||
    included.length&&!included.some(pattern=>matchesGlob(name,pattern))))
  throw disabled('OMP settings exclude required Superpowers skills.',settingsPaths);
 for(const path of overrides){
  const override=await json(path,'project plugin overrides');
  if(!override)continue;
  if(strings(override.disabled).includes(ompPackage))throw disabled('The project explicitly disables OMP Superpowers.',[path]);
  break;
 }
 for(const directory of [plugins,projectPlugins]){
  const registry=join(directory,'installed_plugins.json'),legacy=await json(registry,'legacy plugin registry');
  const records=asRecord(legacy?.plugins)[ompPackage];
  if(Array.isArray(records)&&records.length&&records.every(record=>isRecord(record)&&record.enabled===false))
   throw disabled('OMP Superpowers is explicitly disabled in the plugin registry.',[registry]);
  if(records!==undefined)shadowEvidence.push(registry);
  if(directory===projectPlugins){
   const localLock=join(directory,'omp-plugins.lock.json'),localManifest=join(directory,'package.json');
   const localTarget=join(directory,'node_modules',ompPackage);
   const localEntry=asRecord((await json(localLock,'project plugin lock'))?.plugins)[ompPackage];
   if(isRecord(localEntry)&&localEntry.enabled===false)throw disabled('The project explicitly disables OMP Superpowers.',[localLock]);
   if(localEntry!==undefined)shadowEvidence.push(localLock);
   if(Object.hasOwn(asRecord((await json(localManifest,'project plugin dependencies'))?.dependencies),ompPackage))shadowEvidence.push(localManifest);
   if(await statIfPresent(localTarget))shadowEvidence.push(localTarget);
  }
 }
 const pkg=await json(manifest,'plugin dependencies');
 const stateFile=await json(lock,'plugin lock');
 if(stateFile&&(!isRecord(stateFile.plugins)||stateFile.settings!==undefined&&!isRecord(stateFile.settings))||
    pkg?.dependencies!==undefined&&!isRecord(pkg.dependencies))
  throw new NativeBlocker('prerequisite-unverified','Unrecognized OMP plugin lock or dependency shape.',{evidence:[lock,manifest]});
 const entry=asRecord(stateFile?.plugins)[ompPackage];
 if(isRecord(entry)&&entry.enabled===false)throw disabled('OMP Superpowers is explicitly disabled in the plugin lock.',[lock]);
 if(entry!==undefined&&!isRecord(entry))
  throw new NativeBlocker('host-plugin-broken','The OMP Superpowers lock entry is invalid.',{evidence:[lock]});
 const dependencies=asRecord(pkg?.dependencies);
 const registered=entry!==undefined||Object.hasOwn(dependencies,ompPackage);
 if(mode==='registry-preflight')try{await checkedFile(bunLock,{limit:bunLockLimit});}
 catch{throw new NativeBlocker('prerequisite-unverified','Invalid, redirected or unreadable OMP Bun lock.',{evidence:[bunLock]});}
 const type=await statIfPresent(target);
 let linked:string|undefined,fromRegistry:Awaited<ReturnType<typeof readRegistryReceipt>>|undefined;
 if(mode==='registry-receipt'&&type?.isDirectory()){
  fromRegistry=await readRegistryReceipt(target,bunLock,typeof dependencies[ompPackage]==='string'&&isRecord(entry)&&entry.enabled===true);
 }else if(type){
  linked=mode==='existing'&&type.isSymbolicLink()?await realpath(target).catch(()=>undefined):undefined;
  const [folder,pkg,...extra]=linked?relative(join(runtime.stateRoot,'native-packages'),linked).split(sep):[];
  if(!linked||extra.length||pkg!=='package'||!/^omp-superpowers-[0-9][A-Za-z0-9.+-]{0,127}$/.test(folder))
   throw new NativeBlocker('omp-foreign-install',mode==='existing'?
    'Linking OMP Superpowers would replace an existing installation outside the Rigup store.':
    'OMP registry preparation cannot replace an existing Superpowers target.',{evidence:[target]});
 }
 const status=fromRegistry?'registry':linked?'linked':'missing';
 return {status,linked,fromRegistry,registered,locations,plugins,target,lock,manifest,bunLock,
  envReport:await analyzeOmpEnv(home,env,locations),shadowEvidence,
  paths:[...paths,target,lock,manifest,...(mode==='existing'?[]:[bunLock]),...overrides]};
}

export function ompRecognized(current:Awaited<ReturnType<typeof inspectOmp>>,profile:ProjectProfile,
 expected:{via:'link';store:string}|{via:'install';pin:OmpPin}){
 if(expected.via==='install')return current.fromRegistry?.version===expected.pin.version&&
  current.fromRegistry.integrity===expected.pin.integrity&&bindingFrom(profile,'omp',current.target,ompPackage);
 return !!current.linked&&relative(expected.store,current.linked)===''&&bindingFrom(profile,'omp',expected.store,ompPackage);
}

export const ompArgs=(path:string)=>['plugin','link',path,'--json'];
export function ompCommand(runtime:HostRuntime,path:string,temp:string){
 return {executable:runtime.program.file,args:[...runtime.program.args,...ompArgs(path)],env:nativeChildEnv(runtime,temp)};
}

export const ompInstallArgs=(pin:Pick<OmpPin,'version'>)=>['plugin','install',ompPackage+'@'+pin.version,'--json'];
export function ompInstallCommand(runtime:HostRuntime,pin:Pick<OmpPin,'version'>,temp:string){
 return {executable:runtime.program.file,args:[...runtime.program.args,...ompInstallArgs(pin)],env:nativeChildEnv(runtime,temp)};
}
