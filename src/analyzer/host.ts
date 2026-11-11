import {privateDirectory,readCache,saveCache,signature,stable} from '../generator/cache.js';
import {realpath,readFile,writeFile,lstat} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute,dirname} from 'node:path';
import {assertPrivateAccess} from '../private-access.js';
import {quoteShell} from '../shell-command.js';
import {validateResearchRequest,validateResearch,selectResearchOutput,type AnalysisBackend} from './backend.js';
import {READ_POLICY_VERSION} from './read-policy.js';
import {PROMPT_VERSION,researchPrompt,topicEvidencePrompt} from './prompts.js';
import {stageContext,stageEvidence,dependencyLock,STAGE_EVIDENCE_POLICY} from './stage-context.js';
function inside(root:string,path:string):boolean {const rel=relative(root,path);return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));}
async function readHostRecord(path:string){
 if(process.platform==='win32'){
  const stat=await lstat(path);
  if(stat.isSymbolicLink()||!stat.isFile())throw Error('host record is not private');
  await assertPrivateAccess(path,stat,'host record is not private');
 }
 return JSON.parse(await readFile(path,'utf8'));
}
export function hostBackend(options:{cacheRoot:string;responsePath?:string;requestPath?:string;omitDependencyLocks?:boolean;stageEvidence?:boolean;nativeEntryPaths?:readonly string[]}):AnalysisBackend {
 return {artifactContextVersion:STAGE_EVIDENCE_POLICY,run:async(request,reader)=>{
  validateResearchRequest(request);if(options.requestPath&&options.responsePath)throw new Error('request and response are mutually exclusive');
  if(request.budget.maxCalls<1 || request.budget.maxTokens<1) throw new Error('host budget exhausted');
  const root=await realpath(request.root);
  const cache=await privateDirectory(options.cacheRoot,root);
  const paths=await reader.list();
  const task=options.stageEvidence?stageContext(request,paths,options.nativeEntryPaths):undefined;
  const taskEvidence=task?await stageEvidence(reader,task.slices):undefined;
  const analysisCitations=task?.stage==='analyze'?taskEvidence?.map(item=>item.evidence):undefined;
  const selected=taskEvidence?new Set(taskEvidence.map(item=>item.evidence.path)):undefined;
  const protectedEvidence=options.omitDependencyLocks||options.stageEvidence;
  const omittedEvidence=protectedEvidence?paths.filter(path=>dependencyLock(path)||selected&&!selected.has(path)).map(path=>({path,reason:dependencyLock(path)?'Dependency lockfile body omitted from model context. Package manifests retain declared dependency ranges; exact locked/transitive versions are not supplied and must not be inferred.':'Body not selected for the current '+task!.stage+' task. Inventory is navigation, not evidence of unprovided contents.'})):[];
  const omitted=new Set(omittedEvidence.map(item=>item.path));const evidencePaths=paths.filter(path=>!omitted.has(path));
  const context={...request,input:task?task.input:request.input,...(task?.sourceGuidance?{sourceGuidance:task.sourceGuidance}:{}),root,promptVersion:PROMPT_VERSION,readPolicyVersion:READ_POLICY_VERSION,evidencePolicy:task?STAGE_EVIDENCE_POLICY:options.omitDependencyLocks?'dependency-manifests-v1':undefined,inputDigest:task?signature({input:request.input}):undefined,evidenceSelection:task?{stage:task.stage,selectionDigest:signature(task.slices),unavailable:task.unavailable}:undefined};
  const topicPlanning=task?.stage==='plan'&&!!(request.input as {topicEvidence?:unknown}|undefined)?.topicEvidence;
  const instructions=researchPrompt+(task?'\nStage evidence policy: paths are a full inventory, NOT proof that their contents were read. Only supplied evidence bodies and exact visible ranges are available for new verification. Prior research is bounded comparison context. Do not claim knowledge of omitted bodies or uncited lines, or infer absence from selection. Preserve all supplied counterexamples, unresolved authority and unknowns. If a needed source is unavailable, state the limitation rather than inventing it. Native instructions and gates remain authoritative at their original paths.':'')+
   (task?.stage==='analyze'||topicPlanning?'\n'+topicEvidencePrompt:'');
  const requestDigest=signature(context);
  const requestId=requestDigest;
  const requestPath=join(cache,requestId+'.request.json');
  const acceptedPath=join(cache,requestId+'.accepted.json');
  let deliveryPath=options.requestPath?resolve(options.requestPath):requestPath;
  if(options.requestPath){if(!isAbsolute(options.requestPath)||!inside(cache,deliveryPath)||deliveryPath===cache)throw new Error('request export must be an absolute path inside private host cache');await privateDirectory(dirname(deliveryPath),root);}
  const verifyEvidence=(exported:any)=>{
   if(exported.evidenceDigest&&exported.evidenceDigest!==signature(exported.evidence))throw new Error('exported evidence changed');
   if(protectedEvidence&&(!Array.isArray(exported.evidence)||typeof exported.evidenceDigest!=='string'||stable(exported.paths)!==stable(paths)||stable(exported.omittedEvidence)!==stable(omittedEvidence)||(!task&&stable(exported.evidence.map((item:any)=>item?.evidence?.path))!==stable(evidencePaths))))throw new Error('exported evidence policy changed');
   if(task&&stable(exported.evidence)!==stable(taskEvidence))throw new Error('exported task evidence changed or exceeds its selection');
  };
  const verifyDelivery=async(exported:any)=>{
   verifyEvidence(exported);
   if(exported.deliveryPath&&exported.deliveryPath!==requestPath){const target=exported.deliveryPath;if(!inside(cache,target)||await realpath(target)!==target||(await lstat(target)).isSymbolicLink())throw new Error('request export alias invalid');if(stable(await readHostRecord(target))!==stable(exported))throw new Error('request export alias changed');}
  };
  const sourceCitations=(exported:any)=>Array.isArray(exported.evidence)?exported.evidence.filter((item:any)=>item?.evidence&&typeof item.content==='string'):[];

  if(!options.responsePath) {
   try {
    if((await lstat(acceptedPath)).isSymbolicLink()||(await lstat(requestPath)).isSymbolicLink())throw new Error('accepted/request path symlink denied');
    const accepted=await readHostRecord(acceptedPath);const exported=await readHostRecord(requestPath);
    if(accepted.requestDigest!==requestDigest||stable(exported.context)!==stable(context)||exported.instructions!==instructions)throw new Error('cached host acceptance context changed');
    await verifyDelivery(exported);await validateResearch(accepted.result.data,reader,analysisCitations,sourceCitations(exported));return {status:'complete',value:accepted.result};
   }catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  }
  if(options.responsePath) {
   let responsePath=resolve(options.responsePath);if((await lstat(responsePath)).isSymbolicLink())throw new Error('response symlink denied');responsePath=await realpath(responsePath);
   const response=JSON.parse(await readFile(responsePath,'utf8'));
   if(response.requestId !== requestId || response.requestDigest !== requestDigest) throw new Error('response does not match current request context digest');
   if((await lstat(requestPath)).isSymbolicLink()) throw new Error('request path symlink denied');
   const exported=await readHostRecord(requestPath);
   if(exported.requestDigest !== requestDigest || exported.requestId !== requestId || stable(exported.context) !== stable(context) || exported.instructions !== instructions) throw new Error('request context or instructions changed');
   const data=selectResearchOutput(request,response.data);
   await verifyDelivery(exported);await validateResearch(data,reader,analysisCitations,sourceCitations(exported));
   if(typeof response.model !== 'string' || !response.model) throw new Error('response model: required');
   const unknowns=(data as {unknowns?:unknown}).unknowns;
   if(!Array.isArray(unknowns)||unknowns.some((x:unknown)=>typeof x !== 'string')) throw new Error('unknowns: required');
   const result={data,model:response.model,unknowns:[...unknowns,'host token usage unknown'],usage:{calls:'unknown' as const,tokens:'unknown' as const}};
   try {await writeFile(acceptedPath,JSON.stringify({requestDigest,result}),{flag:'wx',mode:0o600});}
   catch(error){if((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;if((await lstat(acceptedPath)).isSymbolicLink()) throw new Error('accepted path symlink denied');const prior=await readHostRecord(acceptedPath);if(prior.requestDigest !== requestDigest || stable(prior.result) !== stable(result)) throw new Error('response already consumed with different result');}
   return {status:'complete',value:result};
  }
  const {kind,artifact,expectedOutput,input,spent,inputDigest,evidenceSelection,...runContext}=context;
  const runDigest=signature({runId:request.runId,root});
  const budgetPath=join(cache,runDigest+'.budget.json');
  let state:{context:string;requests:string[];tokens:'unknown'}={context:stable(runContext),requests:[],tokens:'unknown'};
  try {
   if((await lstat(budgetPath)).isSymbolicLink()) throw new Error('budget path symlink denied');
   state=await readHostRecord(budgetPath);
   if(state.context !== stable(runContext) || !Array.isArray(state.requests)) throw new Error('run context changed; restart preparation');
  }catch(error){if((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
  if(!state.requests.includes(requestId)) {
   if(state.requests.length>=request.budget.maxCalls) throw new Error('host run request budget exhausted');
   state.requests.push(requestId);
   await saveCache(budgetPath,JSON.stringify(state));
  }
  const prior=await readCache<any>(requestPath);
  if(prior){if(prior.requestDigest!==requestDigest||stable(prior.context)!==stable(context)||prior.instructions!==instructions)throw new Error('request context or instructions tampered or changed');await verifyDelivery(prior);if(options.requestPath&&prior.deliveryPath!==deliveryPath)throw new Error('request export target changed');deliveryPath=prior.deliveryPath??requestPath;}
  const snapshotPath=join(cache,signature({root,fingerprint:request.fingerprint,policy:READ_POLICY_VERSION,paths:evidencePaths})+'.evidence.json');
  let snapshot=task?{paths:evidencePaths,evidence:taskEvidence,digest:signature(taskEvidence)}:await readCache<any>(snapshotPath);
  if(!task&&(!snapshot||snapshot.digest!==signature(snapshot.evidence)||stable(snapshot.paths)!==stable(evidencePaths))){
   const evidence=[];for(const path of evidencePaths)evidence.push(await reader.read(path,1));snapshot={paths:evidencePaths,evidence,digest:signature(evidence)};await saveCache(snapshotPath,JSON.stringify(snapshot));
  }
  const exported={requestId,requestDigest,context,instructions,paths,evidence:snapshot.evidence,evidenceDigest:snapshot.digest,...(protectedEvidence?{omittedEvidence}:{}),...(deliveryPath!==requestPath?{deliveryPath}:{})};
  verifyEvidence(exported);
  try {await writeFile(requestPath,JSON.stringify(exported,null,2),{flag:'wx',mode:0o600});}
  catch(error){if((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;if((await lstat(requestPath)).isSymbolicLink()) throw new Error('request path symlink denied');const prior=await readHostRecord(requestPath);if(stable(prior) !== stable(exported)) throw new Error('refusing unknown or tampered request file');}
  if(deliveryPath!==requestPath){try{await writeFile(deliveryPath,JSON.stringify(exported,null,2),{flag:'wx',mode:0o600});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;if((await lstat(deliveryPath)).isSymbolicLink()||stable(await readHostRecord(deliveryPath))!==stable(exported))throw new Error('refusing unknown request export target');}}
  return {status:'pending-host',requestId,requestPath:deliveryPath,nextCommand:'rigup '+(request.kind === 'analyze' ? 'init' : 'update')+' --response '+quoteShell(join(cache,requestId+'.response.json'))};
 }};
}
