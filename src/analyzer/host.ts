import {mkdir,realpath,readFile,writeFile,lstat,rename} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute,parse} from 'node:path';
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
export function hostBackend(options:{cacheRoot:string;responsePath?:string}):AnalysisBackend {
 return {run:async(request,reader)=>{
  validateResearchRequest(request);
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
  if(options.responsePath) {
   const responsePath=resolve(options.responsePath);
   if(!inside(cache,responsePath) || await realpath(responsePath) !== responsePath || (await lstat(responsePath)).isSymbolicLink()) throw new Error('response must stay in private cache');
   const response=JSON.parse(await readFile(responsePath,'utf8'));
   if(response.requestId !== requestId || response.requestDigest !== requestDigest) throw new Error('response does not match current request context digest');
   if((await lstat(requestPath)).isSymbolicLink()) throw new Error('request path symlink denied');
   const exported=JSON.parse(await readFile(requestPath,'utf8'));
   if(exported.requestDigest !== requestDigest || exported.requestId !== requestId || stable(exported.context) !== stable(context) || exported.instructions !== researchPrompt) throw new Error('request context or instructions changed');
   await validateResearch(response.data,reader);
   if(typeof response.model !== 'string' || !response.model) throw new Error('response model: required');
   const unknowns=response.data.unknowns;
   if(!Array.isArray(unknowns)||unknowns.some((x:unknown)=>typeof x !== 'string')) throw new Error('unknowns: required');
   const result={data:response.data,model:response.model,unknowns:[...unknowns,'host token usage unknown'],usage:{calls:'unknown' as const,tokens:'unknown' as const}};
   try {await writeFile(acceptedPath,JSON.stringify({requestDigest,result}),{flag:'wx',mode:0o600});}
   catch(error){if((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;if((await lstat(acceptedPath)).isSymbolicLink()) throw new Error('accepted path symlink denied');const prior=JSON.parse(await readFile(acceptedPath,'utf8'));if(prior.requestDigest !== requestDigest || stable(prior.result) !== stable(result)) throw new Error('response already consumed with different result');}
   return {status:'complete',value:result};
  }
  const {kind,artifact,...runContext}=context;
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
  const evidence=[];for(const path of paths) evidence.push(await reader.read(path,1));
  const exported={requestId,requestDigest,context,instructions:researchPrompt,paths,evidence};
  try {await writeFile(requestPath,JSON.stringify(exported,null,2),{flag:'wx',mode:0o600});}
  catch(error){if((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;if((await lstat(requestPath)).isSymbolicLink()) throw new Error('request path symlink denied');const prior=JSON.parse(await readFile(requestPath,'utf8'));if(stable(prior) !== stable(exported)) throw new Error('refusing unknown or tampered request file');}
  return {status:'pending-host',requestId,requestPath,nextCommand:'rigup '+(request.kind === 'analyze' ? 'init' : 'update')+' --response '+"'"+join(cache,requestId+'.response.json').replaceAll("'","'\"'\"'")+"'"};
 }};
}
