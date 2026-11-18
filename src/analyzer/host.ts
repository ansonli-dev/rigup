import {randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {link,lstat,open,realpath,unlink,writeFile} from 'node:fs/promises';
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {privateDirectory,signature,stable} from '../generator/cache.js';
import {quoteShell} from '../shell-command.js';
import {syncDirectory} from '../sync-directory.js';
import {ResearchValidationError,selectResearchOutput,validateResearch,validateResearchRequest,
 type AnalysisBackend,type RepositoryReader,type ResearchRequest,type ResearchResult} from './backend.js';
import {sliceEvidence,type EvidenceRead} from './evidence.js';
import {READ_POLICY_VERSION} from './read-policy.js';
import {PROMPT_VERSION,researchPrompt,topicEvidencePrompt} from './prompts.js';
import {dependencyLock,stageContext,stageEvidence,STAGE_EVIDENCE_POLICY} from './stage-context.js';

interface HostOptions {
 cacheRoot:string;responsePath?:string;requestPath?:string;omitDependencyLocks?:boolean;stageEvidence?:boolean;
 nativeEntryPaths?:readonly string[];allowPriorResponse?:boolean;onDiagnostic?:(message:string)=>void;
}
type Context=ResearchRequest&{evidencePolicy?:string;inputDigest?:string;evidenceSelection?:{stage:string};
 instructionsDigest?:string;evidenceDigest?:string;inventoryDigest?:string};
type Exported={requestId:string;requestDigest:string;context:Context;instructions:string;paths:string[];
 evidence:EvidenceRead[];evidenceDigest?:string;omittedEvidence?:{path:string;reason:string}[]};
type Reply={requestId:string;requestDigest:string;model:string;data:unknown};
type Accepted={requestDigest:string;result:ResearchResult};
const digestPattern=/^[a-f0-9]{64}$/;
const inside=(root:string,path:string)=>{
 const rel=relative(root,path);return !!rel&&!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep);
};

async function readHostRecord<T>(path:string,maximum=16_000_000):Promise<T|undefined>{
 let file;
 try{
  if(!(await lstat(path)).isFile())throw Error('Host exchange path must be a regular file');
  file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 }
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
 try{
  const info=await file.stat();
  if(!info.isFile()||info.size>maximum)throw Error('Invalid host exchange file');
  const bytes=await file.readFile();
  if(bytes.length>maximum)throw Error('Invalid host exchange file');
  return JSON.parse(bytes.toString('utf8')) as T;
 }finally{await file.close();}
}

async function writeHostRecord(path:string,value:unknown,compact=false){
 const temporary=path+'.'+randomUUID()+'.tmp';
 await writeFile(temporary,JSON.stringify(value,null,compact?undefined:2),{flag:'wx',mode:0o600,flush:true});
 try{
  await link(temporary,path);
  await syncDirectory(dirname(path));
  return true;
 }catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;return false;}
 finally{await unlink(temporary);}
}

const omissions=(paths:string[],selected:ReadonlySet<string>|undefined,stage?:string)=>paths
 .filter(path=>dependencyLock(path)||selected&&!selected.has(path))
 .map(path=>({path,reason:dependencyLock(path)?'Dependency lockfile body omitted from model context. Package manifests retain declared dependency ranges; exact locked/transitive versions are not supplied and must not be inferred.':
  'Body not selected for the current '+stage+' task. Inventory is navigation, not evidence of unprovided contents.'}));

async function readExport(cache:string,id:string,policy?:string):Promise<Exported>{
 const record=await readHostRecord<Exported>(join(cache,id+'.request.json'));
 if(!record||record.requestId!==id||record.requestDigest!==id||signature(record.context)!==id||
    record.context.evidencePolicy!==policy||!Array.isArray(record.evidence)||!Array.isArray(record.paths)||
    record.evidenceDigest!==undefined&&signature(record.evidence)!==record.evidenceDigest||
    record.context.instructionsDigest!==undefined&&(record.context.instructionsDigest!==signature(record.instructions)||
     record.context.evidenceDigest!==record.evidenceDigest||record.context.inventoryDigest!==signature(record.paths)))
  throw Error('Unknown or tampered host request context or evidence digest');
 if(policy){
  const stage=record.context.evidenceSelection?.stage;
  const selected=stage?new Set(record.evidence.map(item=>item.evidence.path)):undefined;
  const expected=omissions(record.paths,selected,stage);
  if(!record.evidenceDigest||stable(record.omittedEvidence)!==stable(expected)||
     record.evidence.some(item=>!record.paths.includes(item.evidence.path)||dependencyLock(item.evidence.path)))
   throw Error('Host request evidence omission policy changed');
 }
 return record;
}
const selection=(value:ResearchRequest)=>({root:value.root,runId:value.runId,options:value.options,effectiveModel:value.effectiveModel});
const phase=(value:ResearchRequest)=>({kind:value.kind,artifact:value.artifact,expectedOutput:value.expectedOutput});
const inputs=(value:Context,legacyAnalysis=false)=>({input:value.inputDigest??signature({input:value.input}),sourceGuidance:value.sourceGuidance,
 previousInventoryDigest:value.previousInventoryDigest,templateSourcesDigest:legacyAnalysis?undefined:value.templateSourcesDigest});
const sameInputs=(previous:Context,request:ResearchRequest)=>{
 const legacyAnalysis=previous.instructionsDigest===undefined&&previous.kind==='analyze';
 return stable(inputs(previous,legacyAnalysis))===stable(inputs(request,legacyAnalysis));
};
const exportedAnalysis=(exported:Exported)=>exported.context.evidenceSelection?.stage==='analyze'?exported.evidence.map(item=>item.evidence):undefined;
function snapshotReader(exported:Exported,reader:RepositoryReader):RepositoryReader{
 const read:RepositoryReader['read']=async(path,start,end)=>{
  const snippet=exported.evidence.find(item=>item.evidence.path===path&&item.evidence.startLine<=start&&item.evidence.endLine>=(end??start));
  if(!snippet)throw Error('Source was not exported for this request');
  const ref=snippet.evidence;
  if(start===ref.startLine&&end===ref.endLine)return snippet;
  const part=sliceEvidence(path,snippet.content.split('\n'),start-ref.startLine+1,(end??ref.endLine)-ref.startLine+1);
  return {...part,evidence:{...part.evidence,startLine:start,endLine:end??ref.endLine}};
 };
 return {list:async()=>exported.paths,read,sourceScopes:reader.sourceScopes,search:async()=>[]};
}

export async function reusableHostAcceptance(cache:string,id:string,request:ResearchRequest,reader:RepositoryReader){
 const accepted=await readHostRecord<Accepted>(join(cache,id+'.accepted.json'));
 if(!accepted||accepted.requestDigest!==id)return;
 const original=await readExport(cache,id,STAGE_EVIDENCE_POLICY);
 if(stable(selection(original.context))!==stable(selection(request))||stable(phase(original.context))!==stable(phase(request))||
    !sameInputs(original.context,request))return;
 await validateResearch(accepted.result.data,reader,exportedAnalysis(original),original.evidence);
 return accepted.result;
}

export function hostBackend(options:HostOptions):AnalysisBackend {
 return {artifactContextVersion:STAGE_EVIDENCE_POLICY,advisoryBudget:true,run:async(request,reader)=>{
  validateResearchRequest(request);
  if(options.requestPath&&options.responsePath)throw Error('request and response are mutually exclusive');
  const root=await realpath(request.root),cache=await privateDirectory(options.cacheRoot,root);
  const policy=options.stageEvidence?STAGE_EVIDENCE_POLICY:options.omitDependencyLocks?'dependency-manifests-v1':undefined;
  const warnings:string[]=[];
  const warn=(message:string)=>{warnings.push(message);options.onDiagnostic?.(message);};
  if(request.budget.maxCalls<1||request.budget.maxTokens<1||(request.spent?.calls??0)>=request.budget.maxCalls||
   typeof request.spent?.tokens==='number'&&request.spent.tokens>=request.budget.maxTokens)warn('Host research budget reached; review accumulated usage before continuing.');

  if(options.responsePath){
   const response=await readHostRecord<Reply>(resolve(options.responsePath),2_000_000);
   if(!response||!digestPattern.test(response.requestId)||response.requestId!==response.requestDigest||typeof response.model!=='string'||!response.model.trim())
    throw Error('Host response request identity and digest are required');
   const original=await readExport(cache,response.requestId,policy);
   if(stable(selection(original.context))!==stable(selection({...request,root})))throw Error('Host response context belongs to a different research run or selection');
   const {read:oldRead,...oldVersions}=original.context.versions,{read:newRead,...versions}=request.versions;
   if(stable(oldVersions)!==stable(versions))throw Error('Host response prompt or policy context changed');
   const acceptedPath=join(cache,response.requestId+'.accepted.json');
   const accepted=await readHostRecord<Accepted>(acceptedPath);
   const originalData=selectResearchOutput(original.context,response.data);
   if(accepted&&(accepted.requestDigest!==response.requestDigest||accepted.result.model!==response.model||signature(accepted.result.data)!==signature(originalData)))
    throw Error('Host request already has a different accepted result');
   if(stable(phase(original.context))!==stable(phase(request))){
    if(!options.allowPriorResponse||!accepted)throw Error('Host response does not match the current request stage context');
   }else if(sameInputs(original.context,request)){
    let validation:Awaited<ReturnType<typeof validateResearch>>|undefined;
    try{validation=await validateResearch(originalData,reader,exportedAnalysis(original),original.evidence);}
    catch(error){
     if(!(error instanceof ResearchValidationError)||original.context.fingerprint===request.fingerprint)throw error;
     await validateResearch(originalData,snapshotReader(original,reader),exportedAnalysis(original),original.evidence);
     warn('The cited source changed after this host request. Read the current request before responding.');
    }
    if(validation){
     const unknowns=(originalData as {unknowns?:unknown}).unknowns;
     if(!Array.isArray(unknowns)||unknowns.some(value=>typeof value!=='string'))throw Error('unknowns: required');
     if(accepted)return {status:'complete',value:accepted.result};
     const result:ResearchResult={data:originalData,model:response.model,unknowns:[...new Set([...unknowns,...validation.warnings,...warnings,'host token usage unknown'])],
      usage:{calls:'unknown',tokens:'unknown'}};
     if(await writeHostRecord(acceptedPath,{requestDigest:response.requestDigest,result},true))return {status:'complete',value:result};
     const winner=await readHostRecord<Accepted>(acceptedPath);
     if(!winner||winner.requestDigest!==response.requestDigest||winner.result.model!==result.model||signature(winner.result.data)!==signature(result.data))
      throw Error('Host request already has a different accepted result');
     return {status:'complete',value:winner.result};
    }
   }else warn('The inputs for this host stage changed. Read the current request before responding.');
  }

  const paths=await reader.list();
  const task=options.stageEvidence?stageContext(request,paths,options.nativeEntryPaths):undefined;
  const taskEvidence=task?await stageEvidence(reader,task.slices):undefined;
  const selected=taskEvidence?new Set(taskEvidence.map(item=>item.evidence.path)):undefined;
  const omittedEvidence=policy?omissions(paths,selected,task?.stage):undefined;
  const omitted=new Set(omittedEvidence?.map(item=>item.path));
  const evidence=taskEvidence??[];
  if(!task){
   let bytes=0;
   for(const path of paths){
    if(omitted.has(path))continue;
    const item=await reader.read(path,1);
    if((bytes+=Buffer.byteLength(JSON.stringify(item)))>10_000_000)throw Error('Host evidence exceeds the exchange size limit');
    evidence.push(item);
   }
  }
  const evidenceDigest=signature(evidence);
  const topicPlanning=task?.stage==='plan'&&!!(request.input as {topicEvidence?:unknown}|undefined)?.topicEvidence;
  const instructions=researchPrompt+(task?'\nStage evidence policy: paths are a full inventory, NOT proof that their contents were read. Only supplied evidence bodies and exact visible ranges are available for new verification. Prior research is bounded comparison context. Do not claim knowledge of omitted bodies or uncited lines, or infer absence from selection. Preserve all supplied counterexamples, unresolved authority and unknowns. If a needed source is unavailable, state the limitation rather than inventing it. Native instructions and gates remain authoritative at their original paths.':'')+
   (task?.stage==='analyze'||topicPlanning?'\n'+topicEvidencePrompt:'');
  const context={...request,spent:undefined,input:task?task.input:request.input,...(task?.sourceGuidance?{sourceGuidance:task.sourceGuidance}:{}),
   root,promptVersion:PROMPT_VERSION,readPolicyVersion:READ_POLICY_VERSION,evidencePolicy:policy,evidenceDigest,
   instructionsDigest:signature(instructions),inventoryDigest:signature(paths),
   inputDigest:task?signature({input:request.input}):undefined,
   evidenceSelection:task?{stage:task.stage,selectionDigest:signature(task.slices),unavailable:task.unavailable}:undefined};
  const requestId=signature(context),requestPath=join(cache,requestId+'.request.json');
  const prior=await readHostRecord<Accepted>(join(cache,requestId+'.accepted.json'));
  if(prior){
   const original=await readExport(cache,requestId,policy);
   if(prior.requestDigest!==requestId)throw Error('Cached host acceptance request changed');
   await validateResearch(prior.result.data,reader,exportedAnalysis(original),original.evidence);
   return {status:'complete',value:prior.result};
  }
  const exported:Exported={requestId,requestDigest:requestId,context,instructions,paths,evidence,evidenceDigest,...(omittedEvidence?{omittedEvidence}:{})};
  if(!await writeHostRecord(requestPath,exported))await readExport(cache,requestId,policy);
  let delivery=requestPath;
  if(options.requestPath){
   delivery=resolve(options.requestPath);
   if(!isAbsolute(options.requestPath)||!inside(cache,delivery))throw Error('Request export must be an absolute path inside private host cache');
   const directory=await privateDirectory(dirname(delivery),root);
   if(directory!==cache&&!inside(cache,directory))throw Error('Request export directory escapes the private host cache');
   if(delivery!==requestPath&&!await writeHostRecord(delivery,exported)){
    const prior=await readHostRecord<Exported>(delivery);
    if(prior?.requestId!==requestId||prior.requestDigest!==requestId)throw Error('Refusing unknown request export target');
   }
  }
  return {status:'pending-host',requestId,requestPath:delivery,nextCommand:'rigup '+(request.kind==='analyze'?'init':'update')+' --response '+quoteShell(join(cache,requestId+'.response.json'))};
 }};
}
