import {readFile} from 'node:fs/promises';
import type {ManagedAsset,SetupOptions} from '../types.js';
import {targetPath,validateOwnership} from './ownership.js';
import {digest} from '../analyzer/evidence.js';
export interface Manifest {schemaVersion:1;installId:string;assets:ManagedAsset[];options?:SetupOptions;versions?:Record<string,string>;installedTools?:Record<string,{version:string;packageLockDigest:string}>}
export async function loadManifest(root:string):Promise<Manifest|undefined>{
 let text:string;try{text=await readFile(await targetPath(root,'.rigup/manifest.json'),'utf8');}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}
 let manifest:Manifest;try{manifest=JSON.parse(text);}catch{throw new Error('manifest invalid JSON; manual reconciliation required');}
 if(manifest.schemaVersion!==1||typeof manifest.installId!=='string'||!Array.isArray(manifest.assets))throw new Error('manifest invalid schema');
 const seen=new Set<string>();for(const a of manifest.assets){if(!a||typeof a.logicalId!=='string'||seen.has(a.logicalId)||typeof a.target!=='string'||typeof a.digest!=='string')throw new Error('manifest invalid asset');seen.add(a.logicalId);validateOwnership(a.ownership);await targetPath(root,a.target);}
 return manifest;
}
export async function trustedBaseline(root:string,asset:ManagedAsset):Promise<string|undefined>{
 try {
  if(!asset.baseline?.startsWith('.rigup/baseline/'))return;
  const raw=await readFile(await targetPath(root,asset.baseline));if(digest(raw)!==asset.digest)return;
  return asset.encoding==='base64'?raw.toString('base64'):raw.toString('utf8');
 }catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}
}
