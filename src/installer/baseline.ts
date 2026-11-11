import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {isRecord,readDurableRecord} from '../private-record.js';
import {signature} from '../generator/cache.js';
import type {CheckResult,InstallReport} from './apply.js';
import type {PreviewData} from './preview.js';
import type {ManagedAsset,ProjectRulesStatus,SetupOptions} from '../types.js';
import {targetPath,validateOwnership} from './ownership.js';
import {digest} from '../analyzer/evidence.js';
import {isConventionScope,validateConventionReceipts,type ConventionReceipt} from '../project-conventions.js';
export interface Manifest {schemaVersion:1;installId:string;assets:ManagedAsset[];seededProjectDocuments?:ConventionReceipt[];projectRules?:ProjectRulesStatus;options?:SetupOptions;versions?:Record<string,string>;installedTools?:Record<string,{version:string;packageLockDigest:string}>;initializedTools?:Record<string,import('../types.js').NativeInitializationReceipt>}
export async function loadManifest(root:string):Promise<Manifest|undefined>{
 let text:string;try{text=await readFile(await targetPath(root,'.rigup/manifest.json'),'utf8');}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}
 let manifest:Manifest;try{manifest=JSON.parse(text);}catch{throw new Error('manifest invalid JSON; manual reconciliation required');}
 if(manifest.schemaVersion!==1||typeof manifest.installId!=='string'||!Array.isArray(manifest.assets))throw new Error('manifest invalid schema');
 if(manifest.projectRules!==undefined&&!['pending','ready'].includes(manifest.projectRules))throw Error('manifest invalid project rules status');
 validateConventionReceipts(manifest.seededProjectDocuments);
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

export interface SourceReview {scopes:string[];sources:{path:string;topic:string;topicId?:string;scope:string[]}[]}
export interface Transaction {previewId:string;installId:string;status:'prepared'|'complete';files:Record<string,{before:string;after:string;beforeMode?:number;afterMode?:number}>;checks?:CheckResult[];seedProgress?:Record<string,'started'|'written'>;receipts:NonNullable<Manifest['installedTools']>;initialized?:NonNullable<Manifest['initializedTools']>;preview?:{digest:string;data:PreviewData};report?:InstallReport}
export function readApplyRecord(path:string):Promise<Transaction|undefined>{
 return readDurableRecord<Transaction>(path,'Durable apply record',tx=>{
  if(!['prepared','complete'].includes(tx.status)||typeof tx.previewId!=='string'||!/^[a-f0-9]{64}$/.test(tx.previewId)||
   typeof tx.installId!=='string'||!/^[a-f0-9-]+$/.test(tx.installId)||!isRecord(tx.files)||!isRecord(tx.receipts)||
   tx.initialized!==undefined&&!isRecord(tx.initialized)||tx.checks!==undefined&&!Array.isArray(tx.checks))return false;
  if(!Object.values(tx.files).every(file=>isRecord(file)&&typeof file.before==='string'&&typeof file.after==='string'))return false;
  if(tx.seedProgress!==undefined&&(!isRecord(tx.seedProgress)||Object.entries(tx.seedProgress).some(([target,status])=>
    !Object.hasOwn(tx.files,target)||status!=='started'&&status!=='written')))return false;
  const report=tx.report;
  if(report?.sourceReview!==undefined&&(!isRecord(report.sourceReview)||!Array.isArray(report.sourceReview.scopes)||
    !report.sourceReview.scopes.length||!report.sourceReview.scopes.every(isConventionScope)||!Array.isArray(report.sourceReview.sources)||
    !report.sourceReview.sources.every(source=>isRecord(source)&&isConventionScope(source.path)&&source.path!=='.'&&
     typeof source.topic==='string'&&(source.topicId===undefined||typeof source.topicId==='string')&&
     Array.isArray(source.scope)&&source.scope.length&&source.scope.every(isConventionScope))))return false;
  return tx.status!=='complete'||isRecord(report)&&report.previewId===tx.previewId&&report.status==='complete'&&
   [0,1,3].includes(report.exitCode)&&[report.written,report.operations,report.checks,report.warnings].every(Array.isArray);
 });
}

export const applyRecordPath=(root:string,stateRoot:string)=>join(stateRoot,signature(root)+'.apply.json');

export async function sourceReview(root:string,manifest:Manifest|undefined,stateRoot:string):Promise<SourceReview|undefined>{
 if(!manifest)return;
 const tx=await readApplyRecord(applyRecordPath(root,stateRoot));
 const installId=tx?.status==='complete'?tx.installId:tx?.preview?.data?.oldManifest?.installId;
 return installId===manifest.installId?tx?.report?.sourceReview:undefined;
}
