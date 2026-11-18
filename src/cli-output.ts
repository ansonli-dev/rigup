import {randomUUID} from 'node:crypto';
import {join,relative} from 'node:path';
import {digest} from './analyzer/evidence.js';
import {privateDirectory,saveCache} from './generator/cache.js';
import {interruptedApplyId,type InstallReport} from './installer/apply.js';
import type {Diagnostic} from './installer/doctor.js';
import {absentDigest,platformFileMode} from './installer/file-state.js';
import {defaultStateRoot} from './installer/lock.js';
import type {Preview,PreviewData} from './installer/preview.js';
import {sessionReloadNotice} from './installer/session.js';
import type {NativeSetupEffects} from './integrations/host-setup/index.js';
import type {OpenSpecInspection} from './integrations/sdd/openspec-setup.js';
import type {SetupOptions,SetupRequirement} from './types.js';
import {defaultNpmRegistry} from './integrations/tools/npm-resolution.js';
import {quoteShell} from './shell-command.js';
import {t,translate,type MessageKey} from './i18n/index.js';
import type {RunProgressEvent} from './progress.js';

export interface LifecyclePresentation {
 progress(event:RunProgressEvent):void;
 preview(data:PreviewData,options?:{livePreview?:Preview;restored?:boolean}):Promise<void>;
 openSpecPending?(setup:OpenSpecInspection,agents:SetupOptions['agents']):Promise<void>;
 superpowersGate?(requirement:SetupRequirement,canPrepare:boolean):void;
 applying(id:string):void;
 notice(text:string):void;
}

export interface NativeResult {ready?:boolean;version?:string;prefix?:string;installed?:boolean;receiptFailed?:boolean}

export function terminalText(text:string,multiline=false):string {
 return text.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g,char=>{
  if(multiline&&char==='\n')return char;
  return '\\u'+char.charCodeAt(0).toString(16).padStart(4,'0');
 });
}

const reasonKeys=[
 'cli.invalidLanguage','cli.invalidJson','cli.operationFailed','cli.applySavedPreview','cli.providerRequired',
 'cli.interruptedSeed','cli.interruptedTool','openspec.resume','openspec.resumeScope',
 'doctor.manifestMissing','doctor.manifestReadable','doctor.manifestDamaged','doctor.recoveryDamaged',
 'doctor.interrupted','doctor.rulesPending','doctor.selectionMissing','doctor.baselineMissing','doctor.targetMissing',
 'doctor.modeChanged','doctor.contentPresent','doctor.modified','doctor.ownershipInvalid','doctor.binaryFound','doctor.binaryMissing',
 'doctor.hostReload','doctor.hostReloadClaude','doctor.hostUnconfigured','doctor.hostProbe','doctor.hostVersion','doctor.nodeFound',
 'doctor.externalFound','doctor.receipt','doctor.wikiBaseline','doctor.nativeUnavailable','doctor.runtimePending','doctor.checkResult',
 'result.reviewWait','preview.seedPrevious','preview.seedMissing','preview.seedExisting','preview.seedCreate',
 'preview.mergeRemoveBaseline','preview.mergeRemoveChanged','preview.mergeMissingContent','preview.mergeExistingChanged',
 'preview.mergeLocalDeleted','preview.mergeBinary','preview.mergeOverlapping',
] as const satisfies readonly MessageKey[];
const reasonByEnglish=new Map<string,MessageKey>(reasonKeys.map(key=>[translate('en',key),key]));
export function terminalReason(reason:string):string{
 const key=reasonByEnglish.get(reason);
 return key?t(key):reason;
}

export function writeDoctor(report:InstallReport&{diagnostics:Diagnostic[]},write:(text:string,english?:string)=>void):void{
 if(report.nextCommand)write(report.nextCommand+'\n');
 for(const {category,id,state,reason} of report.diagnostics){
  write(t(`doctor.category.${category}`)+' '+id+': '+t(`status.${state}`)+' — '+terminalReason(reason)+'\n',
   category+' '+id+': '+state+' — '+reason+'\n');
 }
 for(const {name,status,startedAt,commit} of report.checks){
  const params={name,status,time:startedAt??'',commit:commit??''};
  write(t('doctor.check',{...params,status:t(`status.${status}`)})+'\n',translate('en','doctor.check',params)+'\n');
 }
}

function operationDetails(operation:PreviewData['preview']['operations'][number]):string {
 return operation.id+' '+operation.query.name+'@'+operation.version+
  (operation.kind==='install'?t('preview.registry',{registry:operation.registry??defaultNpmRegistry}):'')+
  t('preview.scope',{scope:operation.global?operation.global.prefix:operation.declaredWrites.join(', ')})+
  (operation.kind==='install'&&operation.query.integrity?t('preview.integrity',{integrity:operation.query.integrity}):'');
}

function fileDetails(data:PreviewData):string {
 const mode=(value:number|undefined)=>value===undefined?t('preview.absent'):value.toString(8).padStart(4,'0');
 const lines=data.preview.items.flatMap(item=>[
  terminalText(t(`preview.action.${item.action}`)+' '+item.target+(item.reason?' — '+terminalReason(item.reason):'')),
  ...(item.beforeMode!==item.afterMode?[t('preview.mode',{before:mode(item.beforeMode),after:mode(item.afterMode)})]:[]),
  ...(item.before===undefined?[]:[t('preview.before'),terminalText(item.before,true)]),
  ...(item.after===undefined?[]:[t('preview.after'),terminalText(item.after,true)]),
 ]);
 return [...lines,...(data.preview.projectDocuments??[]).map(item=>terminalText(t(`preview.action.${item.action}`)+' '+item.target+' — '+terminalReason(item.reason))),
  ...data.preview.operations.map(operation=>t('preview.operation',{detail:terminalText(operationDetails(operation))})),
  ...data.preview.blockers.map(blocker=>t('lifecycle.blocked',{reason:terminalText(terminalReason(blocker))})),
  ...data.preview.warnings.map(warning=>terminalText(warning))].join('\n')+'\n';
}

function previewPaths(data:PreviewData){
 const changes:{action:'Create'|'Update'|'Delete';target:string}[]=[];
 for(const file of data.files){
  const after=file.next===undefined?absentDigest:digest(Buffer.from(file.next,file.encoding));
  if(after===file.observedDigest&&platformFileMode(file.observedMode)===platformFileMode(file.mode))continue;
  const action=after===absentDigest?'Delete':file.observedDigest===absentDigest?'Create':'Update';
  changes.push({action,target:file.target});
 }
 return changes;
}

export function applyReason(report:Record<string,unknown>):string|undefined{
 if(report.phase!=='apply')return;
 const installed=report as unknown as InstallReport;
 const operation=installed.operations.find(result=>result.status!=='done');
 if(operation)return operation.message;
 const check=installed.checks.find(result=>result.status==='failed')??installed.checks.find(result=>result.status==='pending');
 if(!check)return;
 const diagnostic=check.diagnostic;
 return check.name+' '+check.status+(check.message?' — '+check.message:diagnostic?' — '+diagnostic.rule+' at '+diagnostic.path:'');
}

export function createCliOutput(options:{
 write:(text:string)=>void;verbose:boolean;json:boolean;stateRoot?:string;
 stage?:(label:string,waiting:boolean)=>void;stop?:()=>void;
}){
 const {write,verbose,json,stateRoot}=options;
 const state:{
  root?:string;data?:PreviewData;restoredPreview?:boolean;native?:NativeResult;nativeEffects?:NativeSetupEffects;
  sessionsEnded?:boolean;nativeTTY?:boolean;superpowersGate?:{requirement:SetupRequirement;canPrepare:boolean};openSpecNext?:readonly string[];
  applyId?:string;error?:string;note?:string;details?:string;
 }={};
 const seen=new Set<string>();
 const stageLabels:Partial<Record<RunProgressEvent['stage'],MessageKey>>={
  detect:'stage.detect',research:'stage.research',generation:'stage.generation',preview:'stage.preview',apply:'stage.apply',
 };
 const presentation:LifecyclePresentation={
  progress(event){
   const key=stageLabels[event.stage];
   const label=key?t(key):event.stage;
   if(options.stage)options.stage(label,!!event.requiresUserAction||event.status==='complete'||event.status==='failed');
   else if(!seen.has(event.stage)){seen.add(event.stage);write(label+'…\n');}
  },
  async preview(data,options){
   state.data=data;
   state.restoredPreview=options?.restored;
   const details=fileDetails(data);
   try{
    const root=await privateDirectory(join(stateRoot??defaultStateRoot(),'details'),data.plan.root);
    const path=join(root,data.preview.previewId+'-'+randomUUID()+'.log');
    await saveCache(path,details);state.details=path;
   }catch{/* A preview can proceed if private details are unavailable. */}
   if(!json&&!state.superpowersGate){
    const changes=previewPaths(data);
    write(t('lifecycle.preview',{id:data.preview.previewId})+'\n');
    for(const action of ['Create','Update','Delete'] as const){
     const paths=changes.filter(change=>change.action===action);
     if(paths.length)write(t('preview.fileCount',{action:t(`preview.action.${action}`),count:paths.length})+'\n');
    }
    const actions=['Create','Update','Delete'];
    const sorted=changes.sort((a,b)=>actions.indexOf(a.action)-actions.indexOf(b.action)||a.target.localeCompare(b.target));
    const shown=state.details?sorted.slice(0,15):sorted;
    for(const change of shown)write('  '+t(`preview.action.${change.action}`)+' '+terminalText(change.target)+'\n');
    if(shown.length<sorted.length)write('  '+t('preview.more',{count:sorted.length-shown.length})+'\n');
    for(const operation of data.preview.operations)write('  '+terminalText(operationDetails(operation))+'\n');
    if(data.preview.executable)write(t('preview.applyMetadata')+'\n');
    write((state.details?t('preview.details',{path:terminalText(state.details)}):t('preview.detailsUnavailable'))+'\n');
   }
   if(verbose&&!state.superpowersGate)write(details);
  },
  superpowersGate(requirement,canPrepare){
   if(state.nativeTTY===false)state.superpowersGate={requirement,canPrepare};
  },
  applying(id){state.applyId=id;},
  notice(text){state.note=text;},
 };
 function recordNativeEffects(effects:NativeSetupEffects){
  const prior=state.nativeEffects;
  state.nativeEffects=prior?{
   projectChanges:[...prior.projectChanges,...effects.projectChanges],
   uncertainProjectPaths:[...prior.uncertainProjectPaths,...effects.uncertainProjectPaths],
   reloadRecommended:prior.reloadRecommended||effects.reloadRecommended,
  }:effects;
 }
 function writeNativeChanges(root:string){
  const changes=state.nativeEffects?.projectChanges??[];
  const uncertain=state.nativeEffects?.uncertainProjectPaths??[];
  if(changes.length)write(t('result.nativeProjectChanges')+'\n');
  if(uncertain.length)write(t('result.nativeProjectUncertain')+'\n');
  for(const path of new Set([...changes.map(change=>change.path),...uncertain])){
   write('  '+terminalText(relative(root,path))+'\n');
   const observed=changes.filter(change=>change.path===path);
   for(const command of new Set(observed.flatMap(change=>change.undo?[change.undo]:[]))){
    write('    '+t('result.nativeProjectUndo',{command:terminalText(command)})+'\n');
   }
   if(observed.some(change=>change.marketplaceAdded))write('    '+t('result.nativeMarketplaceUndo')+'\n');
  }
 }
 async function finish(code:number,report:Record<string,unknown>){
  options.stop?.();
  const root=state.root;
  if(!root)return;
  const install=report.phase==='apply'?report as unknown as InstallReport:undefined;
  const complete=install?.status==='complete';
  const writeReload=async()=>{
   if((complete||state.native?.ready||state.nativeEffects?.reloadRecommended)&&
      await sessionReloadNotice(root,state.sessionsEnded).catch(()=>undefined))write(t('cli.restartHost')+'\n');
  };
  const gate=code===3?state.superpowersGate:undefined;
  const gateReason=gate?.canPrepare?t('result.superpowersMissing'):undefined;
  const writeGateDetails=()=>{
   if(gate&&verbose&&state.data)write(fileDetails(state.data));
  };
  if(json){
   await writeReload();
   if(gateReason&&verbose&&gate?.requirement.nextCommand){
    write(t('result.reason',{reason:gateReason})+'\n');
    write(t('result.next',{command:terminalText(gate.requirement.nextCommand)})+'\n');
   }
   writeGateDetails();
   return;
  }
  if(report.phase==='native-preparation'){
   const label=code===130?'result.cancelled':code===3?'result.needsAction':code===1?'result.nativeFailed':
    report.installStatus==='not-applicable'?'result.nativePreview':report.installStatus==='up-to-date'?'result.nativeReady':'result.nativeComplete';
   write('\n'+t('result.heading',{label:t(label)})+'\n');
   if(code!==0)writeNativeChanges(root);
   await writeReload();
   return;
  }
  const savedPreview=code===3&&report.phase==='handoff'&&report.executable===true&&!state.restoredPreview;
  const dryPreview=code===0&&report.phase==='preview'&&report.executable===true&&report.installStatus==='not-installed';
  const generated=savedPreview||dryPreview;
  const result=code===130?'result.cancelled':complete?(code===0?'result.installComplete':'result.installAttention'):
   state.native?.installed&&!state.native.ready?'result.openSpecPartial':state.applyId&&!install?'result.installUnverified':
   generated?'result.previewGenerated':
   code===1||code===2?'result.notInstalled':code===3?'result.needsAction':report.installStatus==='up-to-date'?'result.upToDate':
   report.nativeWorkflow==='ready'?'result.openSpecReady':'result.previewOnly';
  write('\n'+t('result.heading',{label:t(result)})+'\n');
  const nativeChanges=state.nativeEffects?.projectChanges.length||state.nativeEffects?.uncertainProjectPaths.length;
  if(!state.native&&!state.applyId&&!state.restoredPreview&&!nativeChanges)write(t('result.noWrites')+'\n');
  if(!complete||code===130)writeNativeChanges(root);
  if(state.native){
   const native=state.native;
   if(native.ready)write(t('result.openSpecEntries',{version:terminalText(native.version??'CLI')})+'\n');
   else if(native.installed)write(t('result.openSpecInstalled',{version:terminalText(native.version??''),prefix:terminalText(native.prefix??'')})+
    t(native.receiptFailed?'result.receiptNotSaved':'result.projectChangesPossible')+'\n');
   else write(t('result.openSpecStarted')+'\n');
  }
  if(state.applyId){
   if(install)write(t('result.changedTargets',{count:install.written.length})+'\n');
   if(install?.runtimeSetup?.template.state==='written')write(t('result.envUpdated')+'\n');
   for(const operation of install?.operations??[])if(operation.status==='done'&&operation.globalReceipt)write(terminalText(operation.message)+'\n');
   if(install?.operations.some(operation=>operation.status==='done'))write(t('result.operationsVerified')+'\n');
   if(!complete)write(t('result.installChangesPossible')+'\n');
  }
  if(state.restoredPreview&&!state.applyId)write(t('result.installChangesPossible')+'\n');
  await writeReload();
  if(code===130)return;

  const applyIssue=applyReason(report);
  const toolWait=install&&code===3&&state.data?.plan.pendingRuntimeTools?.length
   ?t('result.toolWait',{tools:state.data.plan.pendingRuntimeTools.join(', '),reason:install.runtimeSetup?.template.reason??''}):undefined;
  const researchNext=report.phase==='research'&&report.noChanges===true&&report.projectRules==='pending'&&typeof report.researchNextStep==='string'
   ?t('lifecycle.rulesNext',{agentStep:t('cli.openAgent')}):undefined;
  let next:string|undefined;
  if(state.applyId&&!complete&&await interruptedApplyId(root,stateRoot??defaultStateRoot()).catch(()=>undefined)===state.applyId){
   next='rigup update '+quoteShell(root)+' --resume --review';
  }else if(install&&(applyIssue||toolWait)){
   next='rigup doctor '+quoteShell(root);
  }else if(typeof report.nextCommand==='string'){
   next=complete&&report.projectRules==='pending'&&report.researchNextStep&&!report.sourceReview
    ?t('cli.openAgent'):report.nextCommand;
  }else if(typeof report.resumeCommand==='string'){
   next=report.resumeCommand;
  }else if(typeof report.researchNextStep==='string'){
   next=researchNext??report.researchNextStep;
  }else if((code===1||code===3)&&!generated)next='rigup doctor '+quoteShell(root);

  const blockers=report.blockers as string[]|undefined;
  const pending=Array.isArray(report.pending)?report.pending[0]:undefined;
  const known=typeof pending==='string'?pending:pending?.reason;
  const reviewWait=install?.sourceReview?t('result.reviewWait'):undefined;
  const reason=state.error??applyIssue??toolWait??reviewWait??(typeof report.error==='string'?report.error:undefined)??gateReason??blockers?.[0]??
   (typeof report.requestPath==='string'?t(report.phase==='generation'?'result.pendingGeneration':'result.pendingResearch',{path:report.requestPath}):undefined)??
   (typeof known==='string'?known:undefined)??(typeof report.message==='string'?report.message:undefined)??
   researchNext??(code===1||code===2||code===3?state.note:undefined);
  const commands=(state.openSpecNext??(next?[next]:[])).map(command=>terminalText(terminalReason(command.trim())));
  const reasonText=reason&&terminalText(terminalReason(reason.trim().split('\n')[0]));
  if(!generated&&reasonText&&!(commands.length===1&&commands[0]===reasonText))write(t('result.reason',{reason:reasonText})+'\n');
  if(commands.length===1)write(t('result.next',{command:commands[0]})+'\n');
  if(commands.length>1){
   write(t('result.nextHeading')+'\n');
   for(const [index,command] of commands.entries())write('  '+(index+1)+'. '+command+'\n');
  }
  writeGateDetails();
 }
 return {state,presentation,finish,recordNativeEffects,verbose,json};
}
