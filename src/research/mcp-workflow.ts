import {randomUUID} from 'node:crypto';
import {realpath} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {selectResearchOutput,validateResearch,type AnalysisBackend,type RepositoryReader,type ResearchRequest} from '../analyzer/backend.js';
import {digest} from '../analyzer/evidence.js';
import {PROMPT_VERSION,researchPrompt} from '../analyzer/prompts.js';
import {READ_POLICY_VERSION} from '../analyzer/read-policy.js';
import {scanRepository} from '../analyzer/repository.js';
import {loadOptions,normalizeDocumentLanguage} from '../config.js';
import {privateDirectory,signature} from '../generator/cache.js';
import {DOCUMENT_POLICY_VERSION} from '../generator/document-policy.js';
import {inventorySignature} from '../generator/generate.js';
import {TEMPLATE_VERSION} from '../generator/render.js';
import {interruptedApplyId} from '../installer/apply.js';
import {loadManifest,trustedBaseline,type Manifest} from '../installer/baseline.js';
import {acquireLock,defaultStateRoot} from '../installer/lock.js';
import {absentDigest,loadPreview,readTarget,type Preview,type PreviewData} from '../installer/preview.js';
import {platformFileMode,readFileState,readFileStates,matchesFileState} from '../installer/file-state.js';
import {equalOwnedContent,ownedContent} from '../installer/ownership.js';
import {executeLifecycle} from '../lifecycle.js';
import {isRecord,readDurableRecord,saveDurable} from '../private-record.js';
import {quoteShell} from '../shell-command.js';
import type {Agent,SetupOptions} from '../types.js';

const jobDigest=/^[a-f0-9]{64}$/;
const idPattern=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const policy={prompt:PROMPT_VERSION,read:READ_POLICY_VERSION,template:TEMPLATE_VERSION,document:DOCUMENT_POLICY_VERSION};
const hostPrompt=researchPrompt
 .replace('using ONLY the supplied read tools','using your authorized native read tools for this project')
 .replace('Cite only the supplied ranges','Cite only the repository path and line ranges')
 .replace('arrays of {path,startLine,endLine,digest}','arrays of {path,startLine,endLine}')
 .replace('Claims must cite exact visible snippet digests returned by the tools.','Submit repository-relative path, startLine and endLine for each citation. Rigup computes the digest from allowed evidence.');
const maxSubmissionBytes=256_000;
type JobStage='analysis'|'plan'|'page'|'acceptance';
interface Job {id:string;stage:JobStage;expectedOutput:'analysis'|'plan'|'content'|'acceptance';options:{documentLanguage:string};artifact?:string;input?:unknown;seedPaths?:string[]}
interface Submission {id:string;digest:string;stage:JobStage|'planning';data:Record<string,unknown>}
interface ResearchState {
 version:1;id:string;scope:string;startingInventory:string;language?:string;
 accepted:Record<string,string>;inFlight?:{id:string;digest:string};
 result?:{previewId:string;inventory:string;retireIds?:string[]};
}
export interface ResearchReply {status:'planning'|'page'|'ready'|'noop'|'preview';runId:string;job?:Job;instructions?:string;previewId?:string;preview?:Preview;nextCommand?:string}
class AwaitingJob extends Error {
 constructor(readonly job:Job){super('Research is waiting for a submitted job');}
}
const validDigest=(value:unknown):value is string=>typeof value==='string'&&jobDigest.test(value);
const validIds=(value:unknown):value is string[]=>Array.isArray(value)&&value.length<=128&&value.every(id=>typeof id==='string'&&id.length>0&&id.length<=256)&&new Set(value).size===value.length;
const validState=(state:ResearchState)=>state.version===1&&typeof state.id==='string'&&idPattern.test(state.id)&&
 validDigest(state.scope)&&validDigest(state.startingInventory)&&
 (state.language===undefined||typeof state.language==='string')&&isRecord(state.accepted)&&
 Object.entries(state.accepted).every(([id,digest])=>validDigest(id)&&validDigest(digest))&&
 (state.inFlight===undefined||isRecord(state.inFlight)&&validDigest(state.inFlight.id)&&validDigest(state.inFlight.digest))&&
 (state.result===undefined||isRecord(state.result)&&validDigest(state.result.previewId)&&validDigest(state.result.inventory)&&(state.result.retireIds===undefined||validIds(state.result.retireIds)));

async function previewStillCurrent(root:string,data:PreviewData):Promise<boolean>{
 const current=await readTarget(root,'.rigup/manifest.json');
 if((current?digest(current):absentDigest)!==data.manifestDigest)return false;
 const files=new Map(data.files.map(file=>[file.target,file]));
 for await(const {target,state} of readFileStates(root,data.files.map(file=>file.target))){
  const expected=files.get(target)!;
  if(!matchesFileState(state,expected.observedDigest,expected.observedMode))return false;
 }
 return true;
}

async function installedAssetsMatch(root:string,manifest:Manifest):Promise<boolean>{
 for(const asset of manifest.assets){
  const baseline=await trustedBaseline(root,asset);
  if(baseline===undefined)return false;
  const {bytes,mode}=await readFileState(root,asset.target);
  const local=ownedContent(bytes?.toString(asset.encoding==='base64'?'base64':'utf8'),asset.ownership);
  if(local===undefined||!equalOwnedContent(asset.ownership,local,baseline)||asset.mode!==undefined&&mode!==platformFileMode(asset.mode))return false;
 }
 return true;
}

async function hydrateEvidence(value:unknown,reader:RepositoryReader):Promise<unknown>{
 const read=reader.evidencePass?.()??reader.read.bind(reader);
 async function visit(node:unknown,depth:number):Promise<unknown>{
  if(depth>48)throw Error('Research submission is too deeply nested');
  if(Array.isArray(node)){
   const result=[];
   for(const child of node)result.push(await visit(child,depth+1));
   return result;
  }
  if(!isRecord(node))return node;
  if('path' in node&&('startLine' in node||'endLine' in node)){
   if(typeof node.path!=='string'||!Number.isSafeInteger(node.startLine)||!Number.isSafeInteger(node.endLine))throw Error('Evidence requires a repository path and exact line range');
   const {evidence}=await read(node.path,Number(node.startLine),Number(node.endLine));
   if(node.digest!==undefined&&node.digest!==evidence.digest)throw Error('Evidence digest does not match the current source');
   return evidence;
  }
  const entries:[string,unknown][]=[];
  for(const [key,child] of Object.entries(node))entries.push([key,await visit(child,depth+1)]);
  return Object.fromEntries(entries);
 }
 return visit(value,0);
}

function readSubmission(name:string,args:Record<string,unknown>):Submission|undefined{
 if(name!=='rigup_submit_plan'&&name!=='rigup_submit_page')return;
 if(!validDigest(args.jobId)||!isRecord(args.data)||Buffer.byteLength(JSON.stringify(args.data))>maxSubmissionBytes)throw Error('Research submission requires a jobId and a bounded data object');
 return {id:args.jobId,data:args.data,digest:signature(args.data),stage:name==='rigup_submit_page'?'page':'planning'};
}

export async function openResearchMcp(project:string,host:Agent,dependencies:{stateRoot?:string;cacheRoot?:string}={}){
 const root=await realpath(project);
 const stateRoot=dependencies.stateRoot??defaultStateRoot();
 const cacheRoot=dependencies.cacheRoot??join(homedir(),'.cache','rigup');
 const previews=join(cacheRoot,'previews');
 return {async call(name:string,args:Record<string,unknown>):Promise<ResearchReply>{
  if(!['rigup_begin','rigup_submit_plan','rigup_next_page','rigup_submit_page','rigup_finish'].includes(name))throw Error('Unknown Rigup research tool');
  if(name==='rigup_begin'&&(typeof args.root!=='string'||await realpath(resolve(args.root)).catch(()=>undefined)!==root))throw Error('Begin must use the configured project root');
  if(name==='rigup_begin'&&args.mode!=='init'&&args.mode!=='update')throw Error('Begin requires init or update');
  const lock=await acquireLock(root,{stateRoot,resource:'rigup-mcp:'+root,recover:true});
  try{
   if(await interruptedApplyId(root,lock.stateRoot))throw Error('Resume the interrupted installation from the CLI before starting research');
   const manifest=await loadManifest(root);
   if(!manifest?.options?.agents?.includes(host))throw Error('Apply the Rigup project setup for this host before starting research');
   const directory=await privateDirectory(join(lock.stateRoot,'mcp-research'),root);
   const path=join(directory,signature({root,host})+'.json');
   let state=await readDurableRecord<ResearchState>(path,'MCP research run',validState);
   if(name!=='rigup_begin'&&(!state||args.runId!==state.id))throw Error('Research run changed or is missing. Begin again.');
   const language=name==='rigup_begin'&&args.language!==undefined?normalizeDocumentLanguage(args.language):state?.language;
   const config=await readTarget(root,'.rigup/config.yaml');
   const fallback=config&&manifest.assets.some(asset=>asset.logicalId==='rigup:configuration')?undefined:manifest.options;
   const options=await loadOptions(root,language?{documentLanguage:language}:{},undefined,{fallback});
   if(!options.projectRules||!options.agents.includes(host))throw Error('Enable project rules and apply the selection for this host before starting research');
   const profile=await scanRepository(root,options);
   if(profile.researchBlocked)throw Error(profile.researchBlocked);
   const scope=signature({root,host,options,fingerprint:profile.fingerprint,config:config&&digest(config),policy});
   const currentInventory=inventorySignature(manifest.assets);
   const lastResultApplied=state?.scope===scope&&state.result?.inventory===currentInventory&&manifest.projectRules==='ready'&&signature(manifest.options)===signature(options);
   if(lastResultApplied&&['rigup_begin','rigup_finish'].includes(name)&&await installedAssetsMatch(root,manifest).catch(()=>false))return {status:'noop',runId:state!.id};
   if(name==='rigup_begin'){
    if(lastResultApplied||state?.scope!==scope||state.startingInventory!==currentInventory){
     state={version:1,id:randomUUID(),scope,startingInventory:currentInventory,language,accepted:{}};
     await saveDurable(path,JSON.stringify(state));
    }
   }
   if(!state||state.scope!==scope||state.startingInventory!==currentInventory)throw Error('Project source, settings or installation changed. Begin a new research run.');
   const submission=readSubmission(name,args);
   if(submission&&state.accepted[submission.id]&&state.accepted[submission.id]!==submission.digest)throw Error('The completed job was submitted with different data');
   if(name==='rigup_finish'&&!state.result)throw Error('Research jobs are pending. Submit them before finish.');
   if(state.result){
    if(submission&&state.accepted[submission.id]!==submission.digest)throw Error('The submitted job does not belong to the completed run');
    if(name!=='rigup_finish')return {status:'ready',runId:state.id};
    if(args.retireIds!==undefined&&(!validIds(args.retireIds)||args.retireIds.some(id=>!manifest.assets.some(asset=>asset.logicalId===id))))throw Error('Retirement IDs must identify existing managed assets');
    const retireIds=Array.isArray(args.retireIds)?[...args.retireIds].sort():state.result.retireIds;
    const load=()=>loadPreview(state!.result!.previewId,previews);
    const saved=await load().catch(error=>{if((error as Error).message!=='private preview missing or corrupted')throw error;});
    let preview=saved?.preview;
    if(!saved||signature(retireIds??[])!==signature(state.result.retireIds??[])||!await previewStillCurrent(root,saved)){
     const regenerated=await advanceResearch(root,host,state,path,options,profile.fingerprint,undefined,{cacheRoot,stateRoot:lock.stateRoot},retireIds);
     if(regenerated.status!=='ready')throw Error('Research generation state could not restore the preview');
     preview=(await load()).preview;
    }
    if(!preview)throw Error('Research preview is unavailable');
    const nextCommand=preview.executable?'rigup update '+quoteShell(root)+' --apply '+preview.previewId+' --sessions-ended':undefined;
    return {status:'preview',runId:state.id,previewId:preview.previewId,preview,nextCommand};
   }
   return await advanceResearch(root,host,state,path,options,profile.fingerprint,submission,{cacheRoot,stateRoot:lock.stateRoot});
  }finally{await lock.release();}
 }};
}

async function advanceResearch(root:string,host:Agent,state:ResearchState,path:string,options:SetupOptions,fingerprint:string,submission:Submission|undefined,paths:{cacheRoot:string;stateRoot:string},retireIds?:string[]):Promise<ResearchReply>{
 const persist=()=>saveDurable(path,JSON.stringify(state));
 let consumed=false;
 const settle=async(next?:string)=>{
  if(state.inFlight&&state.inFlight.id!==next){
   state.accepted[state.inFlight.id]=state.inFlight.digest;
   delete state.inFlight;
   await persist();
  }
  if(submission&&state.accepted[submission.id]!==submission.digest)throw Error('The submitted job is not the pending research job');
 };
 const backend:AnalysisBackend={artifactContextVersion:'mcp-2',run:async(request:ResearchRequest,reader)=>{
  const model='host-agent/'+host;
  const expectedOutput=request.expectedOutput??'analysis';
  const stage:JobStage=expectedOutput==='content'?'page':expectedOutput;
  const id=signature({run:state.id,stage,artifact:request.artifact,input:request.input});
  if(submission&&!consumed&&submission.id===id){
   if((stage==='page'||stage==='acceptance')!==(submission.stage==='page'))throw Error('Use the submission tool for this job stage');
   if(state.inFlight?.id===id&&state.inFlight.digest!==submission.digest)throw Error('Retry the in-flight job with the same data');
   const data=selectResearchOutput(request,await hydrateEvidence(submission.data,reader));
   await validateResearch(data,reader);
   const unknowns=(data as {unknowns?:unknown}).unknowns;
   if(!Array.isArray(unknowns)||unknowns.some(item=>typeof item!=='string'))throw Error('unknowns: string array required');
   state.inFlight={id,digest:submission.digest};
   await persist();
   consumed=true;
   return {status:'complete',value:{model,data,unknowns,usage:{calls:1,tokens:'unknown'}}};
  }
  throw new AwaitingJob({id,stage,expectedOutput,options:{documentLanguage:options.documentLanguage??'auto'},artifact:request.artifact,input:request.input,...(stage==='analysis'?{seedPaths:(await reader.list()).slice(0,200)}:{})});
 }};
 let report:Record<string,unknown>|undefined;
 try{
  await executeLifecycle(root,options,{review:true,resume:true,retireIds},()=>{},{
   ...paths,backend,researchSessionId:state.id,expectedFingerprint:fingerprint,report:value=>report=value
  });
 }catch(error){
  if(error instanceof AwaitingJob){
   await settle(error.job.id);
   return {status:['page','acceptance'].includes(error.job.stage)?'page':'planning',runId:state.id,job:error.job,instructions:hostPrompt};
  }
  if(consumed){delete state.inFlight;await persist();}
  throw error;
 }
 if(!report||!validDigest(report.previewId))throw Error('Research could not prepare a project preview');
 const stored=await loadPreview(report.previewId,join(paths.cacheRoot,'previews'));
 await settle();
 state.result={previewId:report.previewId,inventory:inventorySignature(stored.assets),retireIds};
 await persist();
 return {status:'ready',runId:state.id};
}
