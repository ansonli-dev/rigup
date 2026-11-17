#!/usr/bin/env node
import {inspectGlobalNpm} from './integrations/tools/global-npm.js';
import {toolPackage} from './integrations/tools/recipes.js';
import {readFile,realpath,rm} from 'node:fs/promises';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {homedir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {onboard,promptNativeCredentials,restrictBindings} from './onboarding.js';
import {detectCommands,detectSdd,detectToolInstallation} from './setup-detection.js';
import {askLine,terminalReader,type Ask} from './prompt.js';
import {loadOptions,validateOptions,type SetupOverrides} from './config.js';
import type {SetupOptions} from './types.js';
import {loadManifest} from './installer/baseline.js';
import {loadPreview} from './installer/preview.js';
import {apply,interruptedApplyOptions,interruptedInstallApplyId,interruptedSeedApplyId} from './installer/apply.js';
import {doctor} from './installer/doctor.js';
import {sessionHandoffRequired} from './installer/session.js';
import {defaultStateRoot} from './installer/lock.js';
import {executeLifecycle,loadContinuation,type LifecycleServices,type LifecycleFlags} from './lifecycle.js';
import {inspectOpenSpec,openSpecProjectScopes,OpenSpecReceiptError,planOpenSpecPreparation,preparationScope,prepareOpenSpec,reportOpenSpecPending,type OpenSpecPreparation} from './integrations/sdd/openspec-setup.js';
import {openspecPackage,openspecPreparationCommand,type OpenSpecInstallScope} from './integrations/sdd/openspec.js';
import {forwardProjectOpenSpec,readOpenSpecPreparation} from './integrations/sdd/openspec-project.js';
import {privateDirectory,signature} from './generator/cache.js';
import {readDurableRecord,saveDurable} from './private-record.js';
import {quoteShell,quoteShellList} from './shell-command.js';
import {LinkedRigupDirectoryError} from './installer/ownership.js';
import {promptResearchProvider,resolveResearchProvider} from './research/provider-settings.js';
import {runtimeEnvironment,runtimeSetupSummary,writeRuntimeSummary,type RuntimeSetupSummary} from './runtime-inputs.js';
import {applyReason,createCliOutput,terminalText} from './cli-output.js';
import {supportedHost} from './integrations/host-setup/manual.js';
import {nativeSetupInteraction} from './integrations/host-setup/index.js';
import {terminalUI,type TerminalStreams} from './terminal-ui.js';
export interface CliIO {cwd:string;isTTY:boolean;outputIsTTY?:boolean;write(text:string):void;writeError?(text:string):void;read?(secret?:boolean):Promise<string|null>;ask?:Ask;terminal?:TerminalStreams;services?:LifecycleServices}
const errorMessage=(error:unknown)=>error instanceof SyntaxError?'input/cache: invalid JSON syntax; inspect the local file without exporting its contents':error instanceof Error?error.message:'operation failed';
const help='rigup                         Open the interactive project menu (TTY)\nrigup init [path] [--agents claude,codex,opencode,omp] [--sdd superpowers|openspec|spec-kit|none] [--tools openwiki,codegraph|none] [--defer-research]\nrigup update [path] [--configure] [--dry-run|--review] [--apply previewId] [--sessions-ended] [--resume]\nrigup doctor [path] [--check-host claude] [--run-checks build,lint,test,environment,eval]\nrigup mcp [path] --host claude|codex|opencode|omp\nOptions: --profile path --language auto|language-tag --model modelId --json --verbose\nNative Superpowers: rigup init [path] --agents claude,omp --sdd superpowers --prepare-native [--review|--dry-run]\nAdvanced: --retire logicalId,... --prepare-openspec [--install-scope project|global]\nrigup openspec <args>          Run the verified project OpenSpec CLI\nChoose a CLI provider with RIGUP_PROVIDER and its model and API-key environment variables. Without a provider, use Rigup MCP from the installed agent.\nOmit path to use the current directory. A TTY previews changes before Install, Save preview, or Cancel. Use --verbose for preview details. --json never prompts.\n';
const listOptions:Record<string,RegExp>={
 '--agents':/^(?:claude|codex|opencode|omp)$/,
 '--tools':/^(?:openwiki|codegraph|none)$/,
 '--run-checks':/^(?:build|lint|test|environment|eval)$/,
 '--retire':/^[^,\s]+$/,
};
const splitList=(value:string)=>value.split(',').flatMap(part=>part.trim().split(/\s+/));

async function runCliInternal(argv:string[],io:CliIO,display:ReturnType<typeof createCliOutput>):Promise<number>{
 const {state,presentation}=display;
 const promptWrite=io.isTTY&&io.outputIsTTY===false?io.writeError??io.write:io.write;
 const promptIO={write:promptWrite,read:io.read??(async()=>null)};
 const ask:Ask=io.ask??(question=>askLine(promptIO,question));
 const services:LifecycleServices={...io.services};
 const flags:LifecycleFlags={};const overrides:SetupOverrides={};const positional:string[]=[];let applyId:string|undefined;
 const boolean=new Set(['--dry-run','--configure','--review','--sessions-ended','--resume','--defer-research','--prepare-openspec','--prepare-native']);const valued=new Set(['--sdd','--backend','--profile','--language','--response','--request','--apply','--model','--api-key-env','--continue','--research-tokens','--check-host','--install-scope']);const values:Record<string,string>={};
 for(let i=0;i<argv.length;i++){
  const arg=argv[i];
  const equal=arg.indexOf('=');
  const flag=equal<0?arg:arg.slice(0,equal);
  if(Object.hasOwn(listOptions,flag)){
   const accepts=listOptions[flag];
   const raw=equal<0?argv[i+1]:arg.slice(equal+1);
   const list=raw&&!raw.startsWith('-')?splitList(raw):[];
   if(!list.length||list.some(value=>!accepts.test(value))){
    io.write(flag+': provide supported comma-separated values, repeat the option, or separate values with spaces. In PowerShell, use quotes around comma-separated values.\n');
    return 2;
   }
   if(equal<0)i++;
   // Retirement IDs may be arbitrary. Only consume adjacent IDs with the
   // standard namespace form, so a positional project path still works.
   const adjacent=flag==='--retire'?/^[\w-]+:[^,\s]+$/:accepts;
   while(argv[i+1]&&!argv[i+1].startsWith('-')&&!isAbsolute(argv[i+1])&&splitList(argv[i+1]).every(value=>adjacent.test(value))){
    list.push(...splitList(argv[++i]));
   }
   values[flag]=[...new Set([...(values[flag]?.split(',')??[]),...list])].join(',');
   continue;
  }
  if(boolean.has(arg)){values[arg]='true';continue;}if(valued.has(arg)){if(!argv[i+1]||argv[i+1].startsWith('--')){io.write(arg+': value required\n');return 2;}values[arg]=argv[++i];continue;}
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
 try{manifest=await loadManifest(root);}catch(error){io.write((error instanceof LinkedRigupDirectoryError?error.message:'manifest: damaged metadata; diagnose before setup')+'\n');return 1;}
 let command=positional[0];
 if(!command){const a=await ask({message:'Rigup',choices:[manifest?'update':'init','doctor','exit']});if(!Array.isArray(a)||a[0]==='exit')return 130;command=a[0];}
 const nativeTTY=io.isTTY===true&&(io.outputIsTTY??io.terminal?.output.isTTY)===true;
 const nativeInput={...services.nativeSetup,stateRoot:services.nativeSetup?.stateRoot??services.stateRoot,signal:services.signal};
 if(values['--prepare-native']){
  if(positional[0]!=='init'||!values['--agents']||values['--sdd']!=='superpowers'||
     Object.keys(values).some(flag=>!['--agents','--sdd','--prepare-native','--review','--dry-run'].includes(flag))||
     values['--review']&&values['--dry-run']){
   io.write('--prepare-native: use init with explicit --agents and --sdd superpowers, with at most one of --review and --dry-run.\n');
   return 2;
  }
  state.root=root;
  try{
   const selected=await loadOptions(root,{agents:values['--agents'].split(',') as SetupOptions['agents'],sdd:'superpowers'},
    undefined,{fallback:manifest?.options});
   const result=await nativeSetupInteraction(root,selected.agents,nativeInput,{write:io.write,report:services.report,
    ask,inspect:!!(values['--review']||values['--dry-run']),canPrompt:nativeTTY&&selected.executionPolicy?.mode!=='review'});
   return result==='back'?130:result;
  }catch(error){io.write(errorMessage(error)+'\n');return services.signal?.aborted?130:1;}
 }
 if(values['--defer-research']){
  if(command!=='init'||manifest||['--apply','--continue','--request','--response','--retire'].some(arg=>values[arg])){
   io.write('--defer-research: use with initial project setup\n');return 2;
  }
  flags.deferResearch=true;
 }
 if(command==='init'&&manifest)command='update';
 io.write(command+': '+terminalText(root)+'\n');
 if(values['--prepare-openspec']&&(command==='doctor'||['--apply','--dry-run','--review','--continue','--request','--response','--research-tokens'].some(flag=>values[flag]))){
  io.write('--prepare-openspec is a separate native setup step for init or update\n');
  return 2;
 }
 if(values['--install-scope']&&(!values['--prepare-openspec']||!['project','global'].includes(values['--install-scope']))){io.write('--install-scope requires --prepare-openspec and project or global\n');return 2;}
 if(values['--check-host']&&(command!=='doctor'||values['--check-host']!=='claude')){io.write('--check-host claude is supported with doctor only\n');return 2;}
 if(command==='doctor'){if(values['--research-tokens']){io.write('--research-tokens applies to Codex research only\n');return 2;}try{const runChecks=values['--run-checks']?.split(',');if(runChecks?.some(k=>!['build','lint','test','environment','eval'].includes(k))){io.write('run-checks: existing check kinds required\n');return 2;}const report=await doctor(root,{checkHost:values['--check-host']?'claude':undefined,runChecks:runChecks as import('./types.js').CheckKind[],stateRoot:io.services?.stateRoot,signal:io.services?.signal});io.services?.report?.({phase:'doctor',installStatus:report.nextCommand?'pending':'not-applicable',...report});if(report.nextCommand)io.write(report.nextCommand+'\n');for(const d of report.diagnostics)io.write(d.category+' '+d.id+': '+d.state+' — '+d.reason+'\n');for(const c of report.checks)io.write('check '+c.name+': '+c.status+' '+(c.startedAt??'')+' '+(c.commit??'')+'\n');return report.exitCode;}catch(e){io.write(errorMessage(e)+'\n');return 1;}}
 state.root=root;
 if(values['--agents'])overrides.agents=values['--agents'].split(',') as SetupOptions['agents'];
 if(values['--sdd'])overrides.sdd=values['--sdd'] as SetupOverrides['sdd'];
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
  if(values['--model']){io.write('--model: prepare a new preview to change the research model\n');return 2;}
  if(Object.keys(values).some(flag=>!['--apply','--sessions-ended','--resume','--run-checks','--verbose'].includes(flag))){
   io.write('--apply uses the saved selections. Prepare a new preview to change options or execution mode.\n');return 2;
  }
  try{
   const cacheRoot=join(services.cacheRoot??join(homedir(),'.cache','rigup'),'previews');
   const prepared=await loadPreview(applyId,cacheRoot);
   if(prepared.plan.root!==root)throw new Error('preview project root differs from requested path');
   state.data=prepared;
   if(!prepared.preview.executable)throw new Error('preview is blocked; prepare a new preview');
   if(flags.runChecks&&JSON.stringify([...flags.runChecks].sort())!==JSON.stringify([...(prepared.plan.runChecks??[])].sort()))throw new Error('apply checks differ from approved preview; prepare a new preview with --run-checks');
   if(await sessionHandoffRequired(root,flags.sessionsEnded)){
    const nextCommand='rigup update '+quoteShell(root)+' --apply '+applyId+' --sessions-ended'+(flags.resume?' --resume':'');
    const message='End affected sessions and apply from an independent terminal.';
    services.report?.({phase:'handoff',installStatus:'pending',...prepared.preview,pending:[message],nextCommand});
    return 3;
   }
   if(!manifest&&prepared.plan.options.sdd==='openspec'){
    const setup=await inspectOpenSpec(root,prepared.plan.options,services.signal,undefined,{stateRoot:services.stateRoot,scope:'project'});
    if(services.signal?.aborted)return 130;
    if(setup.requirements.length){
     for(const requirement of setup.requirements)io.write('OpenSpec: '+requirement+'\n');
     const resume=setup.needsProject
      ?'rigup init '+quoteShell(root)+' --agents '+quoteShellList(prepared.plan.options.agents)+' --sdd openspec'+(prepared.plan.projectRules==='pending'?' --defer-research':'')+' --review'
      :'rigup update '+quoteShell(root)+' --apply '+applyId+' --sessions-ended'+(flags.resume?' --resume':'');
     reportOpenSpecPending(setup,resume,presentation.notice,services.report);
     return 3;
    }
   }
   presentation.progress({stage:'apply',completed:0});
   presentation.applying(applyId);
   const report=await apply(applyId,{cacheRoot,stateRoot:services.stateRoot,recover:flags.resume,signal:services.signal,runChecks:services.runChecks});
   services.report?.({phase:'apply',installStatus:report.status,...report});
   return report.exitCode;
  }catch(e){state.error=errorMessage(e);return services.signal?.aborted?130:1;}
 }
 const resumeApply=flags.resume&&!flags.request&&!flags.response&&!flags.researchTokens&&!values['--prepare-openspec']&&!values['--continue'];
 let savedApplyOptions:SetupOptions|undefined;
 try{
  if(resumeApply)savedApplyOptions=await interruptedApplyOptions(root,services.stateRoot);
  else{
   const seedApply=await interruptedSeedApplyId(root,services.stateRoot);
   const interruptedPreviewId=seedApply??await interruptedInstallApplyId(root,services.stateRoot);
   if(interruptedPreviewId){
    const nextCommand='rigup update '+quoteShell(root)+' --resume --review';
    const message=seedApply?'Reconcile the interrupted customer document creation using the original approval.':'Resume the interrupted tool installation using the original approval.';
    services.report?.({phase:'preflight',installStatus:'pending',reason:'interrupted-install',interruptedPreviewId,pending:[message],nextCommand});
    return 3;
   }
  }
 }
 catch(error){io.write(errorMessage(error)+'\n');return 1;}
 let options:SetupOptions;
 let draftPath:string|undefined;
 try {
  let hasProjectConfig=true;try{await readFile(join(root,'.rigup/config.yaml'));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')hasProjectConfig=false;else throw e;}
  if(resumeApply&&command==='update'&&!savedApplyOptions&&!manifest&&!hasProjectConfig&&Object.keys(values).every(flag=>['--resume','--review','--dry-run','--sessions-ended'].includes(flag))){
   const nextCommand='rigup init '+quoteShell(root)+' --review';
   presentation.notice('No saved installation selection.');
   services.report?.({phase:'preflight',installStatus:'not-installed',nextCommand});
   return 3;
  }
  if(savedApplyOptions&&(flags.configure||flags.runChecks||flags.retireIds||overrides.profile))throw Error('Interrupted installation retains its approved plan. Finish it before changing the selection or checks.');
  const approvedOptions=savedApplyOptions??(manifest?.projectRules==='pending'&&!manifest.options?.projectRules&&!flags.configure&&!overrides.profile?manifest.options:undefined);
  const legacyResearch=['--backend','--api-key-env','--request','--response','--continue','--research-tokens'].some(flag=>values[flag]);
  const newSetup=!manifest&&!legacyResearch&&(!flags.resume||flags.deferResearch||!!values['--model']||!!process.env.RIGUP_PROVIDER);
  const managedConfig=manifest?.assets.some(asset=>asset.logicalId==='rigup:configuration');
  const useInstalledDefaults=manifest&&(!hasProjectConfig||manifest.options?.projectRules&&!managedConfig);
  const fallback=manifest&&useInstalledDefaults?(manifest.options??{agents:[],backend:'host' as const}):undefined;
  let configured={agents:false,sdd:false};
  options=await loadOptions(root,overrides,approvedOptions,{projectRules:newSetup||manifest?.options?.backend==='host'&&manifest.options.projectRules!==undefined,fallback,onSelections:value=>{configured=value;}});
  if(manifest&&flags.configure&&!legacyResearch&&!savedApplyOptions&&options.projectRules===undefined)options.projectRules=true;
  const modernResearch=options.projectRules===true&&!legacyResearch&&!savedApplyOptions;
  const configuredTools=new Map(options.tools?.map(tool=>[tool.id,tool]));
  if(values['--tools']){
   const ids=values['--tools'].split(',');
   if(ids.includes('none')&&ids.length!==1)throw Error('tools: none cannot be combined with a tool');
   if(ids[0]==='none'){if(flags.configure||options.tools)options.tools=[];}
   else options.tools=ids.map(raw=>{
    const id=raw as 'openwiki'|'codegraph';
    return configuredTools.get(id)??{id,install:true,initialize:id==='codegraph',agents:[...options.agents]};
   });
  }
  if(values['--continue']){if(Object.keys(overrides).length||['--tools','--model','--api-key-env','--review','--dry-run','--configure','--retire','--run-checks'].some(k=>values[k]))throw new Error('continuation cannot change explicit selections or execution mode');const continuation=await loadContinuation(root,values['--continue'],io.services);options=continuation.options;Object.assign(flags,{...continuation.flags,response:flags.response,sessionsEnded:flags.sessionsEnded,resume:flags.resume});}
  if(!modernResearch&&(values['--model']||values['--api-key-env'])){if(values['--backend']==='codex')throw Error('model/API-key flags select the native backend; Codex model overrides are not supported');if(!values['--backend'])options.backend='native';const model=values['--model']??options.model?.model??process.env.ANTHROPIC_MODEL;const apiKeyEnv=values['--api-key-env']??options.model?.apiKeyEnv??'ANTHROPIC_API_KEY';if(!/^[A-Z_][A-Z0-9_]*$/.test(apiKeyEnv))throw new Error('model.apiKeyEnv: environment reference required');if(!model&&!(io.isTTY&&io.read))throw new Error('model.model: required when changing the API-key reference');if(model)options.model={provider:options.model?.provider??'anthropic',model,apiKeyEnv};}
  if((flags.request||flags.response)&&options.backend!=='host')throw new Error('request/response: select the host backend');
  const firstWorkflow=!savedApplyOptions&&command==='init'&&!flags.dryRun&&!flags.request&&!flags.response&&!flags.continuation&&!flags.researchTokens;
  const interactive=io.isTTY&&!values['--continue'];
  const guided=interactive&&!savedApplyOptions;
  const wizard=guided&&(flags.configure||command==='init'&&!flags.resume);
  const explicitResearch=!!values['--model']||legacyResearch;
  const inlineReview=!flags.review&&options.executionPolicy?.mode!=='review';
  if(!flags.dryRun&&(flags.deferResearch&&!guided||manifest?.projectRules==='pending'||options.executionPolicy?.mode==='review')){flags.review=true;flags.yes=false;}
  validateOptions(options as unknown as Record<string,unknown>);
  let runtimeSetup:RuntimeSetupSummary|undefined;
  const report=services.report;
  let nativePreparation:Record<string,unknown>|undefined;
  services.report=value=>report?.({...(runtimeSetup?{runtimeSetup}:{}),...(nativePreparation?{nativePreparation}:{}),...value});
  const nativeDeps={stateRoot:services.stateRoot,signal:services.signal,recover:flags.resume,write:io.write,view:services.npmView};
  const prepareApproved=async(selected:SetupOptions,approval:OpenSpecPreparation)=>{
   state.native=approval.kind!=='existing'?{version:approval.install.version,prefix:approval.prefix}:{version:approval.cliVersion};
   const setup=await prepareOpenSpec(root,selected,approval,{...nativeDeps,onInstalled:()=>{
    state.native={...state.native,installed:true};
   }});
   state.native={...state.native,version:setup.cliVersion??state.native.version,ready:!setup.requirements.length};
   return setup;
  };
  const describePreparation=(approval:OpenSpecPreparation)=>{
   const {kind,needsRoot,needsEntries,agents}=approval;
   nativePreparation={kind,needsRoot,needsEntries,agents,...(kind!=='existing'?{name:openspecPackage,version:approval.install.version,registry:approval.install.registry,prefix:approval.prefix,...(kind==='project-install'||values['--install-scope']?{packageIntegrity:approval.install.packageIntegrity}:{} )}:{version:approval.cliVersion})};
   if(kind!=='existing')io.write('将 '+openspecPackage+'@'+approval.install.version+' 从 '+approval.install.registry+' 安装到 '+terminalText(approval.prefix)+'\n'+approval.install.packageIntegrity+'\n');
   else io.write('OpenSpec CLI '+approval.cliVersion+'\n');
   if(needsRoot||needsEntries.length)io.write('补齐当前项目缺失的原生 OpenSpec 文件（'+openSpecProjectScopes(approval).join(', ')+'）\n');
  };
  const failedPreparation=(error:unknown,selected:SetupOptions,scope:OpenSpecInstallScope='project')=>{
   if(state.native&&error instanceof OpenSpecReceiptError){
    state.native.installed=true;state.native.receiptFailed=true;
   }
   if(services.signal?.aborted)return 130;
   const message=errorMessage(error);
   state.error=message;
   services.report?.({phase:'preflight',installStatus:state.native?.installed?'partial':'failed',error:message,pending:[message],
    ...(state.native?{nextCommand:openspecPreparationCommand(root,selected.agents,scope)+' --resume'}:{})});
   return 1;
  };
  if(values['--prepare-openspec']){
   runtimeSetup=await runtimeSetupSummary(root,options);
   if(options.sdd!=='openspec'||!options.agents.length)throw Error('--prepare-openspec requires --sdd openspec and at least one agent');
   const saved=await readOpenSpecPreparation(root,nativeDeps.stateRoot);
   const ongoing=saved&&!saved.complete?saved:undefined;
   const originalScope=ongoing?preparationScope(ongoing.approval):undefined;
   const requested=values['--install-scope'] as OpenSpecInstallScope|undefined;
   if(ongoing&&originalScope&&(!flags.resume||requested&&requested!==originalScope)){
    const nextCommand=openspecPreparationCommand(root,ongoing.approval.agents,originalScope)+' --resume'+(flags.sessionsEnded?' --sessions-ended':'');
    const message='Resume the original OpenSpec preparation with its approved scope.';
    services.report?.({phase:'preflight',installStatus:'pending',executable:false,pending:[message],nextCommand});io.write(message+'\n'+nextCommand+'\n');return 3;
   }
   const scope=originalScope??requested??'global';
   let setup=await inspectOpenSpec(root,options,services.signal,undefined,{scope,stateRoot:nativeDeps.stateRoot});
   if(ongoing||setup.requirements.length&&setup.canPrepare){
    if(await sessionHandoffRequired(root,flags.sessionsEnded)){
     const message='End affected sessions, then acknowledge with --sessions-ended from an independent terminal.';
     const command=openspecPreparationCommand(root,options.agents,scope)+' --sessions-ended'+(flags.resume?' --resume':'');
     services.report?.({phase:'preflight',installStatus:'pending',executable:false,pending:setup.requirements,requiredInput:[message],nextCommand:command,resumeCommand:command});
     io.write(message+'\n'+command+'\n');
     return 3;
    }
    try{
     const planned=ongoing?{inspection:setup,approval:ongoing.approval}:await planOpenSpecPreparation(root,options,nativeDeps,setup);setup=planned.inspection;
     if(planned.approval){describePreparation(planned.approval);setup=await prepareApproved(options,planned.approval);}
    }catch(error){return failedPreparation(error,options,scope);}
   }
   if(services.signal?.aborted)return 130;
   if(setup.requirements.length){
    for(const requirement of setup.requirements)io.write('OpenSpec: '+requirement+'\n');
    reportOpenSpecPending(setup,openspecPreparationCommand(root,options.agents,scope),presentation.notice,services.report);
    return 3;
   }
   services.report?.({phase:'preflight',installStatus:'not-installed',nativeWorkflow:'ready'});
   return 0;
  }
  let resumed=false,setupExit=130,selectedOpenSpecScope:OpenSpecInstallScope|undefined;
  if(firstWorkflow&&guided){
   const state=await privateDirectory(services.stateRoot??defaultStateRoot(),root);
   draftPath=join(state,'init-'+signature(root)+'.json');
   if(!values['--agents']&&!values['--sdd']&&!flags.configure&&!hasProjectConfig&&!options.profile){
    const draft=await readDurableRecord<{root:string;agents:SetupOptions['agents'];scope?:OpenSpecInstallScope}>(draftPath,'OpenSpec setup choices',value=>
     value.root===root&&Array.isArray(value.agents)&&value.agents.length>0&&value.agents.every(agent=>['codex','claude','opencode','omp'].includes(agent)));
    if(draft){
     options={...options,agents:draft.agents,sdd:'openspec'};
     resumed=true;
     if(draft.scope==='project'||draft.scope==='global')selectedOpenSpecScope=draft.scope;
     io.write('继续已选的 OpenSpec 设置（'+draft.agents.join(', ')+'）\n');
    }
   }
  }
  const checkWorkflow=async(selected:SetupOptions,back=false):Promise<'ready'|'back'|'stop'>=>{
   if(selected.sdd==='superpowers'&&selected.agents.some(supportedHost)&&firstWorkflow&&wizard&&inlineReview&&!flags.review&&!flags.dryRun&&nativeTTY){
    const result=await nativeSetupInteraction(root,selected.agents,nativeInput,{write:io.write,report:value=>{
     nativePreparation=value.nativePreparation as Record<string,unknown>;
     if(value.installStatus!=='complete'&&value.installStatus!=='up-to-date')services.report?.(value);
    },ask,inspect:false,canPrompt:true,back});
    if(result==='back'){nativePreparation=undefined;return 'back';}
    if(result===0)return 'ready';
    setupExit=result;return 'stop';
   }
   if(selected.sdd!=='openspec'||!selected.agents.length)return 'ready';
   const nativeState=await readOpenSpecPreparation(root,nativeDeps.stateRoot);
   if(nativeState&&!nativeState.complete){
    const scope=preparationScope(nativeState.approval);
    const nextCommand=openspecPreparationCommand(root,nativeState.approval.agents,scope)+' --resume';
    const message='Resume the original OpenSpec preparation.';
    services.report?.({phase:'preflight',installStatus:'pending',executable:false,pending:[message],nextCommand});
    io.write(message+'\n'+nextCommand+'\n');setupExit=3;return 'stop';
   }
   let scope=selectedOpenSpecScope??'project';
   const inspect=()=>inspectOpenSpec(root,selected,services.signal,undefined,{scope,stateRoot:nativeDeps.stateRoot});
   let setup=await inspect();
   if(services.signal?.aborted)return 'stop';
   if(!setup.requirements.length)return 'ready';
   if(!setup.cli&&!selectedOpenSpecScope&&(setup.projectAvailable||setup.globalAvailable)){
    const project='当前项目 · .rigup/tools/openspec/',global='全局 · '+terminalText(setup.prefix??'当前用户的 npm 全局前缀');
    const choices=[...(setup.projectAvailable?[project]:[]),...(setup.globalAvailable?[global]:[])];
    if(guided){
     const selection=await ask({message:'OpenSpec 安装到哪里？',choices,defaults:[choices[0]],back});
     if(selection===null)return 'stop';
     if(selection==='back')return 'back';
     scope=selection[0]===global?'global':'project';
    }else if(!setup.projectAvailable)scope='global';
    selectedOpenSpecScope=scope;
    if(setup.scope!==scope)setup=await inspect();
   }
   for(const requirement of setup.requirements)io.write('OpenSpec: '+requirement+'\n');
   if(setup.canPrepare&&guided&&inlineReview&&!await sessionHandoffRequired(root,flags.sessionsEnded)){
    try{
     const planned=await planOpenSpecPreparation(root,selected,nativeDeps,setup);
     for(const requirement of planned.inspection.requirements.slice(setup.requirements.length))io.write('OpenSpec: '+requirement+'\n');
     setup=planned.inspection;
     if(planned.approval){
      describePreparation(planned.approval);
      const answer=await ask({message:'补齐 OpenSpec',choices:['自动补齐','手动准备后继续'],defaults:['自动补齐'],back});
      if(answer===null)return 'stop';
      if(answer==='back'){
       nativePreparation=undefined;selectedOpenSpecScope=undefined;
       if(draftPath)await rm(draftPath,{force:true});
       return 'back';
      }
      if(Array.isArray(answer)&&answer.length===1&&answer[0]==='自动补齐'){
       setup=await prepareApproved(selected,planned.approval);
       if(!setup.requirements.length)return 'ready';
      }
     }
    }catch(error){setupExit=failedPreparation(error,selected,scope);return 'stop';}
   }
   const originalFlags=Object.entries(values).filter(([flag])=>flag!=='--agents'&&flag!=='--sdd').flatMap(([flag,value])=>boolean.has(flag)?[flag]:[flag,quoteShell(value)]);
   if(draftPath)await saveDurable(draftPath,JSON.stringify({root,agents:selected.agents,scope}));
   const resumeCommand=['rigup',command,quoteShell(root),'--agents',quoteShellList(selected.agents),'--sdd','openspec',...originalFlags].join(' ');
   reportOpenSpecPending(setup,resumeCommand,presentation.notice,services.report);
   setupExit=3;
   return 'stop';
  };
  const checkSelectedWorkflow=firstWorkflow||!flags.dryRun&&!savedApplyOptions&&command==='update'&&
   !flags.request&&!flags.response&&!flags.continuation&&(flags.configure||!!values['--sdd']);
  if(wizard){
   const provided={agents:resumed||!!values['--agents'],sdd:resumed||!!values['--sdd'],tools:!!values['--tools']};
   presentation.progress({stage:'detect',completed:0});
   const detected=await detectCommands(root);
   presentation.progress({stage:'detect',completed:1,status:'complete'});
   if(!provided.agents&&detected.agents.length)io.write('Detected agents on PATH: '+detected.agents.join(', ')+'\n');
   if(!provided.agents&&!configured.agents&&detected.agents.length)options.agents=detected.agents;
   const setup=await onboard(options,promptIO,{configure:!!flags.configure,provided,ask,checkWorkflow:checkSelectedWorkflow?checkWorkflow:undefined,
    recommendSdd:configured.sdd?undefined:selected=>detectSdd(root,selected,io.write)});
   if(!setup)return setupExit;
   options=setup;
  }else{
   if(flags.configure||values['--agents']||values['--tools'])restrictBindings(options,!!values['--tools']);
   if(checkSelectedWorkflow&&(command==='update'||modernResearch||flags.deferResearch||options.backend!=='host')&&await checkWorkflow(options)==='stop')return setupExit;
  }
  if(options.tools&&!savedApplyOptions&&!flags.continuation){
   const choices:NonNullable<SetupOptions['tools']>=[];
   for(const tool of options.tools){
    const prior=configuredTools.get(tool.id);
    if(prior&&!(flags.configure&&values['--tools']&&!prior.install)){
     const agents=values['--agents']&&values['--tools']?tool.agents:prior.agents.filter(agent=>options.agents.includes(agent));
     if(agents.length)choices.push({...tool,agents});
     continue;
    }
    const detected=await detectToolInstallation(root,tool.id,manifest?.installedTools?.[tool.id],services.stateRoot);
    if(detected.state==='project')io.write(tool.id+': reuse project installation '+detected.version+'\n');
    if(detected.state==='available')io.write(tool.id+': reuse existing PATH installation\n');
    if(detected.state==='repair')io.write(tool.id+': '+detected.reason+'\n');
    if(detected.state==='missing'&&io.isTTY&&!values['--json']){
     const global=await inspectGlobalNpm(root,tool.id).catch(()=>undefined);
     if(global){
      const destinations='project 写入 '+toolPackage(tool.id).prefix+'，global 写入 '+terminalText(global.prefix);
      const scope=await ask({message:tool.id+' 安装范围（'+destinations+'）',choices:['project','global'],defaults:['project']});
      if(!Array.isArray(scope))return 130;
      if(scope[0]==='global'){(flags.globalTools??=[]).push(tool.id);choices.push({...tool,install:false,initialize:prior?.initialize??false});continue;}
     }
    }
    choices.push(detected.state==='available'||detected.state==='repair'?{...tool,install:false,initialize:prior?.initialize??false}:detected.state==='missing'?{...tool,install:true}:tool);
   }
   options.tools=choices;
  }
  if(flags.deferResearch&&!options.sdd&&options.projectRules===undefined)options.projectRules=true;
  const wantsRules=options.projectRules??!!options.sdd;
  if(wizard&&wantsRules&&!explicitResearch)flags.foundationOnly=true;
  runtimeSetup=await runtimeSetupSummary(root,options);
  if(modernResearch&&!flags.deferResearch&&!flags.foundationOnly){
   let later=false;
   if(runtimeSetup.template.state!=='pending'||explicitResearch){
    const environment=await runtimeEnvironment(root,options,'provider',values['--model']);
    services.provider??=await resolveResearchProvider(root,values['--model'],options.model,environment);
    if(!services.provider&&guided&&!flags.dryRun&&values['--model']){
     const selected=await promptResearchProvider(promptIO,values['--model'],environment);
     if(selected===null)return 130;
     later=selected===undefined;
     services.provider=selected;
    }
   }
   if(!services.provider){
    if(values['--model']&&!later){
     const message='Configure a CLI provider and its credentials before requesting research with --model.';
     services.report?.({phase:'research',installStatus:'pending',projectRules:manifest?.projectRules,requiredInput:[message],researchNextStep:message});
     presentation.notice(message);
     return 3;
    }
    flags.foundationOnly=true;
    if(manifest&&!flags.dryRun){flags.review=true;flags.yes=false;}
   }
  }else if(explicitResearch&&guided&&wantsRules&&!flags.deferResearch&&!flags.foundationOnly&&options.backend==='native'){
   const environment=await runtimeEnvironment(root,options,'provider');
   const credentials=await promptNativeCredentials(options,promptIO,services.credentials,
    {...environment,RIGUP_API_KEY_ENV:values['--api-key-env']??environment.RIGUP_API_KEY_ENV});
   if(!credentials)return 130;
   services.credentials=credentials;
  }
  if(flags.researchTokens&&(!options.sdd||options.backend!=='codex'))throw Error('--research-tokens requires the Codex backend and a development workflow');
  if(flags.configure&&values['--review'])options.executionPolicy={mode:'review'};
  validateOptions(options as unknown as Record<string,unknown>);
  if(interactive&&!flags.dryRun&&!flags.review)services.confirmPreview=async()=>{
   const choices=['Install','Save preview, apply later','Cancel'];
   const answer=await ask({message:'Continue?',choices,defaults:[choices[0]]});
   return Array.isArray(answer)&&answer[0]===choices[0]?'install':Array.isArray(answer)&&answer[0]===choices[1]?'save':'cancel';
  };
 }catch(e){state.error=errorMessage(e);return services.signal?.aborted?130:2;}
 try{
  const code=await executeLifecycle(root,options,flags,io.write,{...services,isTTY:io.isTTY});
  return code;
 }catch(e){state.error=errorMessage(e);return io.services?.signal?.aborted?130:1;}
}
export async function runCli(argv:string[],io:CliIO):Promise<number>{
 if(argv[0]==='openspec')try{return await forwardProjectOpenSpec(io.cwd,argv.slice(1),io.services?.stateRoot,io.services?.signal);}
 catch(error){(io.writeError??io.write)(errorMessage(error)+'\n');return io.services?.signal?.aborted?130:1;}
 const json=argv.includes('--json'),verbose=argv.includes('--verbose');
 const redirected=io.isTTY&&(io.outputIsTTY??io.terminal?.output.isTTY)===false;
 const ui=!json&&io.isTTY&&!redirected&&io.terminal?terminalUI(io.terminal,io.services?.signal):undefined;
 const writeText=json?io.writeError:redirected?io.writeError??io.write:io.write;
 const write=(text:string)=>{ui?.stop();writeText?.(terminalText(text,true));};
 const read=io.read??(io.terminal?terminalReader(io.terminal.input,text=>{
  ui?.stop();writeText?.(text);
 },io.services?.signal):undefined);
 const display=createCliOutput({write,json,verbose,stateRoot:io.services?.stateRoot,stage:ui?.stage,stop:ui?.stop});
 let actual:Record<string,unknown>={},last='';
 const report=(value:Record<string,unknown>)=>{actual=value;io.services?.report?.(value);};
 const code=await runCliInternal(argv.filter(arg=>arg!=='--json'&&arg!=='--verbose'),{
  ...io,...(json?{isTTY:false,ask:undefined,read:undefined}:{ask:io.ask??ui?.ask,read}),
  write:text=>{last=text;write(text);},
  services:{...io.services,report,presentation:display.presentation},
 },display);
 if(actual.phase==='apply'&&actual.status==='complete'&&display.state.root&&display.state.data?.plan.options.sdd==='openspec'){
  try{
   const {root,data}=display.state;
   const stateRoot=await privateDirectory(io.services?.stateRoot??defaultStateRoot(),root);
   const path=join(stateRoot,'init-'+signature(root)+'.json');
   const draft=await readDurableRecord<{root:string;agents:SetupOptions['agents']}>(path,'OpenSpec setup choices');
   if(draft?.root===root&&signature(draft.agents)===signature(data.plan.options.agents))await rm(path,{force:true});
  }catch{if(verbose)write('Could not remove the saved OpenSpec choices.\n');}
 }
 if(verbose&&actual.runtimeSetup)writeRuntimeSummary(actual.runtimeSetup as RuntimeSetupSummary,write);
 await display.finish(code,actual);
 if(json){
  const error=display.state.error??applyReason(actual)??actual.error??last.trim();
  const result={phase:actual.phase??'preflight',installStatus:actual.installStatus??(code===0?'complete':code===3?'pending':'failed'),checks:[],pending:[],conflicts:[],requiredInput:[],nextCommand:null,...actual,exitCode:code,...((code===1||code===2)?{error}:{})};
  io.write(JSON.stringify(result)+'\n');
 }
 return code;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(await realpath(resolve(process.argv[1]))).href){
 const argv=process.argv.slice(2);
 if(argv[0]==='mcp'){
  try{
   const {serveResearchMcp}=await import('./research/mcp-stdio.js');
   await serveResearchMcp(argv.slice(1),{cwd:process.cwd(),input:process.stdin,output:process.stdout});
  }catch(error){process.stderr.write(errorMessage(error)+'\n');process.exitCode=1;}
 }else{
  const controller=new AbortController();process.once('SIGINT',()=>controller.abort());
  process.exitCode=await runCli(argv,{cwd:process.cwd(),isTTY:!!process.stdin.isTTY,outputIsTTY:!!process.stdout.isTTY,
   write:text=>process.stdout.write(text),writeError:text=>process.stderr.write(text),terminal:{input:process.stdin,output:process.stdout},services:{signal:controller.signal}});
 }
}
