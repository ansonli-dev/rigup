import {randomUUID} from 'node:crypto';
import {realpath} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {selectResearchOutput,validateResearch,type AnalysisBackend,type RepositoryReader,type ResearchRequest} from '../analyzer/backend.js';
import {digest,type EvidenceRead} from '../analyzer/evidence.js';
import {analysisSeedPaths,stageSourceGuidance} from '../analyzer/stage-context.js';
import {researchPrompt} from '../analyzer/prompts.js';
import {scanRepository} from '../analyzer/repository.js';
import {loadOptions,normalizeDocumentLanguage} from '../config.js';
import {privateDirectory,signature} from '../generator/cache.js';
import {inventorySignature} from '../generator/generate.js';
import {interruptedApplyId} from '../installer/apply.js';
import {loadManifest,sourceReview,trustedBaseline,type Manifest} from '../installer/baseline.js';
import {acquireLock,defaultStateRoot} from '../installer/lock.js';
import {absentDigest,approvalInputChange,LegacyPreviewError,loadPreview,readTarget,type Preview,type PreviewData} from '../installer/preview.js';
import {defaultNpmRegistry,type NpmView} from '../integrations/tools/npm-resolution.js';
import {inspectOpenSpecForSetup,interruptedOpenSpecPreparation} from '../integrations/sdd/openspec-setup.js';
import {operationNpmRegistry} from '../runtime-inputs.js';
import {platformFileMode,readFileState,readFileStates,matchesFileState} from '../installer/file-state.js';
import {equalOwnedContent,ownedContent} from '../installer/ownership.js';
import {executeLifecycle} from '../lifecycle.js';
import {isRecord,readDurableRecord,saveDurable} from '../private-record.js';
import {quoteShell} from '../shell-command.js';
import type {Agent,SetupOptions} from '../types.js';

const jobDigest=/^[a-f0-9]{64}$/;
const idPattern=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const hostPrompt=researchPrompt
 .replace('using ONLY the supplied read tools','using your authorized native read tools for this project')
 .replace('Cite only the supplied ranges','Cite only the repository path and line ranges')
 .replace('arrays of {path,startLine,endLine,digest}','arrays of {path,startLine,endLine}')
 .replace('Claims must cite exact visible snippet digests returned by the tools.','Submit repository-relative path, startLine and endLine for each citation. Rigup computes the digest from allowed evidence.')
 + '\nStart with the supplied seed paths when present. The seed paths are a sample of the readable inventory. Use authorized tools to find other relevant files. Scope Glob and Grep to relevant project source or test directories. Exclude .rigup/tools/ and dependency trees from searches, and ignore any matches there.';
const maxSubmissionBytes=256_000;
type JobStage='analysis'|'plan'|'page'|'acceptance';
interface Job {id:string;stage:JobStage;expectedOutput:'analysis'|'plan'|'content'|'acceptance';options:{documentLanguage:string};artifact?:string;input?:unknown;seedPaths?:string[];sourceGuidance?:ResearchRequest['sourceGuidance'];sourceEvidence?:EvidenceRead[]}
interface Submission {id:string;digest:string;stage:JobStage|'planning';data:Record<string,unknown>}
interface ResearchState {
 version:1;id:string;scope:string;startingInventory:string;language?:string;stableScope?:true;
 accepted:Record<string,string>;inFlight?:{id:string;digest:string};
 pendingJob?:{key:string;id:string;fingerprint:string};
 result?:{previewId:string;inventory:string;fingerprint?:string;retireIds?:string[]};
}
export interface ResearchReply {status:'planning'|'page'|'ready'|'noop'|'preview'|'pending';runId?:string;job?:Job;instructions?:string;previewId?:string;preview?:Preview;pending?:string[];nextCommand?:string}
class AwaitingJob extends Error {
 constructor(readonly job:Job,readonly refresh=false){super('Research is waiting for a submitted job');}
}
const validDigest=(value:unknown):value is string=>typeof value==='string'&&jobDigest.test(value);
const validIds=(value:unknown):value is string[]=>Array.isArray(value)&&value.length<=128&&value.every(id=>typeof id==='string'&&id.length>0&&id.length<=256)&&new Set(value).size===value.length;
const validState=(state:ResearchState)=>state.version===1&&typeof state.id==='string'&&idPattern.test(state.id)&&
 validDigest(state.scope)&&validDigest(state.startingInventory)&&
 (state.language===undefined||typeof state.language==='string')&&isRecord(state.accepted)&&
 Object.entries(state.accepted).every(([id,digest])=>validDigest(id)&&validDigest(digest))&&
 (state.inFlight===undefined||isRecord(state.inFlight)&&validDigest(state.inFlight.id)&&validDigest(state.inFlight.digest))&&
 (state.stableScope===undefined||state.stableScope===true)&&
 (state.pendingJob===undefined||isRecord(state.pendingJob)&&validDigest(state.pendingJob.key)&&validDigest(state.pendingJob.id)&&validDigest(state.pendingJob.fingerprint))&&
 (state.result===undefined||isRecord(state.result)&&validDigest(state.result.previewId)&&validDigest(state.result.inventory)&&
  (state.result.fingerprint===undefined||validDigest(state.result.fingerprint))&&(state.result.retireIds===undefined||validIds(state.result.retireIds)));

async function previewStillCurrent(root:string,data:PreviewData,stateRoot:string):Promise<boolean>{
 if(data.plan.requirements.some(requirement=>requirement.kind==='npm-resolution'))return false;
 const installs=data.plan.operations.filter(operation=>operation.kind==='install');
 if(installs.length){
  try{
   for(const operation of installs)if((operation.registry??defaultNpmRegistry)!==await operationNpmRegistry(root,operation.query.name))return false;
  }catch{return false;}
 }
 const current=await readTarget(root,'.rigup/manifest.json');
 if((current?digest(current):absentDigest)!==data.manifestDigest)return false;
 if(signature(await sourceReview(root,data.oldManifest,stateRoot)??null)!==signature(data.sourceReview??null))return false;
 const files=new Map(data.files.map(file=>[file.target,file]));
 for await(const {target,state} of readFileStates(root,data.files.map(file=>file.target))){
  const expected=files.get(target)!;
  if(!matchesFileState(state,expected.observedDigest,expected.observedMode))return false;
 }
 return !await approvalInputChange(root,data,stateRoot).catch(()=> 'unavailable');
}

async function installedAssetsMatch(root:string,manifest:Manifest):Promise<boolean>{
 for(const asset of manifest.assets){
  const baseline=await trustedBaseline(root,asset);
  if(baseline===undefined)return false;
  const {bytes,mode}=await readFileState(root,asset.target);
  const local=ownedContent(bytes?.toString(asset.encoding==='base64'?'base64':'utf8'),asset.ownership);
  if(local===undefined||!equalOwnedContent(asset.ownership,local,baseline)||asset.mode!==undefined&&mode!==platformFileMode(asset.effectiveMode??asset.mode))return false;
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

function explicitCitations(data:unknown):boolean{
 let found=false;
 function visit(node:unknown,depth=0):boolean{
  if(depth>48)return false;
  if(Array.isArray(node))return node.every(value=>visit(value,depth+1));
  if(!isRecord(node))return true;
  if('path' in node&&('startLine' in node||'endLine' in node)){found=true;return validDigest(node.digest);}
  return Object.values(node).every(value=>visit(value,depth+1));
 }
 return visit(data)&&found;
}

export async function openResearchMcp(project:string,host:Agent,dependencies:{stateRoot?:string;cacheRoot?:string;npmView?:NpmView}={}){
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
   if(options.sdd==='openspec'){
    const interrupted=await interruptedOpenSpecPreparation(root,lock.stateRoot);
    if(interrupted)return {status:'pending',runId:state?.id,pending:interrupted.requirements,nextCommand:interrupted.nextCommand};
    const native=await inspectOpenSpecForSetup(root,options,lock.stateRoot);
    if(!native.runtime)return {status:'pending',runId:state?.id,pending:native.requirements,nextCommand:native.steps.join(' && ')||undefined};
   }
   const profile=await scanRepository(root,options);
   if(profile.researchBlocked)throw Error(profile.researchBlocked);
   const fingerprint=profile.fingerprint,scope=signature({root,host,options});
   const currentInventory=inventorySignature(manifest.assets);
   const pendingSourceReview=await sourceReview(root,manifest,lock.stateRoot);
   const sameSelection=signature(manifest.options)===signature(options);
   if(state&&!state.stableScope&&sameSelection){state.scope=scope;state.stableScope=true;await saveDurable(path,JSON.stringify(state));}
   const applied=state?.scope===scope&&state.result?.inventory===currentInventory&&manifest.projectRules==='ready'&&sameSelection;
   const lastResultApplied=applied&&!pendingSourceReview&&state?.result?.fingerprint===fingerprint;
   if(lastResultApplied&&['rigup_begin','rigup_finish'].includes(name)&&await installedAssetsMatch(root,manifest).catch(()=>false))return {status:'noop',runId:state!.id};
   if(name==='rigup_begin'){
    if(applied||state?.scope!==scope||state.startingInventory!==currentInventory){
     state={version:1,id:randomUUID(),scope,stableScope:true,startingInventory:currentInventory,language,accepted:{}};
     await saveDurable(path,JSON.stringify(state));
    }
   }
   if(!state||state.scope!==scope||state.startingInventory!==currentInventory)throw Error('Project source, settings or installation changed. Begin a new research run.');
   const submission=readSubmission(name,args);
   if(submission&&state.accepted[submission.id]&&state.accepted[submission.id]!==submission.digest)throw Error('The completed job was submitted with different data');
   const paths={cacheRoot,stateRoot:lock.stateRoot,npmView:dependencies.npmView};
   if(state.result&&state.result.fingerprint!==fingerprint){
    const retireIds=state.result.retireIds;
    delete state.result;
    await saveDurable(path,JSON.stringify(state));
    const refreshed=await advanceResearch(root,host,state,path,options,fingerprint,submission,paths,retireIds);
    if(name!=='rigup_finish'||refreshed.status!=='ready')return refreshed;
   }
   if(name==='rigup_finish'&&!state.result)throw Error('Research jobs are pending. Submit them before finish.');
   if(state.result){
    if(submission&&state.accepted[submission.id]!==submission.digest)throw Error('The submitted job does not belong to the completed run');
    if(name!=='rigup_finish')return {status:'ready',runId:state.id};
    if(args.retireIds!==undefined&&(!validIds(args.retireIds)||args.retireIds.some(id=>!manifest.assets.some(asset=>asset.logicalId===id))))throw Error('Retirement IDs must identify existing managed assets');
    const retireIds=Array.isArray(args.retireIds)?[...args.retireIds].sort():state.result.retireIds;
    const load=()=>loadPreview(state!.result!.previewId,previews);
    const saved=await load().catch(error=>{if(!(error instanceof LegacyPreviewError)&&(error as Error).message!=='private preview missing or corrupted')throw error;});
    let preview=saved?.preview;
    if(!saved||signature(retireIds??[])!==signature(state.result.retireIds??[])||!await previewStillCurrent(root,saved,lock.stateRoot)){
     const regenerated=await advanceResearch(root,host,state,path,options,fingerprint,undefined,paths,retireIds);
     if(regenerated.status==='pending')return regenerated;
     if(regenerated.status!=='ready')throw Error('Research generation state could not restore the preview');
     preview=(await load()).preview;
    }
    if(!preview)throw Error('Research preview is unavailable');
    const nextCommand=preview.executable?'rigup update '+quoteShell(root)+' --apply '+preview.previewId:undefined;
    return {status:'preview',runId:state.id,previewId:preview.previewId,preview,nextCommand};
   }
   return await advanceResearch(root,host,state,path,options,fingerprint,submission,paths);
  }finally{await lock.release();}
 }};
}

async function advanceResearch(root:string,host:Agent,state:ResearchState,path:string,options:SetupOptions,fingerprint:string,submission:Submission|undefined,paths:{cacheRoot:string;stateRoot:string;npmView?:NpmView},retireIds?:string[]):Promise<ResearchReply>{
 const persist=()=>saveDurable(path,JSON.stringify(state));
 let consumed=false;
 const settle=async(next?:string,refresh=false)=>{
  if(state.inFlight&&state.inFlight.id!==next){
   state.accepted[state.inFlight.id]=state.inFlight.digest;
   delete state.inFlight;
   await persist();
  }
  if(!refresh&&submission&&state.accepted[submission.id]!==submission.digest)throw Error('The submitted job is not pending for this research run');
 };
 const backend:AnalysisBackend={artifactContextVersion:'mcp-3',advisoryBudget:true,run:async(request:ResearchRequest,reader)=>{
  const model='host-agent/'+host;
  const expectedOutput=request.expectedOutput??'analysis';
  const stage:JobStage=expectedOutput==='content'?'page':expectedOutput;
  const key=signature({run:state.id,stage,artifact:request.artifact,input:request.input,sourceGuidance:request.sourceGuidance});
  const pending=state.pendingJob,previousId=pending?.key===key?pending.id:pending?undefined:key;
  const older=!!submission&&submission.id===previousId&&pending?.fingerprint!==fingerprint;
  const explicit=older&&explicitCitations(submission.data);
  const id=explicit?previousId!:signature({key,fingerprint});
  const sourceEvidence=await stageSourceGuidance(reader,request.sourceGuidance);
  if(submission&&!consumed&&submission.id===id){
   if((stage==='page'||stage==='acceptance')!==(submission.stage==='page'))throw Error('Use the submission tool for this job stage');
   if(state.inFlight?.id===id&&state.inFlight.digest!==submission.digest)throw Error('Retry the in-flight job with the same data');
   const data=selectResearchOutput(request,await hydrateEvidence(submission.data,reader));
   const {warnings}=await validateResearch(data,reader,undefined,sourceEvidence);
   const unknowns=(data as {unknowns?:unknown}).unknowns;
   if(!Array.isArray(unknowns)||unknowns.some(item=>typeof item!=='string'))throw Error('unknowns: string array required');
   state.inFlight={id,digest:submission.digest};
   await persist();
   consumed=true;
   return {status:'complete',value:{model,data,unknowns:[...new Set([...unknowns,...warnings])],usage:{calls:1,tokens:'unknown'}}};
  }
  state.pendingJob={key,id,fingerprint};
  await persist();
  throw new AwaitingJob({id,stage,expectedOutput,options:{documentLanguage:options.documentLanguage??'auto'},artifact:request.artifact,input:request.input,
   ...(request.sourceGuidance?.length?{sourceGuidance:request.sourceGuidance,sourceEvidence}:{}),
   ...(stage==='analysis'?{seedPaths:analysisSeedPaths(await reader.list())}:{})},older&&!explicit);
 }};
 let report:Record<string,unknown>|undefined;
 try{
  await executeLifecycle(root,options,{review:true,resume:true,retireIds},()=>{},{
   ...paths,backend,researchSessionId:state.id,expectedFingerprint:fingerprint,report:value=>report=value
  });
 }catch(error){
  if(error instanceof AwaitingJob){
   await settle(error.job.id,error.refresh);
   return {status:['page','acceptance'].includes(error.job.stage)?'page':'planning',runId:state.id,job:error.job,
    instructions:hostPrompt+(error.refresh?'\nProject files changed after this job was sent. Re-read the current evidence before submitting this job.':'')};
  }
  if(consumed){delete state.inFlight;await persist();}
  throw error;
 }
 if(report?.reason==='openspec-preparation'&&Array.isArray(report.pending))
  return {status:'pending',runId:state.id,pending:report.pending,nextCommand:typeof report.nextCommand==='string'?report.nextCommand:undefined};
 if(!report||!validDigest(report.previewId))throw Error('Research could not prepare a project preview');
 const stored=await loadPreview(report.previewId,join(paths.cacheRoot,'previews'));
 await settle();
 delete state.pendingJob;
 state.result={previewId:report.previewId,inventory:inventorySignature(stored.assets),fingerprint,retireIds};
 await persist();
 return {status:'ready',runId:state.id};
}
