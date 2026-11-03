import {join} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {runProjectChecks} from './integrations/tools/quality.js';
import type {SetupOptions,CheckKind} from './types.js';
import type {AnalysisBackend,ResearchResult} from './analyzer/backend.js';
import {scanRepository,repositoryReader} from './analyzer/repository.js';
import {hostBackend} from './analyzer/host.js';
import {nativeBackend} from './analyzer/anthropic.js';
import {PROMPT_VERSION} from './analyzer/prompts.js';
import {READ_POLICY_VERSION} from './analyzer/read-policy.js';
import {generate,inventorySignature} from './generator/generate.js';
import {DOCUMENT_POLICY_VERSION} from './generator/document-policy.js';
import {TEMPLATE_VERSION} from './generator/render.js';
import {privateDirectory,signature,readCache,saveCache} from './generator/cache.js';
import {prepareIntegrations} from './integrations/registry.js';
import {loadManifest} from './installer/baseline.js';
import {acquireLock} from './installer/lock.js';
import {assertNoUnknownWriters} from './installer/operations.js';
import {preview} from './installer/preview.js';
import {readTarget,absentDigest} from './installer/preview.js';
import {digest} from './analyzer/evidence.js';
import {apply,type CheckResult} from './installer/apply.js';
export interface LifecycleFlags {dryRun?:boolean;yes?:boolean;review?:boolean;response?:string;sessionsEnded?:boolean;resume?:boolean;continuation?:string;retireIds?:string[];runChecks?:CheckKind[]}
export interface LifecycleServices {backend?:AnalysisBackend;cacheRoot?:string;stateRoot?:string;signal?:AbortSignal;runChecks?:()=>Promise<CheckResult[]>}
interface Run {root:string;options:SetupOptions;mode:LifecycleFlags;runId:string;research?:ResearchResult;spent:{calls:number;tokens:number|'unknown'};consent:string}
export async function executeLifecycle(root:string,options:SetupOptions,flags:LifecycleFlags,write:(s:string)=>void,services:LifecycleServices={}):Promise<number>{
 if(!options.agents.length){write('agents: choose at least one native host before research\n');return 2;}
 if(!flags.dryRun&&!flags.yes&&!flags.review){write('Choose --yes for bounded continuous execution, --review, or --dry-run before research\n');return 2;}
 if(options.sdd&&options.backend==='native'&&!services.backend&&(!(options.model?.model??process.env.ANTHROPIC_MODEL)||!process.env[options.model?.apiKeyEnv??'ANTHROPIC_API_KEY'])){write('model: model ID and API-key environment reference required before research\n');return 2;}
 const lock=await acquireLock(root,{stateRoot:services.stateRoot,recover:flags.resume});
 try {
  await assertNoUnknownWriters(root,lock.stateRoot);
  const base=await privateDirectory(services.cacheRoot??join(homedir(),'.cache','rigup'),root);
  const cache=await privateDirectory(join(base,'generation'),root);const requests=await privateDirectory(join(base,'host'),root);const previews=await privateDirectory(join(base,'previews'),root);const runs=await privateDirectory(join(base,'runs'),root);
  const profile=await scanRepository(root,options);const old=await loadManifest(root);profile.installedTools=old?.installedTools;
  const prepared=await prepareIntegrations(profile,options);
  const config=await readTarget(root,'.rigup/config.yaml');
  const consent=signature({root,options,configDigest:config?digest(config):absentDigest,retireIds:flags.retireIds??[],runChecks:flags.runChecks??[],versions:{prompt:PROMPT_VERSION,template:TEMPLATE_VERSION,document:DOCUMENT_POLICY_VERSION,read:READ_POLICY_VERSION},fingerprint:profile.fingerprint});
  if(flags.continuation&&flags.continuation!==consent)throw new Error('continuation input/configuration changed; restart preparation');
  const runPath=join(runs,consent+'.json');let run=await readCache<Run>(runPath);if(!run||run.consent!==consent)run={root,options,mode:{dryRun:flags.dryRun,yes:flags.yes,review:flags.review,retireIds:flags.retireIds,runChecks:flags.runChecks},runId:randomUUID(),spent:{calls:0,tokens:0},consent};
  await saveCache(runPath,JSON.stringify(run));let responseConsumed=false;
  const quote=(s:string)=>"'"+s.replaceAll("'","'\"'\"'")+"'";
  const continuation=(requestPath:string)=>'rigup update '+quote(root)+' --continue '+consent+' --response '+quote(requestPath.replace(/\.request\.json$/,'.response.json'));
  const backend:AnalysisBackend=services.backend??(options.backend==='host'?{run:async(request,reader)=>{const result=await hostBackend({cacheRoot:requests,responsePath:responseConsumed?undefined:flags.response}).run(request,reader);if(result.status==='complete'&&flags.response)responseConsumed=true;return result;}}:nativeBackend({apiKey:process.env[options.model?.apiKeyEnv??'ANTHROPIC_API_KEY'],model:options.model?.model??process.env.ANTHROPIC_MODEL,signal:services.signal}));
  if(options.sdd&&!run.research){
   write('Research: reading bounded project evidence\n');
   const result=await backend.run({kind:'analyze',runId:run.runId,root,fingerprint:profile.fingerprint,options,versions:{prompt:PROMPT_VERSION,template:TEMPLATE_VERSION,document:DOCUMENT_POLICY_VERSION,read:READ_POLICY_VERSION},budget:{maxCalls:60,maxTokens:100000},previousInventoryDigest:inventorySignature(old?.assets??[]),templateSourcesDigest:signature(prepared.assets)},await repositoryReader(root,options));
   if(result.status==='pending-host'){write('Pending host research: '+result.requestPath+'\nResume: '+continuation(result.requestPath)+'\n');return 3;}
   run.research=result.value;run.spent={calls:typeof result.value.usage.calls==='number'?result.value.usage.calls:1,tokens:result.value.usage.tokens};await saveCache(runPath,JSON.stringify(run));
  }
  profile.research=run.research;write('Generate: assembling selected capabilities\n');
  const generated=await generate(profile,options,backend,old?.assets??[],{cacheRoot:cache,runId:run.runId,spent:run.spent});
  if(generated.status==='pending-host'){write('Pending host generation: '+generated.requestPath+'\nResume: '+continuation(generated.requestPath)+'\n');return 3;}
  for(const id of flags.retireIds??[]){const disposition=generated.value.dispositions.find(d=>d.logicalId===id);if(!disposition)throw new Error('retirement id not in old inventory');if(generated.value.assets.some(a=>a.logicalId===id))throw new Error('retirement contradicts selected capability');disposition.action='retire';disposition.reason='Explicit retirement authorized before research';}
  for(const d of generated.value.dispositions)if(d.action==='retire'&&!flags.retireIds?.includes(d.logicalId))generated.value.requirements.push({integrationId:d.logicalId,reason:'Retirement is outside current consent; rerun with --retire '+d.logicalId});
  const result=await preview(generated.value,[],{cacheRoot:previews});
  write('Preview '+result.previewId+'\n');for(const item of result.items){write(item.action+' '+item.target+'\n');if(item.before!==undefined)write('--- owned before (filtered, max 4000 chars)\n'+item.before+'\n');if(item.after!==undefined)write('+++ owned after (filtered, max 4000 chars)\n'+item.after+'\n');}for(const operation of result.operations)write('operation '+operation.id+' '+operation.version+' scope '+operation.declaredWrites.join(', ')+'\n');
  for(const blocker of result.blockers)write('Blocked: '+blocker+'\n');
  if(!result.executable)return 3;
  if(flags.dryRun)return 0;
  const active=!!(process.env.CODEX_THREAD_ID||process.env.CLAUDECODE||process.env.OPENCODE||process.env.PI_CODING_AGENT_DIR);
  if(flags.review||options.backend==='host'&&active&&!flags.sessionsEnded){write('Pending review/session handoff. End affected sessions, then run from an independent terminal:\nrigup update '+JSON.stringify(root)+' --apply '+result.previewId+' --sessions-ended\n');return 3;}
  const installed=await apply(result.previewId,{cacheRoot:previews,stateRoot:lock.stateRoot,lock,recover:flags.resume,signal:services.signal,runChecks:services.runChecks??(flags.runChecks?.length?async()=>runProjectChecks(await scanRepository(root,options),flags.runChecks!,services.signal):undefined)});
  for(const warning of installed.warnings)write('Pending/note: '+warning+'\n');
  write('Install '+installed.status+'; written '+installed.written.length+'; checks '+installed.checks.map(c=>c.name+':'+c.status).join(', ')+'\n');return installed.exitCode;
 }finally{await lock.release();}
}

export async function loadContinuation(root:string,id:string,services:LifecycleServices={}):Promise<{options:SetupOptions;flags:LifecycleFlags}>{
 if(!/^[a-f0-9]{64}$/.test(id))throw new Error('continuation id invalid');
 const base=await privateDirectory(services.cacheRoot??join(homedir(),'.cache','rigup'),root);const run=await readCache<Run>(join(base,'runs',id+'.json'));
 if(!run||run.root!==root||run.consent!==id)throw new Error('continuation missing; restart preparation');return {options:run.options,flags:{...run.mode,continuation:id}};
}
