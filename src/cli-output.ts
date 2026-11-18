import {randomUUID} from 'node:crypto';
import {join,relative} from 'node:path';
import {digest} from './analyzer/evidence.js';
import {privateDirectory,saveCache} from './generator/cache.js';
import {interruptedApplyId,type InstallReport} from './installer/apply.js';
import type {Diagnostic} from './installer/doctor.js';
import {formatDoctorLabel,formatDoctorReason} from './i18n/doctor.js';
import {absentDigest,platformFileMode} from './installer/file-state.js';
import {defaultStateRoot} from './installer/lock.js';
import {previewReasonDetails,type Preview,type PreviewData} from './installer/preview.js';
import {sessionReloadNotice} from './installer/session.js';
import type {NativeSetupEffects} from './integrations/host-setup/index.js';
import type {OpenSpecInspection} from './integrations/sdd/openspec-setup.js';
import type {SetupOptions,SetupRequirement} from './types.js';
import {agents} from './integrations/agents/index.js';
import {defaultNpmRegistry} from './integrations/tools/npm-resolution.js';
import {quoteShell} from './shell-command.js';
import {t,translate,type MessageKey} from './i18n/index.js';
import {nextStepReasonDetail,reasonCodes,reasonDetail,renderReason,type ReasonInput,type ReasonedReport} from './i18n/reasons.js';
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

export function writeDoctor(report:InstallReport&{diagnostics:Diagnostic[]},write:(text:string,english?:string)=>void,
 options:{verbose:boolean;json:boolean;projectArgument?:string}):void{
 const detailed=options.verbose||options.json;
 const attention=report.diagnostics.filter(({state})=>state==='failed'||state==='pending'||state==='reload-required');
 if(options.json&&report.nextCommand)write(report.nextCommand+'\n');
 if(!options.json)write(t('doctor.summary',{ready:report.diagnostics.length-attention.length,attention:attention.length})+'\n');
 for(const diagnostic of detailed?report.diagnostics:attention){
  const {category,state}=diagnostic;
  write(t(`doctor.category.${category}`)+' '+formatDoctorLabel(diagnostic,options.verbose)+': '+t(`status.${state}`)+' — '+formatDoctorReason(diagnostic)+'\n');
 }
 for(const {name,status,startedAt,commit} of report.checks){
  const params={name,status,time:startedAt??'',commit:commit??''};
  write(t('doctor.check',{...params,status:t(`status.${status}`)})+'\n',translate('en','doctor.check',params)+'\n');
 }
 if(options.json)return;
 const project=options.projectArgument?' '+quoteShell(options.projectArgument):'';
 const next=report.nextCommand??(
  attention.some(({state})=>state==='failed')?t('doctor.fixFailed'):
  report.projectRules==='pending'?'rigup update'+project+' --review':
  attention.some(({category,state})=>category==='environment'&&state==='pending')?t('doctor.fixEnvironment'):
  attention.some(({state})=>state==='reload-required')?t('doctor.reloadAgents'):
  attention.length?t('doctor.fixPending'):undefined);
 if(next)write(t('result.next',{command:terminalText(next)})+'\n');
}

function operationDetails(operation:PreviewData['preview']['operations'][number]):string {
 return operation.id+' '+operation.query.name+'@'+operation.version+
  (operation.kind==='install'?t('preview.registry',{registry:operation.registry??defaultNpmRegistry}):'')+
  t('preview.scope',{scope:operation.global?operation.global.prefix:operation.declaredWrites.join(', ')})+
  (operation.kind==='install'&&operation.query.integrity?t('preview.integrity',{integrity:operation.query.integrity}):'');
}

const savedPreviewReasonKeys=new Map(reasonCodes.filter(code=>code.startsWith('preview.')).map(code=>[translate('en',code),code]));
function savedPreviewReason(reason:string):string{
 const key=savedPreviewReasonKeys.get(reason);
 return key?t(key):reason;
}

function fileDetails(preview:Preview):string {
 const details=preview[previewReasonDetails];
 const itemReason=(reason:string,detail?:ReasonInput)=>detail!==undefined?renderReason(detail):details?reason:savedPreviewReason(reason);
 const mode=(value:number|undefined)=>value===undefined?t('preview.absent'):value.toString(8).padStart(4,'0');
 const lines=preview.items.flatMap((item,index)=>[
  terminalText(t(`preview.action.${item.action}`)+' '+item.target+(item.reason?' — '+itemReason(item.reason,details?.items[index]):'')),
  ...(item.beforeMode!==item.afterMode?[t('preview.mode',{before:mode(item.beforeMode),after:mode(item.afterMode)})]:[]),
  ...(item.before===undefined?[]:[t('preview.before'),terminalText(item.before,true)]),
  ...(item.after===undefined?[]:[t('preview.after'),terminalText(item.after,true)]),
 ]);
 return [...lines,...(preview.projectDocuments??[]).map((item,index)=>terminalText(t(`preview.action.${item.action}`)+' '+item.target+' — '+itemReason(item.reason,details?.projectDocuments[index]))),
  ...preview.operations.map(operation=>t('preview.operation',{detail:terminalText(operationDetails(operation))})),
  ...(details?.blockers??preview.blockers).map(blocker=>t('lifecycle.blocked',{reason:terminalText(renderReason(blocker))})),
  ...preview.warnings.map(warning=>terminalText(warning))].join('\n')+'\n';
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

const previewGroups=['agents','guidance','rigup','other'] as const;
const previewActions=['Create','Update','Delete'] as const;
const hostTargets=Object.values(agents);

function groupPreviewPath(target:string,documents:ReadonlySet<string>):typeof previewGroups[number]{
 if(hostTargets.some(host=>target===host.mcpTarget||target.startsWith(host.skillDirectory+'/')))return 'agents';
 if(documents.has(target)||hostTargets.some(host=>target===host.entry)||target.startsWith('docs/'))return 'guidance';
 return target.startsWith('.rigup/')?'rigup':'other';
}

export function applyReason(report:Record<string,unknown>,localized=false):string|undefined{
 if(report.phase!=='apply')return;
 const installed=report as unknown as InstallReport;
 const operation=installed.operations.find(result=>result.status!=='done');
 if(operation)return localized?renderReason(operation[reasonDetail]??operation.message):operation.message;
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
  standaloneNative?:boolean;
  sessionsEnded?:boolean;nativeTTY?:boolean;superpowersGate?:{requirement:SetupRequirement;canPrepare:boolean};openSpecNext?:readonly string[];
  livePreview?:Preview;doctorJsonError?:string;applyId?:string;error?:ReasonInput;note?:string;details?:string;
 }={};
 const stages=new Map<string,string>();
 const stageLabels:Partial<Record<RunProgressEvent['stage'],MessageKey>>={
  detect:'stage.detect',openspec:'stage.openspec',research:'stage.research',generation:'stage.generation',preview:'stage.preview',apply:'stage.apply',
 };
 const presentation:LifecyclePresentation={
  progress(event){
   const key=stageLabels[event.stage];
   const label=key?t(key):event.stage;
   const first=!stages.has(event.stage);
   if(first)stages.set(event.stage,label);
   if(options.stage)options.stage(label,!!event.requiresUserAction||event.status==='complete'||event.status==='failed');
   else if(first)write(label+'…\n');
  },
  async preview(data,options){
   state.data=data;
   state.details=undefined;
   state.restoredPreview=options?.restored;
   state.livePreview=options?.livePreview;
   const details=fileDetails(options?.livePreview??data.preview);
   try{
    const root=await privateDirectory(join(stateRoot??defaultStateRoot(),'details'),data.plan.root);
    const path=join(root,data.preview.previewId+'-'+randomUUID()+'.log');
    await saveCache(path,details);state.details=path;
   }catch{/* A preview can proceed if private details are unavailable. */}
   if(!json&&!state.superpowersGate){
    const changes=previewPaths(data);
    write((verbose?t('lifecycle.preview',{id:data.preview.previewId}):t('preview.heading'))+'\n');
    if(data.preview.claim)write(t('preview.claim',{agents:data.preview.claim.agents.join(', ')})+'\n');
    const documents=new Set(data.preview.projectDocuments?.map(item=>item.target));
    for(const group of previewGroups){
     const paths=changes.filter(change=>groupPreviewPath(change.target,documents)===group);
     const counts=previewActions.flatMap(action=>{
      const count=paths.filter(change=>change.action===action).length;
      return count?[t(count===1?'preview.oneFile':'preview.fileCount',{action:t(`preview.action.${action}`),count})]:[];
     });
     if(counts.length)write(t('preview.group',{category:t(`preview.category.${group}`),counts:counts.join(' · ')})+'\n');
    }
    if(verbose||!state.details)for(const change of changes)write('  '+t(`preview.action.${change.action}`)+' '+terminalText(change.target)+'\n');
    for(const operation of data.preview.operations)write('  '+terminalText(operationDetails(operation))+'\n');
    if(data.preview.executable&&!data.preview.claim)write(t('preview.applyMetadata')+'\n');
    const detailNotice=!state.details?t('preview.detailsUnavailable'):
     verbose?t('preview.details',{path:terminalText(state.details)}):t('preview.detailHint');
    write(detailNotice+'\n');
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
 async function finish(code:number,report:ReasonedReport){
  options.stop?.();
  const root=state.root;
  if(!root)return;
  const install=report.phase==='apply'?report as unknown as InstallReport:undefined;
  const complete=install?.status==='complete';
  const writeReload=async()=>{
   if(!state.standaloneNative&&(complete||state.native?.ready||state.nativeEffects?.reloadRecommended)&&
      await sessionReloadNotice(root,state.sessionsEnded).catch(()=>undefined))write(t('cli.restartHost')+'\n');
  };
  const gate=code===3?state.superpowersGate:undefined;
  const gateReason=gate?.canPrepare?t('result.superpowersMissing'):undefined;
  const writeGateDetails=()=>{
   if(gate&&verbose&&state.data)write(fileDetails(state.livePreview??state.data.preview));
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
  if(stages.size>1)write(t('stage.summary',{stages:[...stages.values()].join(' → ')})+'\n');
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

  const applyIssue=applyReason(report,true);
  const toolWait=install&&code===3&&state.data?.plan.pendingRuntimeTools?.length
   ?t('result.toolWait',{tools:state.data.plan.pendingRuntimeTools.join(', '),reason:renderReason(install.runtimeSetup?.template[reasonDetail]??install.runtimeSetup?.template.reason??'')}):undefined;
  const researchNext=report.phase==='research'&&report.noChanges===true&&report.projectRules==='pending'&&typeof report.researchNextStep==='string'
   ?t('lifecycle.rulesNext',{agentStep:t('cli.openAgent')}):undefined;
  let next:string|undefined,nextDetail:ReasonInput|undefined;
  if(state.applyId&&!complete&&await interruptedApplyId(root,stateRoot??defaultStateRoot()).catch(()=>undefined)===state.applyId){
   next='rigup update '+quoteShell(root)+' --resume --review';
  }else if(install&&(applyIssue||toolWait)){
   next='rigup doctor '+quoteShell(root);
  }else if(typeof report.nextCommand==='string'){
   if(complete&&report.projectRules==='pending'&&report.researchNextStep&&!report.sourceReview)next=t('cli.openAgent');
   else {next=report.nextCommand;nextDetail=report[nextStepReasonDetail];}
  }else if(typeof report.resumeCommand==='string'){
   next=report.resumeCommand;
  }else if(typeof report.researchNextStep==='string'){
   next=researchNext??report.researchNextStep;
   if(!researchNext)nextDetail=report[nextStepReasonDetail];
  }else if((code===1||code===3)&&!generated)next='rigup doctor '+quoteShell(root);

  const blockers=report.blockers as string[]|undefined;
  const pending=Array.isArray(report.pending)?report.pending[0]:undefined;
  const known=typeof pending==='string'?pending:pending?.reason;
  const reviewWait=install?.sourceReview?t('result.reviewWait'):undefined;
  const reason=state.error??applyIssue??toolWait??reviewWait??gateReason??report[reasonDetail]??(typeof report.error==='string'?report.error:undefined)??blockers?.[0]??
   (typeof report.requestPath==='string'?t(report.phase==='generation'?'result.pendingGeneration':'result.pendingResearch',{path:report.requestPath}):undefined)??
   (typeof known==='string'?known:undefined)??(typeof report.message==='string'?report.message:undefined)??
   researchNext??(code===1||code===2||code===3?state.note:undefined);
  const commands=(state.openSpecNext??(next?[renderReason(nextDetail??next)]:[])).map(command=>terminalText(command.trim()));
  const reasonText=reason&&terminalText(renderReason(reason).trim().split('\n')[0]);
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
