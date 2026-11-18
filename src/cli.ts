#!/usr/bin/env node
import {inspectGlobalNpm} from './integrations/tools/global-npm.js';
import {defaultNpmRegistry} from './integrations/tools/npm-resolution.js';
import {toolPackage} from './integrations/tools/recipes.js';
import {readFile,realpath,rm} from 'node:fs/promises';
import {resolve,join,relative,isAbsolute,sep} from 'node:path';
import {homedir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {onboard,promptNativeCredentials,restrictBindings} from './onboarding.js';
import {detectCommands,detectSdd,detectToolInstallation} from './setup-detection.js';
import {askLine,choice,terminalReader,type Ask} from './prompt.js';
import {loadOptions,normalizeDocumentLanguage,readProjectConfig,validateOptions,type SetupOverrides} from './config.js';
import type {SetupOptions} from './types.js';
import {loadManifest} from './installer/baseline.js';
import {loadPreview} from './installer/preview.js';
import {apply,interruptedApplyId,interruptedApplyOptions,interruptedInstallApplyId,interruptedSeedApplyId} from './installer/apply.js';
import {inspectProjectSetup} from './installer/project-setup.js';
import {rigupLauncherTarget} from './integrations/agents/rigup-config.js';
import {doctor} from './installer/doctor.js';
import {doctorLegacyLastLine} from './i18n/doctor.js';
import {defaultStateRoot} from './installer/lock.js';
import {executeLifecycle,executeProjectClaim,loadContinuation,type LifecycleServices,type LifecycleFlags} from './lifecycle.js';
import {inspectOpenSpec,openSpecProjectScopes,OpenSpecReceiptError,planOpenSpecPreparation,preparationScope,prepareOpenSpec,reportOpenSpecPending,type OpenSpecInspection,type OpenSpecPreparation} from './integrations/sdd/openspec-setup.js';
import {openspecPackage,openspecPreparationCommand,type OpenSpecInstallScope} from './integrations/sdd/openspec.js';
import {forwardProjectOpenSpec,readOpenSpecPreparation} from './integrations/sdd/openspec-project.js';
import {privateDirectory,signature} from './generator/cache.js';
import {readDurableRecord,saveDurable} from './private-record.js';
import {quoteShell,quoteShellList} from './shell-command.js';
import {LinkedRigupDirectoryError} from './installer/ownership.js';
import {promptResearchProvider,resolveResearchProvider} from './research/provider-settings.js';
import {runtimeEnvironment,runtimeSetupSummary,selectProviderEnvImport,writeRuntimeSummary,type RuntimeSetupSummary} from './runtime-inputs.js';
import {applyReason,createCliOutput,terminalText,writeDoctor} from './cli-output.js';
import {supportedHost} from './integrations/host-setup/manual.js';
import {nativeSetupInteraction} from './integrations/host-setup/index.js';
import {terminalUI,type TerminalStreams} from './terminal-ui.js';
import {resolveLocale,setLocale,t,translate,withLocale,type MessageKey,type MessageParams} from './i18n/index.js';
import {makeReason,nextStepReasonDetail,ReasonError,reasonDetail,reasonFallback,reasonFromError,renderReason,type ReasonInput,type ReasonedReport} from './i18n/reasons.js';
export interface CliIO {cwd:string;isTTY:boolean;outputIsTTY?:boolean;write(text:string):void;writeError?(text:string):void;read?(secret?:boolean):Promise<string|null>;ask?:Ask;terminal?:TerminalStreams;services?:LifecycleServices}
const listOptions:Record<string,RegExp>={
 '--agents':/^(?:claude|codex|opencode|omp)$/,
 '--tools':/^(?:openwiki|codegraph|none)$/,
 '--run-checks':/^(?:build|lint|test|environment|eval)$/,
 '--retire':/^[^,\s]+$/,
};
const splitList=(value:string)=>value.split(',').flatMap(part=>part.trim().split(/\s+/));
const lifecycleCommands=['init','update','doctor'] as const;
const isLifecycleCommand=(value:unknown):value is typeof lifecycleCommands[number]=>lifecycleCommands.some(command=>command===value);
function validLanguage(value:unknown):string|undefined{
 try{return normalizeDocumentLanguage(value);}catch{return undefined;}
}
const activateLanguage=(language:string|undefined)=>setLocale(resolveLocale(language,process.env));

async function runCliInternal(argv:string[],io:Omit<CliIO,'write'>&{write(text:string,english?:string):void},display:ReturnType<typeof createCliOutput>):Promise<number>{
 const {state,presentation,verbose,json,recordNativeEffects}=display;
 const fail=(code:number,key:MessageKey,params?:MessageParams,english=translate('en',key,params))=>{
  io.write(t(key,params)+'\n',english+'\n');return code;
 };
 const failRaw=(code:number,reason:ReasonInput)=>{io.write(renderReason(reason)+'\n',reasonFallback(reason)+'\n');return code;};
 const configWarnings:string[]=[];
 const configWarning=(message:string)=>configWarnings.push(message);
 const writeConfigWarnings=()=>{
  for(const message of configWarnings.splice(0)){
   const field=message.slice(0,message.indexOf(': '));
   io.write(t('cli.configWarning',{field})+'\n',message+'\n');
  }
 };
 const promptWrite=io.isTTY&&io.outputIsTTY===false?io.writeError??io.write:io.write;
 const promptIO={write:promptWrite,read:io.read??(async()=>null)};
 const ask:Ask=io.ask??(question=>askLine(promptIO,question));
 const services:LifecycleServices={...io.services};
 const flags:LifecycleFlags={};const overrides:SetupOverrides={};const positional:string[]=[];let applyId:string|undefined,showHelp=false;
 let argumentError:{key:MessageKey;params?:MessageParams;english?:string}|undefined;
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
    argumentError??={key:'cli.listValue',params:{flag}};
    if(equal<0&&list.length)i++;
    continue;
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
  if(boolean.has(arg)){values[arg]='true';continue;}
  if(valued.has(arg)){
   if(!argv[i+1]||argv[i+1].startsWith('--'))argumentError??={key:'cli.valueRequired',params:{flag:arg}};
   else values[arg]=argv[++i];
   continue;
  }
  if(arg==='--help'){showHelp=!argumentError;break;}
  if (arg === '--version') {
   if(argumentError)break;
   const {version} = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
   io.write(`${version}\n`);
   return 0;
  }
  if(flag==='--agent')argumentError??={key:'cli.agentFlagHint',english:'Unknown option'};
  else if(arg.startsWith('-'))argumentError??={key:'cli.unknownOption'};
  else positional.push(arg);
 }
 if(!argumentError&&values['--sdd']&&!values['--prepare-native']){
  try{validateOptions({sdd:values['--sdd']});}
  catch{argumentError={key:'cli.sddFlagHint',params:{choices:'superpowers, openspec, spec-kit, none'},english:'sdd: unsupported selection'};}
 }
 const invalidCommand=positional.length>2||positional[0]&&!isLifecycleCommand(positional[0]);
 const missingCommand=!positional.length&&!io.isTTY;
 const showUsage=argumentError||showHelp||missingCommand||invalidCommand;
 const usage=()=>{
  if(argumentError)return fail(2,argumentError.key,argumentError.params,argumentError.english);
  if(showHelp){io.write(t('cli.help'));return 0;}
  if(missingCommand){
   io.write(t('cli.help')+t('cli.chooseCommand')+'\n',translate('en','cli.help')+translate('en','cli.chooseCommand')+'\n');return 2;
  }
  io.write(t('cli.help'),translate('en','cli.help'));return 2;
 };
 let root:string;try{root=await realpath(resolve(io.cwd,positional[1]??'.'));}catch{
  if(showUsage)return usage();
  return fail(2,'cli.pathRequired');
 }
 let manifest:Awaited<ReturnType<typeof loadManifest>>,manifestError:unknown;
 try{manifest=await loadManifest(root);}catch(error){manifestError=error;}
 let config:Awaited<ReturnType<typeof readProjectConfig>>,configError:unknown;
 if(!(manifestError instanceof LinkedRigupDirectoryError)){
  try{config=await readProjectConfig(root,configWarning);}catch(error){configError=error;}
 }
 const languageIndex=argv.lastIndexOf('--language');
 const explicitLanguage=values['--language']??(showHelp&&languageIndex>=0?argv[languageIndex+1]:undefined);
 const languageOverride=validLanguage(explicitLanguage);
 const initialLanguage=languageOverride??validLanguage(config?.documentLanguage)??validLanguage(manifest?.options?.documentLanguage);
 activateLanguage(initialLanguage);
 const loadSelections=(selected:SetupOverrides,approved?:SetupOptions,defaults?:Parameters<typeof loadOptions>[3])=>{
  if(configError&&!approved)throw configError;
  return loadOptions(root,selected,approved,{...defaults,project:config??{},onWarning:configWarning});
 };
 if(!explicitLanguage&&(showUsage||!positional.length||positional[0]==='doctor')&&
    (values['--profile']||config?.profile||manifest?.options?.profile)){
  try{
   const effective=await loadSelections(values['--profile']?{profile:values['--profile']}:{},undefined,{fallback:manifest?.options});
   activateLanguage(effective.documentLanguage??initialLanguage);
  }catch{/* Help, the menu and doctor must remain available with an invalid profile. */}
 }
 if(showUsage)return usage();
 if(manifestError)return manifestError instanceof LinkedRigupDirectoryError?failRaw(1,manifestError.message):fail(1,'cli.manifestDamaged');
 let command=isLifecycleCommand(positional[0])?positional[0]:manifest?'update':'init';
 if(!positional.length){
  const answer=await ask({message:'Rigup',choices:[
   {value:manifest?'update':'init',label:t(manifest?'command.update':'command.init')},
   {value:'doctor',label:t('command.doctor')},{value:'exit',label:t('menu.exit')},
  ]});
  if(!Array.isArray(answer)||!isLifecycleCommand(answer[0]))return 130;
  command=answer[0];
 }
 let headerWritten=false;
 const start=(language?:string)=>{
  if(language!==undefined)activateLanguage(language);
  if(!headerWritten){
   headerWritten=true;
   const path=terminalText(root);
   io.write(t('cli.header',{command:t(`command.${command}`),path})+'\n',translate('en','cli.header',{command,path})+'\n');
  }
  writeConfigWarnings();
 };
 const commandError=(code:number,key:MessageKey,params?:MessageParams)=>{start();return fail(code,key,params);};
 const nativeTTY=io.isTTY===true&&(io.outputIsTTY??io.terminal?.output.isTTY)===true;
 state.nativeTTY=nativeTTY;
 const openSpecPending=async(setup:OpenSpecInspection,agents:SetupOptions['agents'],resumeAt:(project:string|undefined)=>string,reportPending=true)=>{
  const resumeCommand=resumeAt(root);
  const commands=reportPending?reportOpenSpecPending(setup,resumeCommand,presentation.notice,services.report):
   [...setup.steps.filter(step=>step!==resumeCommand),resumeCommand];
  const cwd=await realpath(io.cwd).catch(()=>undefined);
  const projectPath=cwd===undefined?root:relative(cwd,root);
  const project=projectPath.startsWith('-')?'.'+sep+projectPath:projectPath||undefined;
  const prepareCommand=openspecPreparationCommand(root,agents,setup.scope);
  state.openSpecNext=commands.map(step=>step===resumeCommand?resumeAt(project):
   step===prepareCommand?openspecPreparationCommand(project,agents,setup.scope):step);
 };
 const nativeInput={...services.nativeSetup,stateRoot:services.nativeSetup?.stateRoot??services.stateRoot,signal:services.signal};
 if(values['--prepare-native']){
  if(positional[0]!=='init'||!values['--agents']||values['--sdd']!=='superpowers'||
     Object.keys(values).some(flag=>!['--agents','--sdd','--prepare-native','--review','--dry-run','--language'].includes(flag))||
     values['--review']&&values['--dry-run']){
   return fail(2,'cli.nativeUsage');
  }
  state.root=root;
  state.standaloneNative=true;
  try{
   const selected=await loadSelections({agents:values['--agents'].split(',') as SetupOptions['agents'],sdd:'superpowers',...(values['--language']?{documentLanguage:values['--language']}:{})},
    undefined,{fallback:manifest?.options});
   start(selected.documentLanguage??initialLanguage);
   const result=await nativeSetupInteraction(root,selected.agents,nativeInput,{write:io.write,report:services.report,
    ask,inspect:!!(values['--review']||values['--dry-run']),canPrompt:nativeTTY&&selected.executionPolicy?.mode!=='review',
    isTTY:nativeTTY,verbose,onEffects:recordNativeEffects});
   return result==='back'?130:result;
  }catch(error){return failRaw(services.signal?.aborted?130:1,reasonFromError(error));}
 }
 if(values['--defer-research']){
  if(command!=='init'||manifest||['--apply','--continue','--request','--response','--retire'].some(arg=>values[arg])){
   return fail(2,'cli.deferUsage');
  }
  flags.deferResearch=true;
 }
 if(command==='init'&&manifest)command='update';

 if(values['--prepare-openspec']&&(command==='doctor'||['--apply','--dry-run','--review','--continue','--request','--response','--research-tokens'].some(flag=>values[flag]))){
  return commandError(2,'cli.openSpecUsage');
 }
 if(values['--install-scope']&&(!values['--prepare-openspec']||!['project','global'].includes(values['--install-scope']))){return commandError(2,'cli.scopeUsage');}
 if(values['--check-host']&&(command!=='doctor'||values['--check-host']!=='claude')){return commandError(2,'cli.hostUsage');}
 if(command==='doctor'){
  start();
  if(values['--research-tokens'])return fail(2,'cli.researchDoctor');
  if(explicitLanguage&&!languageOverride){
   try{normalizeDocumentLanguage(explicitLanguage);}catch(error){return failRaw(2,reasonFromError(error));}
  }
  try{
   const runChecks=values['--run-checks']?.split(',') as import('./types.js').CheckKind[]|undefined;
   const report=await doctor(root,{checkHost:values['--check-host']?'claude':undefined,runChecks,
    stateRoot:services.stateRoot,signal:services.signal});
   services.report?.({phase:'doctor',installStatus:report.nextCommand?'pending':'not-applicable',...report});
   state.doctorJsonError=doctorLegacyLastLine(report);
   writeDoctor(report,io.write,{verbose,json,projectArgument:positional[1]});
   return report.exitCode;
  }catch(error){return failRaw(1,reasonFromError(error));}
 }
 state.root=root;
 if(values['--agents'])overrides.agents=values['--agents'].split(',') as SetupOptions['agents'];
 if(values['--sdd'])overrides.sdd=values['--sdd'] as SetupOverrides['sdd'];
 if(values['--backend'])overrides.backend=values['--backend'] as SetupOptions['backend'];
 if(values['--profile'])overrides.profile=values['--profile'];
 if(values['--language'])overrides.documentLanguage=values['--language'];
 flags.dryRun=!!values['--dry-run'];flags.yes=!io.isTTY&&!values['--dry-run']&&!values['--review'];flags.review=!!values['--review'];flags.response=values['--response'];flags.request=values['--request'];flags.configure=!!values['--configure'];if(flags.request){const privateRoot=resolve(io.services?.cacheRoot??join(homedir(),'.cache','rigup'),'host');const rel=relative(privateRoot,resolve(flags.request));if(!isAbsolute(flags.request)||!rel||rel.startsWith('..')||isAbsolute(rel)){return commandError(2,'cli.requestPath',{path:privateRoot});}}if(flags.request&&flags.response){return commandError(2,'cli.requestResponse');}flags.sessionsEnded=!!values['--sessions-ended'];flags.resume=!!values['--resume'];flags.retireIds=values['--retire']?.split(',');flags.runChecks=values['--run-checks']?.split(',') as import('./types.js').CheckKind[];if(flags.runChecks?.some(k=>!['build','lint','test','environment','eval'].includes(k))){return commandError(2,'cli.checkKinds');}applyId=values['--apply'];
 state.sessionsEnded=flags.sessionsEnded;
 if([flags.dryRun,flags.yes,flags.review].filter(Boolean).length>1){return commandError(2,'cli.executionMode');}
 if(values['--research-tokens']){
  const tokens=Number(values['--research-tokens']);
  if(!/^[1-9][0-9]*$/.test(values['--research-tokens'])||!Number.isSafeInteger(tokens)||applyId||flags.deferResearch){return commandError(2,'cli.researchTokens');}
  flags.researchTokens=tokens;
 }
 if(applyId){
  if(overrides.documentLanguage){return commandError(2,'cli.applyLanguage');}
  if(values['--model']){return commandError(2,'cli.applyModel');}
  if(Object.keys(values).some(flag=>!['--apply','--sessions-ended','--resume','--run-checks','--verbose'].includes(flag))){
   return commandError(2,'cli.applyOptions');
  }
  try{
   const cacheRoot=join(services.cacheRoot??join(homedir(),'.cache','rigup'),'previews');
   const prepared=await loadPreview(applyId,cacheRoot);
   if(prepared.plan.root!==root)throw new Error('preview project root differs from requested path');
   start(prepared.plan.options.documentLanguage);
   state.data=prepared;
   if(!prepared.preview.executable)throw new Error('preview is blocked; prepare a new preview');
   if(flags.runChecks&&JSON.stringify([...flags.runChecks].sort())!==JSON.stringify([...(prepared.plan.runChecks??[])].sort()))throw new Error('apply checks differ from approved preview; prepare a new preview with --run-checks');
   if(!manifest&&!prepared.plan.claim&&prepared.plan.options.sdd==='openspec'){
    const setup=await inspectOpenSpec(root,prepared.plan.options,services.signal,undefined,{stateRoot:services.stateRoot,scope:'project'});
    if(services.signal?.aborted)return 130;
    if(setup.requirements.length){
     for(const requirement of setup.requirementReasons)io.write(t('openspec.prefix',{requirement:renderReason(requirement)})+'\n');
     const agents=prepared.plan.options.agents;
     await openSpecPending(setup,agents,project=>{
      const path=project===undefined?'':' '+quoteShell(project);
      return setup.needsProject
       ?'rigup init'+path+' --agents '+quoteShellList(agents)+' --sdd openspec'+(prepared.plan.projectRules==='pending'?' --defer-research':'')+' --review'
       :'rigup update'+path+' --apply '+applyId+(flags.resume?' --resume':'');
     });
     return 3;
    }
   }
   presentation.progress({stage:'apply',completed:0});
   presentation.applying(applyId);
   const report=await apply(applyId,{cacheRoot,stateRoot:services.stateRoot,recover:flags.resume,signal:services.signal,runChecks:services.runChecks});
   services.report?.({phase:'apply',installStatus:report.status,...report});
   return report.exitCode;
  }catch(e){start();state.error=reasonFromError(e);return services.signal?.aborted?130:1;}
 }
 const resumeApply=flags.resume&&!flags.request&&!flags.response&&!flags.researchTokens&&!values['--prepare-openspec']&&!values['--continue'];
 let savedApplyOptions:SetupOptions|undefined;
 try{
  if(resumeApply)savedApplyOptions=await interruptedApplyOptions(root,services.stateRoot);
  else{
   const seedApply=await interruptedSeedApplyId(root,services.stateRoot);
   const interruptedPreviewId=seedApply??await interruptedInstallApplyId(root,services.stateRoot);
   if(interruptedPreviewId){
    start();
    const nextCommand='rigup update '+quoteShell(root)+' --resume --review';
    const reason=makeReason(seedApply?'cli.interruptedSeed':'cli.interruptedTool');
    services.report?.({phase:'preflight',installStatus:'pending',reason:'interrupted-install',interruptedPreviewId,pending:[reason.fallback],nextCommand,[reasonDetail]:reason});
    return 3;
   }
  }
 }
 catch(error){start();return failRaw(1,reasonFromError(error));}
 let options:SetupOptions;
 let draftPath:string|undefined;
 try {
  const hasProjectConfig=!!config;
  if(savedApplyOptions&&(flags.configure||flags.runChecks||flags.retireIds||overrides.profile))throw Error('Interrupted installation retains its approved plan. Finish it before changing the selection or checks.');
  const approvedOptions=savedApplyOptions??(manifest?.projectRules==='pending'&&!manifest.options?.projectRules&&!flags.configure&&!overrides.profile?manifest.options:undefined);
  const legacyResearch=['--backend','--api-key-env','--request','--response','--continue','--research-tokens'].some(flag=>values[flag]);
  const newSetup=!manifest&&!legacyResearch&&(!flags.resume||flags.deferResearch||!!values['--model']||!!process.env.RIGUP_PROVIDER);
  const managedConfig=manifest?.assets.some(asset=>asset.logicalId==='rigup:configuration');
  const useInstalledDefaults=manifest&&(!hasProjectConfig||manifest.options?.projectRules&&!managedConfig);
  const disabledRules=manifest?.options?.projectRules===false&&manifest.assets.some(asset=>asset.target===rigupLauncherTarget)?manifest.options:undefined;
  const fallback=manifest&&useInstalledDefaults?(manifest.options??{agents:[],backend:'host' as const}):
   disabledRules&&{agents:disabledRules.agents,backend:disabledRules.backend,profile:disabledRules.profile,projectRules:false};
  let configured={agents:false,sdd:false};
  options=await loadSelections(overrides,approvedOptions,{projectRules:newSetup||manifest?.options?.backend==='host'&&manifest.options.projectRules!==undefined,
   fallback,onSelections:value=>{configured=value;}});
  const toolIds=values['--tools']?.split(',');
  if(toolIds?.includes('none')&&toolIds.length!==1)
   throw new ReasonError(makeReason('reason.cli.toolsNone',undefined,'tools: none cannot be combined with a tool'));
  const explicitKeyEnv=values['--api-key-env'];
  if(explicitKeyEnv&&values['--backend']!=='codex'&&!/^[A-Z_][A-Z0-9_]*$/.test(explicitKeyEnv))
   throw new ReasonError(makeReason('reason.config.apiKeyEnv',{field:'--api-key-env'},'model.apiKeyEnv: environment reference required'));
  const unapproved=!manifest&&!savedApplyOptions&&!flags.request&&!flags.response&&!values['--continue']&&!values['--prepare-openspec'];
  const ordinary=Object.keys(values).every(flag=>['--review','--dry-run','--resume','--sessions-ended','--language','--profile'].includes(flag));
  if(unapproved&&(ordinary||!configured.agents)){
   const needsAgents={field:'agents',provide:'Specify --agents with one or more supported hosts'};
   const pending=(key:MessageKey,params?:MessageParams,nextCommand?:string,requireAgents=false)=>{
    start(options.documentLanguage??initialLanguage);
    const reason=translate('en',key,params);
    io.write(t(key,params)+'\n',reason+'\n');
    const installStatus=key==='cli.initRequired'?'not-installed':'pending';
    services.report?.({phase:'preflight',installStatus,pending:[reason],...(nextCommand?{nextCommand}:{}),
     ...(requireAgents?{requiredInput:[needsAgents]}:{})});
    return 3;
   };
   if(ordinary&&await interruptedApplyId(root,services.stateRoot??defaultStateRoot())){
    return pending('doctor.interrupted',undefined,'rigup update '+quoteShell(root)+' --resume --review');
   }
   const existing=await inspectProjectSetup(root);
   if(existing.kind==='claimable'){
    if(ordinary&&configured.agents&&[...new Set(options.agents)].sort().join()!==[...existing.agents].sort().join()){
     const next=options.agents.length?'rigup init '+quoteShell(root)+' --agents '+quoteShellList(options.agents)+' --review':undefined;
     return pending('cli.claimSelectionMismatch',undefined,next,!next);
    }
    if(!configured.agents){options.agents=existing.agents;configured.agents=true;}
    if(ordinary){
     start(options.documentLanguage??initialLanguage);
     return await executeProjectClaim(root,options,flags,io.write,services);
    }
   }else if(existing.kind==='incomplete'){
    return pending('cli.claimIncomplete',{paths:existing.paths.map(path=>terminalText(path)).join(', ')},undefined,!configured.agents);
   }else if(!configured.agents&&existing.kind==='ambiguous'){
    return pending('cli.claimAgentsRequired',undefined,undefined,true);
   }else if(!configured.agents&&command==='update'){
    return pending('cli.initRequired',undefined,'rigup init '+quoteShell(root)+(flags.resume?' --review':''));
   }else if(!configured.agents&&command==='init'&&!io.isTTY){
    const detected=await detectCommands(root);
    if(!detected.agents.length)return pending('cli.pathAgentsRequired',undefined,undefined,true);
    options.agents=detected.agents;
   }
  }
  if(manifest&&flags.configure&&!legacyResearch&&!savedApplyOptions&&options.projectRules===undefined)options.projectRules=true;
  const modernResearch=options.projectRules===true&&!legacyResearch&&!savedApplyOptions;
  const configuredTools=new Map(options.tools?.map(tool=>[tool.id,tool]));
  if(toolIds){
   if(toolIds[0]==='none'){if(flags.configure||options.tools)options.tools=[];}
   else options.tools=toolIds.map(raw=>{
    const id=raw as 'openwiki'|'codegraph';
    return configuredTools.get(id)??{id,install:true,initialize:id==='codegraph',agents:[...options.agents]};
   });
  }
  if(values['--continue']){if(Object.keys(overrides).length||['--tools','--model','--api-key-env','--review','--dry-run','--configure','--retire','--run-checks'].some(k=>values[k]))throw new ReasonError(makeReason('reason.cli.continueOptions',undefined,'continuation cannot change explicit selections or execution mode'));const continuation=await loadContinuation(root,values['--continue'],io.services);options=continuation.options;Object.assign(flags,{...continuation.flags,response:flags.response,sessionsEnded:flags.sessionsEnded,resume:flags.resume});}
  if(options.documentLanguage!==undefined)activateLanguage(options.documentLanguage);
  if(!modernResearch&&(values['--model']||values['--api-key-env'])){if(values['--backend']==='codex')throw Error('model/API-key flags select the native backend; Codex model overrides are not supported');if(!values['--backend'])options.backend='native';const model=values['--model']??options.model?.model??process.env.ANTHROPIC_MODEL;const apiKeyEnv=values['--api-key-env']??options.model?.apiKeyEnv??'ANTHROPIC_API_KEY';if(!/^[A-Z_][A-Z0-9_]*$/.test(apiKeyEnv))throw new ReasonError(makeReason('reason.config.apiKeyEnv',{field:'--api-key-env'},'model.apiKeyEnv: environment reference required'));if(!model&&!(io.isTTY&&io.read))throw new Error('model.model: required when changing the API-key reference');if(model)options.model={provider:options.model?.provider??'anthropic',model,apiKeyEnv};}
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
  const nativeDeps={stateRoot:services.stateRoot,signal:services.signal,recover:flags.resume,write:io.write,view:services.npmView,verbose};
  const prepareApproved=async(selected:SetupOptions,approval:OpenSpecPreparation)=>{
   state.native=approval.kind!=='existing'?{version:approval.install.version,prefix:approval.prefix}:{version:approval.cliVersion};
   presentation.progress({stage:'openspec',completed:0});
   const setup=await prepareOpenSpec(root,selected,approval,{...nativeDeps,onInstalled:()=>{
    state.native={...state.native,installed:true};
   }});
   state.native={...state.native,version:setup.cliVersion??state.native.version,ready:!setup.requirements.length};
   presentation.progress({stage:'openspec',completed:1,status:'complete'});
   return setup;
  };
  const describePreparation=(approval:OpenSpecPreparation)=>{
   const {kind,needsRoot,needsEntries,agents}=approval;
   nativePreparation={kind,needsRoot,needsEntries,agents,...(kind!=='existing'?{name:openspecPackage,version:approval.install.version,registry:approval.install.registry,prefix:approval.prefix,...(kind==='project-install'||values['--install-scope']?{packageIntegrity:approval.install.packageIntegrity}:{} )}:{version:approval.cliVersion})};
   if(kind!=='existing')io.write(t('openspec.installPackage',{package:openspecPackage,version:approval.install.version,registry:approval.install.registry??defaultNpmRegistry,prefix:terminalText(approval.prefix)})+'\n'+approval.install.packageIntegrity+'\n');
   else io.write('OpenSpec CLI '+approval.cliVersion+'\n');
   if(needsRoot||needsEntries.length)io.write(t('openspec.projectFiles',{scopes:openSpecProjectScopes(approval).join(', ')})+'\n');
  };
  const failedPreparation=(error:unknown,selected:SetupOptions,scope:OpenSpecInstallScope='project')=>{
   if(state.native&&error instanceof OpenSpecReceiptError){
    state.native.installed=true;state.native.receiptFailed=true;
   }
   if(services.signal?.aborted)return 130;
   const reason=reasonFromError(error);
   const message=reasonFallback(reason);
   state.error=reason;
   services.report?.({phase:'preflight',installStatus:state.native?.installed?'partial':'failed',error:message,pending:[message],[reasonDetail]:reason,
    ...(state.native?{nextCommand:openspecPreparationCommand(root,selected.agents,scope)+' --resume'}:{})});
   return 1;
  };
  if(values['--prepare-openspec']){
   start();
   runtimeSetup=await runtimeSetupSummary(root,options);
   if(options.sdd!=='openspec'||!options.agents.length)throw new ReasonError(makeReason('reason.openspec.selection'));
   const saved=await readOpenSpecPreparation(root,nativeDeps.stateRoot);
   const ongoing=saved&&!saved.complete?saved:undefined;
   const originalScope=ongoing?preparationScope(ongoing.approval):undefined;
   const requested=values['--install-scope'] as OpenSpecInstallScope|undefined;
   if(ongoing&&originalScope&&(!flags.resume||requested&&requested!==originalScope)){
    const nextCommand=openspecPreparationCommand(root,ongoing.approval.agents,originalScope)+' --resume'+(flags.sessionsEnded?' --sessions-ended':'');
    const reason=makeReason('openspec.resumeScope');
    services.report?.({phase:'preflight',installStatus:'pending',executable:false,pending:[reason.fallback],nextCommand,[reasonDetail]:reason});io.write(t('openspec.resumeScope')+'\n'+nextCommand+'\n');return 3;
   }
   const scope=originalScope??requested??'global';
   let setup=await inspectOpenSpec(root,options,services.signal,undefined,{scope,stateRoot:nativeDeps.stateRoot});
   if(ongoing||setup.requirements.length&&setup.canPrepare){
    try{
     const planned=ongoing?{inspection:setup,approval:ongoing.approval}:await planOpenSpecPreparation(root,options,nativeDeps,setup);setup=planned.inspection;
     if(planned.approval){describePreparation(planned.approval);setup=await prepareApproved(options,planned.approval);}
    }catch(error){return failedPreparation(error,options,scope);}
   }
   if(services.signal?.aborted)return 130;
   if(setup.requirements.length){
    for(const requirement of setup.requirementReasons)io.write(t('openspec.prefix',{requirement:renderReason(requirement)})+'\n');
    await openSpecPending(setup,options.agents,project=>openspecPreparationCommand(project,options.agents,scope));
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
    const draft=await readDurableRecord<{root:string;agents:SetupOptions['agents'];scope?:OpenSpecInstallScope;documentLanguage?:string}>(draftPath,'OpenSpec setup choices',value=>
     value.root===root&&Array.isArray(value.agents)&&value.agents.length>0&&value.agents.every(agent=>['codex','claude','opencode','omp'].includes(agent)));
    if(draft){
     options={...options,agents:draft.agents,sdd:'openspec'};
     const language=validLanguage(draft.documentLanguage);
     if(!values['--language']&&(!options.documentLanguage||options.documentLanguage==='auto')&&language&&language!=='auto')options.documentLanguage=language;
     resumed=true;
     if(draft.scope==='project'||draft.scope==='global')selectedOpenSpecScope=draft.scope;
    }
   }
  }
  if(!wizard)start();
  const repeatOpenSpec=(selected:Pick<SetupOptions,'agents'|'documentLanguage'>,project:string|undefined)=>{
   const originalFlags=Object.entries(values).filter(([flag])=>flag!=='--agents'&&flag!=='--sdd').flatMap(([flag,value])=>boolean.has(flag)?[flag]:[flag,quoteShell(value)]);
   if(wizard&&!values['--language']&&selected.documentLanguage&&selected.documentLanguage!=='auto')originalFlags.push('--language',quoteShell(selected.documentLanguage));
   return ['rigup',command,...(project===undefined?[]:[quoteShell(project)]),
    ...(values['--continue']?[]:['--agents',quoteShellList(selected.agents),'--sdd','openspec']),...originalFlags].join(' ');
  };
  const checkWorkflow=async(selected:SetupOptions,back=false):Promise<'ready'|'back'|'stop'>=>{
   if(selected.sdd==='superpowers'&&selected.agents.some(supportedHost)&&firstWorkflow&&wizard&&inlineReview&&!flags.review&&!flags.dryRun&&nativeTTY){
    const result=await nativeSetupInteraction(root,selected.agents,nativeInput,{write:io.write,report:value=>{
     nativePreparation=value.nativePreparation as Record<string,unknown>;
     if(value.installStatus!=='complete'&&value.installStatus!=='up-to-date')services.report?.(value);
    },ask,inspect:false,canPrompt:true,back,isTTY:nativeTTY,verbose,onEffects:recordNativeEffects,deferReload:true});
    if(result==='back'){nativePreparation=undefined;return 'back';}
    if(result===0)return 'ready';
    setupExit=result;return 'stop';
   }
   if(selected.sdd!=='openspec'||!selected.agents.length)return 'ready';
   const nativeState=await readOpenSpecPreparation(root,nativeDeps.stateRoot);
   if(nativeState&&!nativeState.complete){
    const scope=preparationScope(nativeState.approval);
    const nextCommand=openspecPreparationCommand(root,nativeState.approval.agents,scope)+' --resume';
    const reason=makeReason('openspec.resume');
    services.report?.({phase:'preflight',installStatus:'pending',executable:false,pending:[reason.fallback],nextCommand,[reasonDetail]:reason});
    io.write(t('openspec.resume')+'\n'+nextCommand+'\n');setupExit=3;return 'stop';
   }
   let scope=selectedOpenSpecScope??'project';
   const inspect=()=>inspectOpenSpec(root,selected,services.signal,undefined,{scope,stateRoot:nativeDeps.stateRoot});
   let setup=await inspect();
   if(services.signal?.aborted)return 'stop';
   if(!setup.requirements.length)return 'ready';
   if(!setup.cli&&!selectedOpenSpecScope&&(setup.projectAvailable||setup.globalAvailable)){
    const choices=[
     ...(setup.projectAvailable?[{value:'project',label:t('openspec.project')}]:[]),
     ...(setup.globalAvailable?[{value:'global',label:t('openspec.global',{prefix:terminalText(setup.prefix??t('openspec.globalPrefix'))})}]:[]),
    ];
    if(guided){
     const selection=await ask({message:t('openspec.scope'),choices,defaults:[choices[0].value],back});
     if(selection===null)return 'stop';
     if(selection==='back')return 'back';
     scope=selection[0]==='global'?'global':'project';
    }else if(!setup.projectAvailable)scope='global';
    selectedOpenSpecScope=scope;
    if(setup.scope!==scope)setup=await inspect();
   }
   for(const requirement of setup.requirementReasons)io.write(t('openspec.prefix',{requirement:renderReason(requirement)})+'\n');
   if(setup.canPrepare&&guided&&inlineReview){
    try{
     const planned=await planOpenSpecPreparation(root,selected,nativeDeps,setup);
     for(const requirement of planned.inspection.requirementReasons.slice(setup.requirements.length))io.write(t('openspec.prefix',{requirement:renderReason(requirement)})+'\n');
     setup=planned.inspection;
     if(planned.approval){
      describePreparation(planned.approval);
      const answer=await ask({message:t('openspec.prepare'),choices:[{value:'auto-fill',label:t('openspec.autoFill')},{value:'manual',label:t('openspec.manual')}],defaults:['auto-fill'],back});
      if(answer===null)return 'stop';
      if(answer==='back'){
       nativePreparation=undefined;selectedOpenSpecScope=undefined;
       if(draftPath)await rm(draftPath,{force:true});
       return 'back';
      }
      if(Array.isArray(answer)&&answer.length===1&&answer[0]==='auto-fill'){
       setup=await prepareApproved(selected,planned.approval);
       if(!setup.requirements.length)return 'ready';
      }
     }
    }catch(error){setupExit=failedPreparation(error,selected,scope);return 'stop';}
   }
   if(draftPath)await saveDurable(draftPath,JSON.stringify({root,agents:selected.agents,scope,documentLanguage:selected.documentLanguage}));
   await openSpecPending(setup,selected.agents,project=>repeatOpenSpec(selected,project));
   setupExit=3;
   return 'stop';
  };
  const checkSelectedWorkflow=firstWorkflow||!flags.dryRun&&!savedApplyOptions&&command==='update'&&
   !flags.request&&!flags.response&&!flags.continuation&&(flags.configure||!!values['--sdd']);
  if(wizard){
   const provided={agents:resumed||!!values['--agents'],sdd:resumed||!!values['--sdd'],tools:!!values['--tools']};
   const setup=await onboard(options,promptIO,{configure:!!flags.configure,provided,ask,askLanguage:!values['--language']&&(!options.documentLanguage||options.documentLanguage==='auto'),checkWorkflow:checkSelectedWorkflow?checkWorkflow:undefined,
    onStart:async selected=>{
     start(selected.documentLanguage);
     if(resumed)io.write(t('openspec.resumeSelection',{agents:selected.agents.join(', ')})+'\n');
     presentation.progress({stage:'detect',completed:0});
     const detected=await detectCommands(root);
     presentation.progress({stage:'detect',completed:1,status:'complete'});
     if(!provided.agents&&detected.agents.length)io.write(t('cli.detectedAgents',{agents:detected.agents.join(', ')})+'\n');
     if(!provided.agents&&!configured.agents&&detected.agents.length)selected.agents=detected.agents;
    },
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
    if(detected.state==='project')io.write(t('cli.toolProjectReuse',{tool:tool.id,version:detected.version})+'\n');
    if(detected.state==='available')io.write(t('cli.toolPathReuse',{tool:tool.id})+'\n');
    if(detected.state==='repair')io.write(tool.id+': '+detected.reason+'\n');
    if(detected.state==='missing'&&io.isTTY&&!values['--json']){
     const global=await inspectGlobalNpm(root,tool.id).catch(()=>undefined);
     if(global){
      const destinations=t('cli.toolDestinations',{project:toolPackage(tool.id).prefix,global:terminalText(global.prefix)});
      const scope=await ask({message:t('cli.toolScope',{tool:tool.id,destinations}),choices:[
       choice('project',t('cli.projectScope')),choice('global',t('cli.globalScope')),
      ],defaults:['project']});
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
  let deferredProvider=false;
  if(modernResearch&&!flags.deferResearch&&!flags.foundationOnly){
   if(runtimeSetup.template.state!=='pending'||explicitResearch){
    const environment=await runtimeEnvironment(root,options,'provider',values['--model']);
    services.provider??=await resolveResearchProvider(root,values['--model'],options.model,environment);
    if(!services.provider&&guided&&!flags.dryRun&&values['--model']){
     const selected=await promptResearchProvider(promptIO,values['--model'],environment);
     if(selected===null)return 130;
     deferredProvider=selected===undefined;
     if(selected){
      const {provider,apiKeyEnv}=selected.identity;
      flags.providerEnvImport={provider,apiKeyEnv};
     }
     services.provider=selected;
    }
   }
   if(!services.provider){
    if(values['--model']&&!deferredProvider){
     const reason=makeReason('cli.providerRequired');
     services.report?.({phase:'research',installStatus:'pending',projectRules:manifest?.projectRules,
      requiredInput:[reason.fallback],researchNextStep:reason.fallback,[nextStepReasonDetail]:reason});
     presentation.notice(t('cli.providerRequired'));
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
  if(!savedApplyOptions&&!flags.continuation&&!deferredProvider&&!flags.providerEnvImport){
   flags.providerEnvImport=await selectProviderEnvImport(root,options,values['--model']);
  }
  if(flags.researchTokens&&(!options.sdd||options.backend!=='codex'))throw Error('--research-tokens requires the Codex backend and a development workflow');
  if(flags.configure&&values['--review'])options.executionPolicy={mode:'review'};
  validateOptions(options as unknown as Record<string,unknown>);
  if(interactive&&!flags.dryRun&&!flags.review)services.confirmPreview=async()=>{
   const choices=[choice('Install',t('choice.install')),choice('Save preview, apply later',t('choice.save')),choice('Cancel',t('choice.cancel'))];
   const answer=await ask({message:t('wizard.continue'),choices,defaults:['Install']});
   return Array.isArray(answer)&&answer[0]==='Install'?'install':Array.isArray(answer)&&answer[0]==='Save preview, apply later'?'save':'cancel';
  };
  services.presentation={...presentation,openSpecPending:(setup,agents)=>
   openSpecPending(setup,agents,project=>repeatOpenSpec({agents,documentLanguage:options.documentLanguage},project),false)};
 }catch(e){start();state.error=reasonFromError(e);return services.signal?.aborted?130:2;}
 try{
  const code=await executeLifecycle(root,options,flags,io.write,{...services,isTTY:io.isTTY});
  return code;
 }catch(e){state.error=reasonFromError(e);return io.services?.signal?.aborted?130:1;}
}
export function runCli(argv:string[],io:CliIO):Promise<number>{
 const at=argv.lastIndexOf('--language');
 const declared=at===-1?undefined:validLanguage(argv[at+1]);
 return withLocale(resolveLocale(declared,process.env),()=>runLocalizedCli(argv,io));
}
async function runLocalizedCli(argv:string[],io:CliIO):Promise<number>{
 if(argv[0]==='openspec')try{return await forwardProjectOpenSpec(io.cwd,argv.slice(1),io.services?.stateRoot,io.services?.signal);}
 catch(error){(io.writeError??io.write)(renderReason(reasonFromError(error))+'\n');return io.services?.signal?.aborted?130:1;}
 const json=argv.includes('--json'),verbose=argv.includes('--verbose');
 const redirected=io.isTTY&&(io.outputIsTTY??io.terminal?.output.isTTY)===false;
 const ui=!json&&io.isTTY&&!redirected&&io.terminal?terminalUI(io.terminal,io.services?.signal):undefined;
 const writeText=json?io.writeError:redirected?io.writeError??io.write:io.write;
 const write=(text:string)=>{ui?.stop();writeText?.(terminalText(text,true));};
 const read=io.read??(io.terminal?terminalReader(io.terminal.input,text=>{
  ui?.stop();writeText?.(text);
 },io.services?.signal):undefined);
 const display=createCliOutput({write,json,verbose,stateRoot:io.services?.stateRoot,stage:ui?.stage,stop:ui?.stop});
 let actual:ReasonedReport={},last='';
 const report=(value:ReasonedReport)=>{actual=value;io.services?.report?.(value);};
 const code=await runCliInternal(argv.filter(arg=>arg!=='--json'&&arg!=='--verbose'),{
  ...io,...(json?{isTTY:false,ask:undefined,read:undefined}:{ask:io.ask??ui?.ask,read}),
  write:(text,english=text)=>{last=english;write(text);},
  services:{...io.services,report,presentation:display.presentation},
 },display);
 if(actual.phase==='apply'&&actual.status==='complete'&&display.state.root&&display.state.data?.plan.options.sdd==='openspec'){
  try{
   const {root,data}=display.state;
   const stateRoot=await privateDirectory(io.services?.stateRoot??defaultStateRoot(),root);
   const path=join(stateRoot,'init-'+signature(root)+'.json');
   const draft=await readDurableRecord<{root:string;agents:SetupOptions['agents']}>(path,'OpenSpec setup choices');
   if(draft?.root===root&&signature(draft.agents)===signature(data.plan.options.agents))await rm(path,{force:true});
  }catch{if(verbose)write(t('cli.removeDraftFailed')+'\n');}
 }
 if(actual.runtimeSetup)writeRuntimeSummary(actual.runtimeSetup as RuntimeSetupSummary,write,{
  verbose,providerApiKeyEnv:!json&&actual.phase==='apply'?display.state.data?.plan.providerEnvImport?.apiKeyEnv:undefined,
 });
 await display.finish(code,actual);
 if(json){
  const error=(display.state.error===undefined?undefined:reasonFallback(display.state.error))??applyReason(actual)??actual.error??display.state.doctorJsonError?.trim()??last.trim();
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
  }catch(error){process.stderr.write(reasonFallback(reasonFromError(error))+'\n');process.exitCode=1;}
 }else{
  const controller=new AbortController();process.once('SIGINT',()=>controller.abort());
  process.exitCode=await runCli(argv,{cwd:process.cwd(),isTTY:!!process.stdin.isTTY,outputIsTTY:!!process.stdout.isTTY,
   write:text=>process.stdout.write(text),writeError:text=>process.stderr.write(text),terminal:{input:process.stdin,output:process.stdout},services:{signal:controller.signal}});
 }
}
