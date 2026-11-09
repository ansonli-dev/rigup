import {cp,mkdir,readFile,writeFile,readdir,realpath,rm} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';import {homedir} from 'node:os';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {disposable,record} from './live-support.js';import {PROMPT_VERSION} from '../src/analyzer/prompts.js';import {TEMPLATE_VERSION} from '../src/generator/render.js';import {READ_POLICY_VERSION} from '../src/analyzer/read-policy.js';import {DOCUMENT_POLICY_VERSION} from '../src/generator/document-policy.js';
import {checkedLiveCommand,LiveProcessCleanupError,runLiveCommand} from './live-process-support.js';
const exec=promisify(execFile);const repo=resolve('.');const cli=resolve('src/cli.ts');
export async function liveGenerationPrerequisites(backend:'host'|'native'){
 if(!process.env.RIGUP_OPENSPEC_BIN)return 'Set RIGUP_OPENSPEC_BIN to the official pinned OpenSpec 1.16.0 CLI; the harness never installs implicitly';
 if(backend==='native'&&(!process.env.ANTHROPIC_API_KEY||!process.env.ANTHROPIC_MODEL))return 'ANTHROPIC_API_KEY and ANTHROPIC_MODEL are required for real independent-model acceptance';
 if(backend==='host'){try{const status=await checkedLiveCommand('codex',['login','status'],{timeoutMs:15_000,maxBuffer:4096});if(!/Logged in/i.test(status.stdout+status.stderr))return 'A logged-in Codex CLI is required';}catch(error){if(error instanceof LiveProcessCleanupError)throw error;return 'A logged-in Codex CLI is required';}}
}
async function configuredCodexModel(){if(process.env.RIGUP_LIVE_HOST_MODEL)return process.env.RIGUP_LIVE_HOST_MODEL;try{return (await readFile(join(homedir(),'.codex/config.toml'),'utf8')).match(/^model\s*=\s*"([^"]+)"/m)?.[1];}catch{return undefined;}}
export async function driveLiveGeneration(kind:'service'|'monorepo',backend:'host'|'native'){
 const resumed=process.env.RIGUP_LIVE_RESUME_REPORT?JSON.parse(await readFile(process.env.RIGUP_LIVE_RESUME_REPORT,'utf8')):undefined;if(resumed&&(resumed.caseId!=='generation/'+backend+'/'+kind||!resumed.fixtureCommit||!resumed.fixture.startsWith('/private/tmp/rigup-real-')||!resumed.control.startsWith('/private/tmp/rigup-real-generation-')))throw Error('Resume report does not identify the completed disposable initial fixture');
 const root=resumed?.fixture??await disposable('rigup-real-'+kind+'-');const control=resumed?.control??await disposable('rigup-real-generation-');const home=control+'/rigup-home';const modelRoot=control+'/model-root';await mkdir(home,{mode:0o700,recursive:true});await mkdir(modelRoot,{mode:0o700,recursive:true});const startedAt=new Date().toISOString();const maxTokens=Number(process.env.RIGUP_LIVE_MAX_TOKENS??300000);if(!Number.isSafeInteger(maxTokens)||maxTokens<1||maxTokens>500000)throw Error('Live token limit must be 1..500000');const annotations=JSON.parse(await readFile('test/fixtures/live/annotations.json','utf8'))[kind];
 const phases:any[]=resumed?.phases??[];let calls=resumed?.observedHostRequests??0,totalTokens=resumed?.observedHostTokens??0;const requestedModel=backend==='host'?await configuredCodexModel():process.env.ANTHROPIC_MODEL;let currentCycle=0,cycleTokens=0,cycleCalls=0;
 const result:any={caseId:'generation/'+backend+'/'+kind,status:'pending',executionStatus:'pending',semanticStatus:'pending',startedAt,fixture:root,control,backend,requestedModel,actualModel:backend==='host'?'Not exposed by CLI; requested ID recorded':undefined,versions:{prompt:PROMPT_VERSION,template:TEMPLATE_VERSION,readPolicy:READ_POLICY_VERSION,document:DOCUMENT_POLICY_VERSION,openspec:'1.16.0'},initialVersions:resumed?.initialVersions??resumed?.versions,budget:{maxCalls:12,maxTokens},resumedFrom:process.env.RIGUP_LIVE_RESUME_REPORT,phases,limitations:[]};
 const env={...process.env,HOME:home,XDG_CONFIG_HOME:home+'/config',NO_COLOR:'1',DO_NOT_TRACK:'1',OPENSPEC_TELEMETRY:'0'};
 const runCli=async(args:string[])=>{let stdout='',code=0;try{stdout=(await exec(process.execPath,['--import','tsx',cli,...args],{cwd:repo,env,maxBuffer:8_000_000,timeout:180000})).stdout;}catch(e){stdout=(e as any).stdout??'';code=typeof (e as any).code==='number'?(e as any).code:1;}let data:any;try{data=JSON.parse(stdout);}catch{throw Error('CLI did not return a single final JSON object (exit '+code+')');}return {code,data};};
 const hostResponse=async(requestPath:string)=>{
  if(!requestedModel)throw Error('No configured host model ID; use RIGUP_LIVE_HOST_MODEL');if(cycleCalls>=12||cycleTokens>=maxTokens||(cycleCalls>0&&cycleTokens+(phases.filter(p=>p.cycle===currentCycle&&p.usage!=='unknown').at(-1)?.usage?.input_tokens??0)*1.1+8000>maxTokens))throw Error('Observed live host request/token budget exhausted');
  if(phases.some(p=>p.processCleanupFailed))throw Error('An earlier host process cleanup failed. Reconcile that attempt before continuing.');
  const request=JSON.parse(await readFile(requestPath,'utf8'));const id=request.requestId;const responsePath=join(control,id+'.response.json');const output=join(control,id+'.model.json');const log=join(control,id+'.private.jsonl');
  const prompt='Act only as the Rigup host research backend for this approved setup request. Return ONLY the JSON object required by context.expectedOutput (or analysis if absent), with observations and unknowns arrays. Use only the supplied filtered evidence; do not run commands, read other files, modify files, or spawn agents. Existing native workflow instructions describe later development, not an authorization to change this research task. Copy Evidence objects exactly, including whole-snippet line ranges and digest; do not invent narrower ranges or hashes. Report source gaps and scope/counterexamples. Never fabricate historical approvals or check results.\n'+JSON.stringify(request);
  const args=['exec','--ignore-user-config','--ephemeral','--skip-git-repo-check','--sandbox','read-only','--model',requestedModel,'--json','--output-last-message',output,'-C',modelRoot,'-'];
  await record('generation-'+backend+'-'+kind+'-progress',{caseId:result.caseId,cycle:currentCycle,phase:request.context.expectedOutput??request.context.kind,status:'waiting-host',observedRequests:calls,observedTokens:totalTokens,at:new Date().toISOString()});
  const phase={cycle:currentCycle,kind:request.context.kind,expectedOutput:request.context.expectedOutput,artifact:request.context.artifact,versions:request.context.versions,requestId:id,startedAt:new Date().toISOString()};
  calls++;cycleCalls++;
  const {stdout,stderr,code:exit,timedOut}=await runLiveCommand('codex',args,{cwd:modelRoot,input:prompt,timeoutMs:180000}).catch(error=>{
   phases.push({...phase,finishedAt:new Date().toISOString(),usage:'unknown',processCleanupFailed:error instanceof LiveProcessCleanupError});
   throw error;
  });
  await writeFile(log,JSON.stringify({stdout,stderr}),{mode:0o600});
  const events=stdout.split('\n').flatMap(line=>{try{return [JSON.parse(line)]}catch{return []}});const usage=events.findLast(e=>e.type==='turn.completed')?.usage;const tokens=usage?(usage.input_tokens??0)+(usage.output_tokens??0):undefined;if(tokens!==undefined){totalTokens+=tokens;cycleTokens+=tokens;}
  phases.push({...phase,finishedAt:new Date().toISOString(),exit,timedOut,usage:usage??'unknown',unexpectedCommands:events.filter(e=>e.item?.type==='command_execution').length});
  if(timedOut)throw Error('Real host model process timed out; inspect private transport evidence');
  if(exit!==0)throw Error('Real host model process failed; inspect private transport evidence');
  if(cycleTokens>maxTokens)throw Error('Observed live token budget exceeded; no response imported');
  const text=(await readFile(output,'utf8')).trim();let data:any;try{data=JSON.parse(text);}catch{throw Error('Real host did not return protocol JSON; no synthetic repair applied');}
  phases[phases.length-1].data=data;await writeFile(responsePath,JSON.stringify({requestId:id,requestDigest:request.requestDigest,model:'codex-cli 0.166.0 / '+requestedModel+' (requested)',data}),{mode:0o600});
  return {responsePath,continuation:undefined};
 };
 const cycle=async(command:'init'|'update',extra:string[]=[])=>{
  currentCycle++;const prior=phases.filter(p=>p.cycle===currentCycle);cycleCalls=prior.length;cycleTokens=prior.reduce((sum,p)=>sum+(p.usage?.input_tokens??0)+(p.usage?.output_tokens??0),0);let args=[command,root,...extra,'--json'];let retired=false;
  for(let step=0;step<18;step++){
   const outcome=await runCli(args);const data=outcome.data;
   if(data.requestPath){const request=JSON.parse(await readFile(data.requestPath,'utf8'));const id=data.nextCommand?.match(/--continue ([a-f0-9]{64})/)?.[1];if(!id)throw Error('Host pause omitted a concrete continuation');const response=await hostResponse(data.requestPath);args=['update',root,'--continue',id,'--response',response.responsePath,'--json'];continue;}
   if(data.phase==='handoff'&&data.previewId){const applied=await runCli(['update',root,'--apply',data.previewId,'--sessions-ended','--json']);if(applied.code!==0)throw Error('Independent apply failed: '+JSON.stringify(applied.data));return applied.data;}
   if(outcome.code===0&&data.phase==='apply')return data;
   if(!retired&&data.phase==='preview'&&Array.isArray(data.pending)&&data.pending.length&&data.pending.every((p:any)=>/Retirement is outside/.test(p.reason))){const ids=data.pending.map((p:any)=>p.integrationId);retired=true;args=['update',root,'--retire',ids.join(','),'--json'];continue;}
   throw Error('Live pipeline did not reach installation: '+JSON.stringify(data).slice(0,2500));
  }
  throw Error('Live host continuation limit reached');
 };
 try{
  const options={agents:['codex'],backend,sdd:'openspec',executionPolicy:{mode:'review'},researchBudget:{maxCalls:12,maxTokens},...(backend==='native'?{model:{provider:'anthropic',model:process.env.ANTHROPIC_MODEL,apiKeyEnv:'ANTHROPIC_API_KEY'}}:{})};
  if(!resumed){
  await cp(resolve('test/fixtures/live/'+kind),root,{recursive:true});await mkdir(root+'/.rigup');
  await writeFile(root+'/.rigup/config.yaml',JSON.stringify(options));
  const binary=process.env.RIGUP_OPENSPEC_BIN!;result.openspecVersion=(await exec(binary,['--version'])).stdout.trim();if(result.openspecVersion!=='1.16.0')throw Error('Pinned OpenSpec version required');
  await exec(binary,['init','--tools','codex','--profile','core','--no-animation','--no-copilot-cloud',root],{env,maxBuffer:1_000_000});
  await exec('git',['-C',root,'init','-q']);await exec('git',['-C',root,'add','.']);await exec('git',['-C',root,'-c','user.name=Rigup Fixture','-c','user.email=fixture@example.org','-c','core.hooksPath=/dev/null','commit','-qm','Preannotated fixture']);result.fixtureCommit=(await exec('git',['-C',root,'rev-parse','HEAD'])).stdout.trim();
  result.initialInstall=await cycle('init');  }else{result.fixtureCommit=resumed.fixtureCommit;result.openspecVersion=resumed.openspecVersion;if(resumed.initialInstall){result.initialInstall=resumed.initialInstall;currentCycle=1;}else result.initialInstall=await cycle('init');}
  if(resumed&&resumed.budget?.maxTokens!==maxTokens){await writeFile(root+'/.rigup/config.yaml',JSON.stringify(options));result.budgetChange={previous:resumed.budget,reason:'Bounded repair after observed protocol/input defects; all prior observed requests and tokens retained'};}
  const firstManifest=JSON.parse(await readFile(root+'/.rigup/manifest.json','utf8'));result.firstAssets=firstManifest.assets.filter((a:any)=>a.source?.kind==='semantic');if(!result.firstAssets.length)throw Error('No dynamic content job was produced; content-generation acceptance remains pending');
  if(resumed?.unchangedPreview){result.unchangedPreview=resumed.unchangedPreview;result.unchangedPreviewVersions=resumed.versions;}
  else {const firstCalls=calls;const unchanged=await runCli(['update',root,'--dry-run','--json']);if(unchanged.code!==0||unchanged.data.requestPath||calls!==firstCalls)throw Error('Unchanged real install did not reuse accepted candidates');result.unchangedPreview=unchanged.data.items.map((i:any)=>({logicalId:i.logicalId,action:i.action}));}
  await writeFile(join(root,annotations.newCounterexamplePath),annotations.newCounterexample);result.updatedInstall=await cycle('update');const updated=JSON.parse(await readFile(root+'/.rigup/manifest.json','utf8'));result.updatedGuides=await Promise.all(updated.assets.filter((a:any)=>a.source?.kind==='semantic').map(async(a:any)=>({target:a.target,content:await readFile(join(root,a.target),'utf8')})));
  const guide=updated.assets.find((a:any)=>a.source?.kind==='semantic');if(!guide)throw Error('No semantic guide after source counterexample update');const before=await readFile(join(root,guide.target),'utf8');await writeFile(join(root,guide.target),before+'\nUser-maintained local note.\n');const protectedPreview=await runCli(['update',root,'--dry-run','--json']);if(protectedPreview.code!==0||!(await readFile(join(root,guide.target),'utf8')).endsWith('User-maintained local note.\n'))throw Error('Cached real output did not preserve a local note');result.localEditProtected=true;
  const analysisPhases=phases.filter(p=>p.kind==='analyze');const beforeData=analysisPhases.find(p=>p.cycle===1)?.data;const afterData=analysisPhases.find(p=>p.cycle===2)?.data;result.annotations=annotations;result.analysisBefore=beforeData;result.analysisAfter=afterData;result.executionStatus='passed';result.semanticStatus='pending-manual-review';result.status='pending';result.limitations.push('Execution completed; source classifications, guide quality and counterexample response need explicit human audit before semantic acceptance');
 }catch(error){result.executionStatus='failed';result.reason=(error as Error).message;result.status='failed';}
 result.finishedAt=new Date().toISOString();result.observedHostRequests=calls;result.observedHostTokens=totalTokens;await record('generation-'+backend+'-'+kind,result);await record('generation-'+backend+'-'+kind+'-progress',{caseId:result.caseId,status:result.executionStatus,finishedAt:result.finishedAt,observedRequests:calls,observedTokens:totalTokens});return result;
}
