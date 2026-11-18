import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {mkdir,mkdtemp,rename,rm,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {privateDirectory} from '../../generator/cache.js';
import {syncDirectory} from '../../sync-directory.js';
import {isRecord} from '../../private-record.js';
import {sddDiscoveryNames} from '../sdd/binding.js';
import {checkedDirectory,checkedFile,nativeJson,readNativeFile,statIfPresent,strictJson} from './host-files.js';
import {ompPackage} from './manual.js';
import {ompIntegrity,ompTarball,ompVersion} from './pins.js';
import type {HostRuntime} from './runtime.js';

const length=221_871;
const expectedExtension='.pi/extensions/superpowers.ts';
const requiredEntries=[expectedExtension,...sddDiscoveryNames('superpowers',false).map(name=>'skills/'+name+'/SKILL.md')];
const validManifest=(manifest:Record<string,unknown>)=>manifest.name===ompPackage&&manifest.version===ompVersion&&
 !['scripts','dependencies','devDependencies','peerDependencies','optionalDependencies','bundledDependencies','bundleDependencies'].some(key=>Object.hasOwn(manifest,key))&&
 isRecord(manifest.pi)&&JSON.stringify(manifest.pi.extensions)==='["./.pi/extensions/superpowers.ts"]';
const pin=(bytes:Buffer)=>{
 if(bytes.length!==length||'sha512-'+createHash('sha512').update(bytes).digest('base64')!==ompIntegrity)
  throw Error('OMP package integrity does not match the approved archive');
 return bytes;
};

export async function downloadOmp(signal?:AbortSignal,request:typeof fetch=fetch){
 const timeout=AbortSignal.timeout(90_000);
 let response:Response;
 try{response=await request(ompTarball,{redirect:'error',signal:signal?AbortSignal.any([signal,timeout]):timeout});}
 catch{throw Error('Could not download the pinned OMP package');}
 if(response.status!==200||response.redirected||!response.body||response.url&&response.url!==ompTarball)
  throw Error('Could not download the pinned OMP package from its official URL');
 const reader=response.body.getReader();
 const bytes=Buffer.alloc(length);
 let offset=0;
 try{
  for(;;){
   const {value,done}=await reader.read();
   if(done)break;
   if(offset+value.length>length){await reader.cancel();throw Error('OMP package exceeds the approved download size');}
   bytes.set(value,offset);offset+=value.length;
  }
 }finally{reader.releaseLock();}
 return pin(bytes.subarray(0,offset));
}

const special=/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i;
export function parseOmpTar(tar:Buffer){
 const files=new Map<string,{bytes:Buffer;mode:number}>();
 const paths=new Set<string>();
 const field=(offset:number,size:number)=>tar.subarray(offset,offset+size).toString('utf8').replace(/\0[\s\S]*$/,'');
 const octal=(offset:number,size:number)=>{
  const raw=field(offset,size).trim();
  if(!/^[0-7]{1,12}$/.test(raw))throw Error('Unsafe OMP archive entry');
  return Number.parseInt(raw,8);
 };
 let offset=0;
 for(;offset+512<=tar.length;){
  const hdr=tar.subarray(offset,offset+512);
  if(hdr.every(byte=>byte===0))break;
  const path=field(offset,100),size=octal(offset+124,12);
  const checksum=hdr.reduce((sum,byte,i)=>sum+(i>=148&&i<156?32:byte),0);
  const name=path.slice(8),parts=name.split('/');
  if(checksum!==octal(offset+148,8)||hdr[156]!==48||field(offset+257,6)!=='ustar'||
     field(offset+345,155)!==''||field(offset+157,100)!==''||!path.startsWith('package/')||
     parts.some(part=>!/^[-\w.]+$/.test(part)||part==='.'||part==='..'||part.endsWith('.')||special.test(part))||
     paths.has(name.toLowerCase())||size>256_000||offset+512+size>tar.length||files.size>=83)
   throw Error('Unsafe OMP archive entry');
  const mode=octal(offset+100,8);
  files.set(name,{bytes:tar.subarray(offset+512,offset+512+size),mode:mode&0o111?0o700:0o600});
  paths.add(name.toLowerCase());
  offset+=512+Math.ceil(size/512)*512;
 }
 if(tar.length-offset<1024||!tar.subarray(offset).every(byte=>byte===0)||files.size!==83)
  throw Error('OMP archive has an unexpected file inventory');
 const manifest=strictJson(files.get('package.json')?.bytes.toString('utf8')??'');
 if(!validManifest(manifest)||!requiredEntries.every(name=>files.has(name)))
  throw Error('OMP package manifest or native entries do not match the approved package');
 return files;
}
const unpack=(bytes:Buffer)=>parseOmpTar(gunzipSync(pin(bytes),{maxOutputLength:2_000_000}));
export const storePackage=(runtime:Pick<HostRuntime,'stateRoot'>)=>join(runtime.stateRoot,'native-packages','omp-superpowers-'+ompVersion,'package');

async function verifyLayout(packageDir:string){
 const manifest=(await nativeJson(join(packageDir,'package.json')))?.value;
 if(!manifest||!validManifest(manifest))throw Error('The OMP store manifest is incomplete or has a different version: '+packageDir);
 for(const name of requiredEntries){
  const path=join(packageDir,name);
  if(!await checkedFile(path))throw Error('The OMP store is incomplete: '+path);
 }
}

export async function verifyOmpStore(packageDir:string){
 const base=dirname(packageDir);
 if(!await checkedDirectory(base))return false;
 const source=join(base,'source.tgz'),archive=await checkedFile(source,{limit:length});
 if(archive?.size!==BigInt(length))throw Error('The OMP store lacks its pinned archive: '+source);
 const marker=join(base,'complete'),completed=await readNativeFile(marker,256);
 if(completed){
  if(completed.bytes.toString('utf8').trim()!==ompIntegrity)throw Error('The OMP completion marker has a different pin: '+marker);
 }else{
  const legacy=await readNativeFile(source,length);
  if(!legacy)throw Error('The OMP store lacks its pinned archive: '+source);
  pin(legacy.bytes);
 }
 await verifyLayout(packageDir);
 return true;
}

export async function installOmpStore(runtime:HostRuntime,bytes:Buffer){
 const target=storePackage(runtime),destination=dirname(target);
 pin(bytes);
 if(await verifyOmpStore(target))return target;
 const files=unpack(bytes);
 const parent=await privateDirectory(dirname(destination),runtime.root);
 const stage=await mkdtemp(join(parent,'.stage-'));
 try{
  await writeFile(join(stage,'source.tgz'),bytes,{flag:'wx',mode:0o600});
  await mkdir(join(stage,'package'),{mode:0o700});
  for(const [name,file] of files){
   const path=join(stage,'package',name);
   await mkdir(dirname(path),{recursive:true,mode:0o700});
   await writeFile(path,file.bytes,{flag:'wx',mode:file.mode});
  }
  await verifyLayout(join(stage,'package'));
  await writeFile(join(stage,'complete'),ompIntegrity+'\n',{flag:'wx',mode:0o600});
  if(await statIfPresent(destination))throw Error('OMP verified store changed during staging');
  await rename(stage,destination);
  await syncDirectory(parent);
  return target;
 }finally{await rm(stage,{recursive:true,force:true});}
}
