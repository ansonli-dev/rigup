import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {mkdir,mkdtemp,readdir,rename,rm,writeFile} from 'node:fs/promises';
import {basename,dirname,join,relative,sep} from 'node:path';
import {privateDirectory} from '../../generator/cache.js';
import {syncDirectory} from '../../sync-directory.js';
import {isRecord} from '../../private-record.js';
import {sddDiscoveryNames} from '../sdd/binding.js';
import {checkedDirectory,readNativeFile,statIfPresent,strictJson} from './host-files.js';
import {ompPackage} from './manual.js';
import {makeReason} from '../../i18n/reasons.js';
import {NativeBlocker} from './blockers.js';
import {readOmpDownload,type OmpPin} from './omp-pin.js';
import type {HostRuntime} from './runtime.js';

const maxDownload=5_000_000,maxFiles=500,maxUnpacked=20_000_000;
const expectedExtension='.pi/extensions/superpowers.ts';
const requiredEntries=[expectedExtension,...sddDiscoveryNames('superpowers',false).map(name=>'skills/'+name+'/SKILL.md')];
const validManifest=(manifest:Record<string,unknown>,{version}:Pick<OmpPin,'version'>)=>manifest.name===ompPackage&&manifest.version===version&&
 isRecord(manifest.pi)&&JSON.stringify(manifest.pi.extensions)==='["./.pi/extensions/superpowers.ts"]';
const verifyIntegrity=(bytes:Buffer,pin:OmpPin)=>{
 if(bytes.length>maxDownload)throw new NativeBlocker('download-failed',makeReason('reason.native.archiveSize'),{evidence:[pin.tarball]});
 if('sha512-'+createHash('sha512').update(bytes).digest('base64')!==pin.integrity)
  throw new NativeBlocker('download-failed',makeReason('reason.native.integrity'),{evidence:[pin.tarball]});
 return bytes;
};

export async function downloadOmp(pin:OmpPin,signal?:AbortSignal,request?:typeof fetch){
 return verifyIntegrity(await readOmpDownload(pin.tarball,maxDownload,90_000,request,signal),pin);
}

const special=/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i;
export function parseOmpTar(tar:Buffer,pin:Pick<OmpPin,'version'>){
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
     paths.has(name.toLowerCase())||size>256_000||offset+512+size>tar.length||files.size>=maxFiles)
   throw Error('Unsafe OMP archive entry');
  const mode=octal(offset+100,8);
  files.set(name,{bytes:tar.subarray(offset+512,offset+512+size),mode:mode&0o111?0o700:0o600});
  paths.add(name.toLowerCase());
  offset+=512+Math.ceil(size/512)*512;
 }
 if(tar.length-offset<1024||!tar.subarray(offset).every(byte=>byte===0))
  throw Error('OMP archive has an unexpected file inventory');
 const manifest=strictJson(files.get('package.json')?.bytes.toString('utf8')??'');
 if(!validManifest(manifest,pin)||!requiredEntries.every(name=>files.has(name)))
  throw Error('OMP package manifest or native entries do not match the approved package');
 return files;
}
export const storePackage=(runtime:Pick<HostRuntime,'stateRoot'>,pin:Pick<OmpPin,'version'>)=>
 join(runtime.stateRoot,'native-packages','omp-superpowers-'+pin.version,'package');

const unpack=(bytes:Buffer,pin:OmpPin)=>parseOmpTar(gunzipSync(bytes,{maxOutputLength:maxUnpacked}),pin);

async function verifyLayout(packageDir:string,files:ReturnType<typeof parseOmpTar>){
 const children=new Map<string,Set<string>>();
 for(const name of files.keys()){
  for(let path=join(packageDir,name);path!==packageDir;path=dirname(path)){
   const directory=dirname(path);
   const expected=children.get(directory)??new Set<string>();
   expected.add(basename(path));children.set(directory,expected);
  }
 }
 const differs=(path:string)=>Error('The OMP store differs from the approved archive: '+path);
 const walk=async(directory:string)=>{
  if(!await checkedDirectory(directory))throw differs(directory);
  const entries=await readdir(directory,{withFileTypes:true}),expected=children.get(directory)!;
  if(entries.length!==expected.size)throw differs(directory);
  for(const entry of entries){
   const path=join(directory,entry.name);
   if(!expected.has(entry.name))throw differs(path);
   if(children.has(path)){
    if(!entry.isDirectory())throw differs(path);
    await walk(path);
   }else{
    const file=files.get(relative(packageDir,path).split(sep).join('/'))!;
    if(!entry.isFile()||!(await readNativeFile(path))?.bytes.equals(file.bytes))throw differs(path);
   }
  }
 };
 await walk(packageDir);
}

export async function verifyOmpStore(packageDir:string,pin:OmpPin){
 const base=dirname(packageDir);
 if(!await checkedDirectory(dirname(base))||!await checkedDirectory(base))return false;
 const source=join(base,'source.tgz'),archive=await readNativeFile(source,maxDownload);
 if(!archive)throw Error('The OMP store lacks its approved archive: '+source);
 const marker=join(base,'complete'),completed=await readNativeFile(marker,256);
 if(completed&&completed.bytes.toString('utf8').trim()!==pin.integrity){
  throw Error('The OMP completion marker has a different pin: '+marker);
 }
 await verifyLayout(packageDir,unpack(verifyIntegrity(archive.bytes,pin),pin));
 return true;
}

export async function installOmpStore(runtime:HostRuntime,bytes:Buffer,pin:OmpPin){
 const target=storePackage(runtime,pin),destination=dirname(target);
 verifyIntegrity(bytes,pin);
 if(await verifyOmpStore(target,pin))return target;
 const files=unpack(bytes,pin);
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
  await verifyLayout(join(stage,'package'),files);
  await writeFile(join(stage,'complete'),pin.integrity+'\n',{flag:'wx',mode:0o600});
  if(await statIfPresent(destination))throw Error('OMP verified store changed during staging');
  await rename(stage,destination);
  await syncDirectory(parent);
  return target;
 }finally{await rm(stage,{recursive:true,force:true});}
}
