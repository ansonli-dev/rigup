import {privateDirectory,readCache,saveCache,signature} from '../generator/cache.js';
import {mkdir,realpath,readFile,writeFile,lstat,rename} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute,parse,dirname} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {validateResearchRequest,validateResearch,type AnalysisBackend} from './backend.js';
import {READ_POLICY_VERSION} from './read-policy.js';
import {PROMPT_VERSION,researchPrompt} from './prompts.js';
function stable(value:unknown):string {
 if(Array.isArray(value)) return '['+value.map(stable).join(',')+']';
 if(value && typeof value === 'object') return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).filter(([,v])=>v !== undefined).map(([k,v])=>JSON.stringify(k)+':'+stable(v)).join(',')+'}';
 return JSON.stringify(value);
}
function inside(root:string,path:string):boolean {const rel=relative(root,path);return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));}
export function hostBackend(options:{cacheRoot:string;responsePath?:string;requestPath?:string}):AnalysisBackend {
 return {run:async(request,reader)=>{
  validateResearchRequest(request);if(options.requestPath&&options.responsePath)throw new Error('request and response are mutually exclusive');
  if(request.budget.maxCalls<1 || request.budget.maxTokens<1) throw new Error('host budget exhausted');
  const root=await realpath(request.root);
  const requestedCache=resolve(options.cacheRoot);
  if(inside(root,requestedCache)) throw new Error('host export must stay outside project');
  let component=parse(requestedCache).root;
  for(const part of relative(component,requestedCache).split('/').filter(Boolean)) {
   component=join(component,part);
   try {if((await lstat(component)).isSymbolicLink()) throw new Error('host cache symlink denied');}
   catch(error){if((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;await mkdir(component,{mode:0o700});}
  }
  const cache=await realpath(requestedCache);
  if(((await lstat(cache)).mode & 0o077) !== 0) throw new Error('private cache permissions required');
  if(cache !== requestedCache || inside(root,cache)) throw new Error('host cache symlink or project path denied');
  const context={...request,root,promptVersion:PROMPT_VERSION,readPolicyVersion:READ_POLICY_VERSION};
  const requestDigest=createHash('sha256').update(stable(context)).digest('hex');
  const requestId=requestDigest;
  const requestPath=join(cache,requestId+'.request.json');
  const acceptedPath=join(cache,requestId+'.accepted.json');
  let deliveryPath=options.requestPath?resolve(options.requestPath):requestPath;
  if(options.requestPath){if(!isAbsolute(options.requestPath)||!inside(cache,deliveryPath)||deliveryPath===cache)throw new Error('request export must be an absolute path inside private host cache');await privateDirectory(dirname(deliveryPath),root);}
  const verifyDelivery=async(exported:any)=>{
   if(exported.evidenceDigest&&exported.evidenceDigest!==signature(exported.evidence))throw new Error('exported evidence changed');
   if(exported.deliveryPath&&exported.deliveryPath!==requestPath){const target=exported.deliveryPath;if(!inside(cache,target)||await realpath(target)!==target||(await lstat(target)).isSymbolicLink())throw new Error('request export alias invalid');if(stable(JSON.parse(await readFile(target,'utf8')))!==stable(exported))throw new Error('request export alias changed');}
  };

  if(!options.responsePath) {
   try {
    if((await lstat(acceptedPath)).isSymbolicLink()||(await lstat(requestPath)).isSymbolicLink())throw new Error('accepted/request path symlink denied');
    const accepted=JSON.parse(await readFile(acceptedPath,'utf8'));const exported=JSON.parse(await readFile(requestPath,'utf8'));
    if(accepted.requestDigest!==requestDigest||stable(exported.context)!==stable(context)||exported.instructions!==researchPrompt)throw new Error('cached host acceptance context changed');
    await verifyDelivery(exported);await validateResearch(accepted.result.data,reader);return {status:'complete',value:accepted.result};
   }catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  }
  if(options.responsePath) {
   let responsePath=resolve(options.responsePath);if((await lstat(responsePath)).isSymbolicLink())throw new Error('response symlink denied');responsePath=await realpath(responsePath);
   const response=JSON.parse(await readFile(responsePath,'utf8'));
   if(response.requestId !== requestId || response.requestDigest !== requestDigest) throw new Error('response does not match current request context digest');
   if((await lstat(requestPath)).isSymbolicLink()) throw new Error('request path symlink denied');
   const exported=JSON.parse(await readFile(requestPath,'utf8'));
   if(exported.requestDigest !== requestDigest || exported.requestId !== requestId || stable(exported.context) !== stable(context) || exported.instructions !== researchPrompt) throw new Error('request context or instructions changed');
   await verifyDelivery(exported);await validateResearch(response.data,reader);
   if(typeof response.model !== 'string' || !response.model) throw new Error('response model: required');
   const unknowns=response.data.unknowns;
   if(!Array.isArray(unknowns)||unknowns.some((x:unknown)=>typeof x !== 'string')) throw new Error('unknowns: required');
   const result={data:response.data,model:response.model,unknowns:[...unknowns,'host token usage unknown'],usage:{calls:'unknown' as const,tokens:'unknown' as const}};
   try {await writeFile(acceptedPath,JSON.stringify({requestDigest,result}),{flag:'wx',mode:0o600});}
   catch(error){if((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;if((await lstat(acceptedPath)).isSymbolicLink()) throw new Error('accepted path symlink denied');const prior=JSON.parse(await readFile(acceptedPath,'utf8'));if(prior.requestDigest !== requestDigest || stable(prior.result) !== stable(result)) throw new Error('response already consumed with different result');}
   return {status:'complete',value:result};
  }
  const {kind,artifact,expectedOutput,input,spent,...runContext}=context;
  const runDigest=createHash('sha256').update(stable({runId:request.runId,root})).digest('hex');
  const budgetPath=join(cache,runDigest+'.budget.json');
  let state:{context:string;requests:string[];tokens:'unknown'}={context:stable(runContext),requests:[],tokens:'unknown'};
  try {
   if((await lstat(budgetPath)).isSymbolicLink()) throw new Error('budget path symlink denied');
   state=JSON.parse(await readFile(budgetPath,'utf8'));
   if(state.context !== stable(runContext) || !Array.isArray(state.requests)) throw new Error('run context changed; restart preparation');
  }catch(error){if((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
  if(!state.requests.includes(requestId)) {
   if(state.requests.length>=request.budget.maxCalls) throw new Error('host run request budget exhausted');
   state.requests.push(requestId);
   const temporary=budgetPath+'.'+randomUUID()+'.tmp';
   await writeFile(temporary,JSON.stringify(state),{flag:'wx',mode:0o600});await rename(temporary,budgetPath);
  }
  const paths=await reader.list();
  const prior=await readCache<any>(requestPath);
  if(prior){if(prior.requestDigest!==requestDigest||stable(prior.context)!==stable(context)||prior.instructions!==researchPrompt)throw new Error('request context or instructions tampered or changed');await verifyDelivery(prior);if(options.requestPath&&prior.deliveryPath!==deliveryPath)throw new Error('request export target changed');deliveryPath=prior.deliveryPath??requestPath;}
  const snapshotPath=join(cache,signature({root,fingerprint:request.fingerprint,policy:READ_POLICY_VERSION,paths})+'.evidence.json');
  let snapshot=await readCache<any>(snapshotPath);
  if(!snapshot||snapshot.digest!==signature(snapshot.evidence)||stable(snapshot.paths)!==stable(paths)){
   const evidence=[];for(const path of paths)evidence.push(await reader.read(path,1));snapshot={paths,evidence,digest:signature(evidence)};await saveCache(snapshotPath,JSON.stringify(snapshot));
  }
  const exported={requestId,requestDigest,context,instructions:researchPrompt,paths,evidence:snapshot.evidence,evidenceDigest:snapshot.digest,...(deliveryPath!==requestPath?{deliveryPath}:{})};
  try {await writeFile(requestPath,JSON.stringify(exported,null,2),{flag:'wx',mode:0o600});}
  catch(error){if((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;if((await lstat(requestPath)).isSymbolicLink()) throw new Error('request path symlink denied');const prior=JSON.parse(await readFile(requestPath,'utf8'));if(stable(prior) !== stable(exported)) throw new Error('refusing unknown or tampered request file');}
  if(deliveryPath!==requestPath){try{await writeFile(deliveryPath,JSON.stringify(exported,null,2),{flag:'wx',mode:0o600});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;if((await lstat(deliveryPath)).isSymbolicLink()||stable(JSON.parse(await readFile(deliveryPath,'utf8')))!==stable(exported))throw new Error('refusing unknown request export target');}}
  return {status:'pending-host',requestId,requestPath:deliveryPath,nextCommand:'rigup '+(request.kind === 'analyze' ? 'init' : 'update')+' --response '+"'"+join(cache,requestId+'.response.json').replaceAll("'","'\"'\"'")+"'"};
 }};
}
