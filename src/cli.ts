#!/usr/bin/env node
import {readFile,realpath,rm} from 'node:fs/promises';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {homedir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {onboard} from './onboarding.js';
import {terminalReader,promptChoice} from './prompt.js';
import {loadOptions,validateOptions} from './config.js';
import {researchBudget} from './analyzer/budget.js';
import type {SetupOptions} from './types.js';
import {loadManifest} from './installer/baseline.js';
import {loadPreview} from './installer/preview.js';
import {apply} from './installer/apply.js';
import {doctor} from './installer/doctor.js';
import {sessionHandoffRequired} from './installer/session.js';
import {defaultStateRoot} from './installer/lock.js';
import {executeLifecycle,loadContinuation,type LifecycleServices,type LifecycleFlags} from './lifecycle.js';
import {inspectOpenSpec,prepareOpenSpec,reportOpenSpecPending} from './integrations/sdd/openspec-setup.js';
import {openspecPreparationCommand} from './integrations/sdd/openspec.js';
import {privateDirectory,signature} from './generator/cache.js';
import {readDurableRecord,saveDurable} from './private-record.js';
import {quoteShell} from './shell-command.js';
export interface CliIO {cwd:string;isTTY:boolean;write(text:string):void;writeError?(text:string):void;read?(secret?:boolean):Promise<string|null>;services?:LifecycleServices}
const errorMessage=(error:unknown)=>error instanceof SyntaxError?'input/cache: invalid JSON syntax; inspect the local file without exporting its contents':error instanceof Error?error.message:'operation failed';
const help='rigup                         Open the interactive project menu (TTY)\nrigup init [path] [--agents claude,codex,opencode,omp] [--sdd superpowers|openspec|spec-kit|none] [--tools openwiki,codegraph|none] [--defer-research]\nrigup update [path] [--configure] [--dry-run|--review] [--apply previewId] [--request private-path|--response path] [--sessions-ended] [--resume]\nrigup doctor [path] [--run-checks build,lint,test,environment,eval]\nOptions: --backend codex|native|host --profile path --language auto|language-tag --model modelId --api-key-env NAME --json\nAdvanced: --retire logicalId,... --continue runId --research-tokens N --prepare-openspec\nOmit path to use the current directory. Missing setup choices are prompted in a TTY; --json never prompts.\n';
async function runCliInternal(argv:string[],io:CliIO):Promise<number>{
 const services:LifecycleServices={...io.services};
 const flags:LifecycleFlags={};const overrides:Partial<SetupOptions>={};const positional:string[]=[];let applyId:string|undefined;
 const boolean=new Set(['--dry-run','--configure','--review','--sessions-ended','--resume','--defer-research','--prepare-openspec']);const valued=new Set(['--agents','--sdd','--tools','--backend','--profile','--language','--response','--request','--apply','--model','--api-key-env','--continue','--retire','--run-checks','--research-tokens']);const values:Record<string,string>={};
 for(let i=0;i<argv.length;i++){
  const arg=argv[i];if(boolean.has(arg)){values[arg]='true';continue;}if(valued.has(arg)){if(!argv[i+1]||argv[i+1].startsWith('--')){io.write(arg+': value required\n');return 2;}values[arg]=argv[++i];continue;}
  if(arg==='--help'){io.write(help);return 0;}
  if (arg === '--version') {
   const {version} = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
   io.write(`${version}\n`);
   return 0;
  }
  if(arg.startsWith('-')){io.write('Unknown option\n');return 2;}positional.push(arg);
 }
 if(positional.length>2||positional[0]&&!['init','update','doctor'].includes(positional[0])){io.write(help);return 2;}
 if(!positional.length&&!io.isTTY){io.write(help+'Choose a lifecycle command\n');return 2;}
 let root:string;try{root=await realpath(resolve(io.cwd,positional[1]??'.'));}catch{io.write('path: existing directory required\n');return 2;}
 let manifest:Awaited<ReturnType<typeof loadManifest>>;
 try{manifest=await loadManifest(root);}catch{io.write('manifest: damaged metadata; diagnose before setup\n');return 1;}
 let command=positional[0];
 if(!command){io.write(manifest?'1. update\n2. doctor\n3. exit\n':'1. init\n2. doctor\n3. exit\n');const a=await io.read?.();if(a==null||a==='3')return 130;if(!['1','2'].includes(a))return 2;command=a==='2'?'doctor':manifest?'update':'init';}
 if(values['--defer-research']){
  if(command!=='init'||manifest||['--apply','--continue','--request','--response','--retire'].some(arg=>values[arg])){
   io.write('--defer-research: use with initial setup and a selected development workflow\n');return 2;
  }
  flags.deferResearch=true;
 }
 if(command==='init'&&manifest)command='update';
 io.write(command+': '+root+'\n');
 if(values['--prepare-openspec']&&(command==='doctor'||['--apply','--dry-run','--continue','--request','--response','--research-tokens'].some(flag=>values[flag]))){
  io.write('--prepare-openspec is a separate native setup step for init or update\n');
  return 2;
 }
 if(command==='doctor'){if(values['--research-tokens']){io.write('--research-tokens applies to Codex research only\n');return 2;}try{const runChecks=values['--run-checks']?.split(',');if(runChecks?.some(k=>!['build','lint','test','environment','eval'].includes(k))){io.write('run-checks: existing check kinds required\n');return 2;}const report=await doctor(root,{runChecks:runChecks as import('./types.js').CheckKind[],stateRoot:io.services?.stateRoot,signal:io.services?.signal});io.services?.report?.({phase:'doctor',installStatus:'not-applicable',...report});for(const d of report.diagnostics)io.write(d.category+' '+d.id+': '+d.state+' — '+d.reason+'\n');for(const c of report.checks)io.write('check '+c.name+': '+c.status+' '+(c.startedAt??'')+' '+(c.commit??'')+'\n');return report.exitCode;}catch(e){io.write(errorMessage(e)+'\n');return 1;}}
 if(values['--agents'])overrides.agents=values['--agents'].split(',') as SetupOptions['agents'];
 if(values['--sdd']&&values['--sdd']!=='none')overrides.sdd=values['--sdd'] as SetupOptions['sdd'];
 if(values['--backend'])overrides.backend=values['--backend'] as SetupOptions['backend'];
 if(values['--profile'])overrides.profile=values['--profile'];
 if(values['--language'])overrides.documentLanguage=values['--language'];
 flags.dryRun=!!values['--dry-run'];flags.yes=!io.isTTY&&!values['--dry-run']&&!values['--review'];flags.review=!!values['--review'];flags.response=values['--response'];flags.request=values['--request'];flags.configure=!!values['--configure'];if(flags.request){const privateRoot=resolve(io.services?.cacheRoot??join(homedir(),'.cache','rigup'),'host');const rel=relative(privateRoot,resolve(flags.request));if(!isAbsolute(flags.request)||!rel||rel.startsWith('..')||isAbsolute(rel)){io.write('request: use an absolute file path inside '+privateRoot+'\n');return 2;}}if(flags.request&&flags.response){io.write('request/response: choose one\n');return 2;}flags.sessionsEnded=!!values['--sessions-ended'];flags.resume=!!values['--resume'];flags.retireIds=values['--retire']?.split(',');flags.runChecks=values['--run-checks']?.split(',') as import('./types.js').CheckKind[];if(flags.runChecks?.some(k=>!['build','lint','test','environment','eval'].includes(k))){io.write('run-checks: existing kinds required\n');return 2;}applyId=values['--apply'];
 if([flags.dryRun,flags.yes,flags.review].filter(Boolean).length>1){io.write('execution mode: choose one\n');return 2;}
 if(values['--research-tokens']){
  const tokens=Number(values['--research-tokens']);
  if(!/^[1-9][0-9]*$/.test(values['--research-tokens'])||!Number.isSafeInteger(tokens)||applyId||command==='doctor'||flags.deferResearch){io.write('--research-tokens: a positive cumulative limit is required for a Codex research run\n');return 2;}
  flags.researchTokens=tokens;
 }
 if(applyId){
  if(overrides.documentLanguage){io.write('--language: prepare a new preview to change the document language\n');return 2;}
  if(await sessionHandoffRequired(root,flags.sessionsEnded)){io.write('End affected sessions and use --sessions-ended from an independent terminal\n');return 3;}
  try{
   const cacheRoot=join(services.cacheRoot??join(homedir(),'.cache','rigup'),'previews');
   const prepared=await loadPreview(applyId,cacheRoot);
   if(prepared.plan.root!==root)throw new Error('preview project root differs from requested path');
   if(flags.runChecks&&JSON.stringify([...flags.runChecks].sort())!==JSON.stringify([...(prepared.plan.runChecks??[])].sort()))throw new Error('apply checks differ from approved preview; prepare a new preview with --run-checks');
   if(!manifest&&prepared.preview.executable&&prepared.plan.options.sdd==='openspec'){
    const setup=await inspectOpenSpec(root,prepared.plan.options,services.signal);
    if(services.signal?.aborted)return 130;
    if(setup.requirements.length){
     for(const requirement of setup.requirements)io.write('OpenSpec: '+requirement+'\n');
     const resume=setup.needsProject
      ?'rigup init '+quoteShell(root)+' --agents '+prepared.plan.options.agents.join(',')+' --sdd openspec'+(prepared.plan.projectRules==='pending'?' --defer-research':'')+' --review'
      :'rigup update '+quoteShell(root)+' --apply '+applyId+' --sessions-ended'+(flags.resume?' --resume':'');
     reportOpenSpecPending(setup,resume,io.write,services.report);
     return 3;
    }
   }
   const report=await apply(applyId,{cacheRoot,stateRoot:services.stateRoot,recover:flags.resume,signal:services.signal,runChecks:services.runChecks});
   services.report?.({phase:'apply',installStatus:report.status,...report});
   if(report.nextCommand)io.write('工作流已可用。重开 agent 后用 change-prepare 发起提案。可选的项目规则生成命令：'+report.nextCommand+'\n');
   io.write('Install '+report.status+'\n');
   return report.exitCode;
  }catch(e){io.write(errorMessage(e)+'\n');return 1;}
 }
 let options:SetupOptions;
 let draftPath:string|undefined;
 try {
  let hasProjectConfig=true;try{await readFile(join(root,'.rigup/config.yaml'));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')hasProjectConfig=false;else throw e;}
  const approvedOptions=manifest?.projectRules==='pending'&&!flags.configure&&!overrides.profile?manifest.options:undefined;
  options=await loadOptions(root,!approvedOptions&&!hasProjectConfig&&manifest?{...(manifest.options??{agents:[]}),...overrides}:overrides,approvedOptions);
  if(values['--tools']){const ids=values['--tools'].split(',');if(ids.includes('none')&&ids.length!==1)throw Error('tools: none cannot be combined with a tool');if(ids[0]==='none')delete options.tools;else options.tools=[...new Set(ids)].map(id=>({id:id as 'openwiki'|'codegraph',install:true,initialize:id==='codegraph',agents:[...options.agents]}));}
  if(values['--continue']){if(Object.keys(overrides).length||['--tools','--model','--api-key-env','--review','--dry-run','--configure','--retire','--run-checks'].some(k=>values[k]))throw new Error('continuation cannot change explicit selections or execution mode');const continuation=await loadContinuation(root,values['--continue'],io.services);options=continuation.options;Object.assign(flags,{...continuation.flags,response:flags.response,sessionsEnded:flags.sessionsEnded,resume:flags.resume});}
  if(values['--model']||values['--api-key-env']){if(values['--backend']==='codex')throw Error('model/API-key flags select the Anthropic native backend; Codex model overrides are not supported');if(!values['--backend'])options.backend='native';const model=values['--model']??options.model?.model??process.env.ANTHROPIC_MODEL;const apiKeyEnv=values['--api-key-env']??options.model?.apiKeyEnv??'ANTHROPIC_API_KEY';if(!/^[A-Z_][A-Z0-9_]*$/.test(apiKeyEnv))throw new Error('model.apiKeyEnv: environment reference required');if(!model&&!(io.isTTY&&io.read))throw new Error('model.model: required when changing the API-key reference');if(model)options.model={provider:'anthropic',model,apiKeyEnv};}
  if(values['--sdd']==='none')delete options.sdd;
  if((flags.request||flags.response)&&options.backend!=='host')throw new Error('request/response: select the host backend');
  const firstWorkflow=command==='init'&&!flags.dryRun&&!flags.request&&!flags.response&&!flags.continuation&&!flags.researchTokens;
  const inlineReview=!flags.review&&options.executionPolicy?.mode!=='review';
  if(!flags.dryRun&&(flags.deferResearch||manifest?.projectRules==='pending'||options.executionPolicy?.mode==='review')){flags.review=true;flags.yes=false;}
  validateOptions(options as unknown as Record<string,unknown>);
  if(values['--prepare-openspec']){
   if(options.sdd!=='openspec'||!options.agents.length)throw Error('--prepare-openspec requires --sdd openspec and at least one agent');
   let setup=await inspectOpenSpec(root,options,services.signal);
   if(setup.requirements.length&&setup.canPrepare){
    if(await sessionHandoffRequired(root,flags.sessionsEnded))io.write('End affected sessions before preparing native OpenSpec files.\n');
    else try{setup=await prepareOpenSpec(root,options,setup,{stateRoot:services.stateRoot,signal:services.signal,recover:flags.resume,write:io.write});}
    catch{
     if(services.signal?.aborted)return 130;
     io.write('OpenSpec setup did not finish. Inspect the remaining prerequisites and retry.\n');
     setup=await inspectOpenSpec(root,options,services.signal);
    }
   }
   if(services.signal?.aborted)return 130;
   if(setup.requirements.length){
    for(const requirement of setup.requirements)io.write('OpenSpec: '+requirement+'\n');
    reportOpenSpecPending(setup,openspecPreparationCommand(root,options.agents),io.write,services.report);
    return 3;
   }
   services.report?.({phase:'preflight',installStatus:'not-installed',nativeWorkflow:'ready'});
   io.write('OpenSpec CLI and project entries are ready.\n');
   return 0;
  }
  const offerSetupScope=command==='init'&&!manifest&&!flags.deferResearch&&!flags.dryRun&&!flags.resume&&!flags.researchTokens&&!flags.request&&!flags.response;
  const guided=io.isTTY&&!!io.read&&!values['--continue'];
  let resumed=false,setupExit=130;
  if(firstWorkflow&&guided){
   const state=await privateDirectory(services.stateRoot??defaultStateRoot(),root);
   draftPath=join(state,'init-'+signature(root)+'.json');
   if(!values['--agents']&&!values['--sdd']&&!flags.configure&&!hasProjectConfig&&!options.profile){
    const draft=await readDurableRecord<{root:string;agents:SetupOptions['agents']}>(draftPath,'OpenSpec setup choices',value=>
     value.root===root&&Array.isArray(value.agents)&&value.agents.length>0&&value.agents.every(agent=>['codex','claude','opencode','omp'].includes(agent)));
    if(draft){
     options={...options,agents:draft.agents,sdd:'openspec'};
     resumed=true;
     io.write('继续已选的 OpenSpec 设置（'+draft.agents.join(', ')+'）\n');
    }
   }
  }
  const checkWorkflow=async(selected:SetupOptions):Promise<'ready'|'back'|'stop'>=>{
   if(selected.sdd!=='openspec'||!selected.agents.length)return 'ready';
   let setup=await inspectOpenSpec(root,selected,services.signal);
   if(services.signal?.aborted)return 'stop';
   if(!setup.requirements.length)return 'ready';
   if(draftPath)await saveDurable(draftPath,JSON.stringify({root,agents:selected.agents}));
   for(const requirement of setup.requirements)io.write('OpenSpec: '+requirement+'\n');
   if(setup.canPrepare&&guided&&inlineReview&&!await sessionHandoffRequired(root,flags.sessionsEnded)){
    if(!setup.cli)io.write('将 OpenSpec '+setup.recipe.version+' 安装到 '+setup.prefix+'\n');
    if(setup.needsProject)io.write('补齐当前项目缺失的原生 OpenSpec 文件\n');
    io.write('补齐 OpenSpec（Enter: 自动补齐，b 返回）\n');
    const answer=await promptChoice({write:io.write,read:io.read!},['自动补齐','手动准备后继续'],false,['自动补齐']);
    if(answer===null)return 'stop';
    if(answer==='back'){
     if(draftPath)await rm(draftPath,{force:true});
     return 'back';
    }
    if(Array.isArray(answer)&&answer.length===1&&answer[0]==='自动补齐'){
     try{setup=await prepareOpenSpec(root,selected,setup,{stateRoot:services.stateRoot,signal:services.signal,recover:flags.resume,write:io.write});}
     catch{
      if(services.signal?.aborted)return 'stop';
      io.write('自动补齐未完成。可以重新运行 rigup init 重试，或执行下面的准备命令。\n');
      setup=await inspectOpenSpec(root,selected,services.signal);
     }
     if(!setup.requirements.length)return 'ready';
    }
   }
   const originalFlags=Object.entries(values).filter(([flag])=>flag!=='--agents'&&flag!=='--sdd').flatMap(([flag,value])=>boolean.has(flag)?[flag]:[flag,quoteShell(value)]);
   const resumeCommand=['rigup','init',quoteShell(root),'--agents',selected.agents.join(','),'--sdd','openspec',...originalFlags].join(' ');
   reportOpenSpecPending(setup,resumeCommand,io.write,services.report);
   setupExit=3;
   return 'stop';
  };
  const promptSetup=(configure:boolean,knownBackend:boolean,provided?:Parameters<typeof onboard>[2]['provided'])=>onboard(options,{write:io.write,read:io.read!},{
   configure,deferResearch:flags.deferResearch,offerSetupScope,knownBackend,languageProvided:!!values['--language'],
   provided,apiKeyEnv:values['--api-key-env'],credentials:services.credentials,checkWorkflow:firstWorkflow?checkWorkflow:undefined
  });
  if(guided){
   const provided=!hasProjectConfig&&!manifest&&!options.profile?{agents:resumed||!!values['--agents'],sdd:resumed||!!values['--sdd'],tools:!!values['--tools'],model:!!values['--model']||!!values['--api-key-env']}:undefined;
   const setup=await promptSetup(!!flags.configure,!!approvedOptions||hasProjectConfig||!!overrides.backend||!!options.profile||!!values['--model']||!!values['--api-key-env'],provided);
   if(!setup)return setupExit;
   options=setup.options;
   services.credentials=setup.credentials;
   if(setup.deferResearch){flags.deferResearch=true;flags.review=true;flags.yes=false;}
  }else if(firstWorkflow&&(flags.deferResearch||options.backend!=='host')&&await checkWorkflow(options)==='stop')return setupExit;
  while(!flags.dryRun&&!flags.yes&&!flags.review&&io.isTTY&&io.read){
   const budget=researchBudget(options);
   io.write('本轮范围：agents='+options.agents.join(',')+'; SDD='+(options.sdd??'none')+'; tools='+(options.tools??[]).map(t=>t.id+(t.install?':pinned install':':registration')).join(',')+'; backend='+options.backend+'; 研究上限 '+budget.maxCalls+' requests / '+(flags.researchTokens??budget.maxTokens)+' tokens。仅预览内受保护写入；b 返回修改。\n');
   const mode=await promptChoice({write:io.write,read:io.read},['continuous','review','dry-run'],false,[options.executionPolicy?.mode??'continuous']);if(mode===null)return 130;
   if(mode==='back'){const setup=await promptSetup(true,true);if(!setup)return setupExit;options=setup.options;services.credentials=setup.credentials;if(setup.deferResearch){flags.deferResearch=true;flags.review=true;}continue;}
   if(!Array.isArray(mode)||mode.length!==1)return 2;flags.yes=mode[0]==='continuous';flags.review=mode[0]==='review';flags.dryRun=mode[0]==='dry-run';
  }
  if(flags.deferResearch&&!options.sdd)throw Error('--defer-research requires a selected development workflow');
  if(flags.researchTokens&&(!options.sdd||options.backend!=='codex'))throw Error('--research-tokens requires the Codex backend and a development workflow');
  if(flags.configure)options.executionPolicy={mode:flags.review?'review':'continuous'};
  validateOptions(options as unknown as Record<string,unknown>);
  if(guided&&firstWorkflow&&inlineReview&&flags.deferResearch&&options.sdd==='openspec')services.confirmPreview=async()=>{
   const choices=['应用预览并完成初始化','保存预览稍后应用'];
   io.write('请确认预览（Enter: 应用预览并完成初始化）\n');
   const answer=await promptChoice({write:io.write,read:io.read!},choices,false,[choices[0]]);
   return Array.isArray(answer)&&answer.length===1&&answer[0]===choices[0];
  };
 }catch(e){io.write(errorMessage(e)+'\n');return 2;}
 try{
  const code=await executeLifecycle(root,options,flags,io.write,{...services,isTTY:io.isTTY});
  if(code===0&&draftPath&&await loadManifest(root))await rm(draftPath,{force:true});
  return code;
 }catch(e){io.write(errorMessage(e)+'\n');return io.services?.signal?.aborted?130:1;}
}
export async function runCli(argv:string[],io:CliIO):Promise<number>{
 if(!argv.includes('--json'))return runCliInternal(argv,io);
 let actual:Record<string,unknown>={};let last='';const report=(value:Record<string,unknown>)=>{actual=value;io.services?.report?.(value);};
 const code=await runCliInternal(argv.filter(a=>a!=='--json'),{...io,isTTY:false,read:undefined,write:text=>{last=text;io.writeError?.(text);},services:{...io.services,report}});
 const result={phase:actual.phase??'preflight',installStatus:actual.installStatus??(code===0?'complete':code===3?'pending':'failed'),checks:[],pending:[],conflicts:[],requiredInput:[],nextCommand:null,...actual,exitCode:code,...((code===1||code===2)?{error:last.trim()}:{} )};io.write(JSON.stringify(result)+'\n');return code;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(await realpath(resolve(process.argv[1]))).href){
 const controller=new AbortController();process.once('SIGINT',()=>controller.abort());
 process.exitCode=await runCli(process.argv.slice(2),{cwd:process.cwd(),isTTY:!!process.stdin.isTTY,write:text=>process.stdout.write(text),writeError:text=>process.stderr.write(text),read:terminalReader(process.stdin),services:{signal:controller.signal}});
}
