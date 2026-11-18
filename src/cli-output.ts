import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {digest} from './analyzer/evidence.js';
import {privateDirectory,saveCache} from './generator/cache.js';
import {interruptedApplyId,type InstallReport} from './installer/apply.js';
import type {Diagnostic} from './installer/doctor.js';
import {formatDoctorLabel,formatDoctorReason} from './i18n/doctor.js';
import {absentDigest,platformFileMode} from './installer/file-state.js';
import {defaultStateRoot} from './installer/lock.js';
import {previewReasonDetails,type Preview,type PreviewData} from './installer/preview.js';
import {defaultNpmRegistry} from './integrations/tools/npm-resolution.js';
import {quoteShell} from './shell-command.js';
import {t,translate,type MessageKey} from './i18n/index.js';
import {nextStepReasonDetail,reasonCodes,reasonDetail,renderReason,type ReasonInput,type ReasonedReport} from './i18n/reasons.js';
import type {RunProgressEvent} from './progress.js';

export interface LifecyclePresentation {
 progress(event:RunProgressEvent):void;
 preview(data:PreviewData,options?:{livePreview?:Preview;restored?:boolean}):Promise<void>;
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

export function writeDoctor(report:InstallReport&{diagnostics:Diagnostic[]},write:(text:string,english?:string)=>void,verbose=false):void{
 if(report.nextCommand)write(report.nextCommand+'\n');
 for(const diagnostic of report.diagnostics){
  const {category,state}=diagnostic;
  write(t(`doctor.category.${category}`)+' '+formatDoctorLabel(diagnostic,verbose)+': '+t(`status.${state}`)+' — '+formatDoctorReason(diagnostic)+'\n');
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
 const state:{root?:string;data?:PreviewData;native?:NativeResult;applyId?:string;error?:ReasonInput;doctorJsonError?:string;note?:string;details?:string}={};
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
   const details=fileDetails(options?.livePreview??data.preview);
   try{
    const root=await privateDirectory(join(stateRoot??defaultStateRoot(),'details'),data.plan.root);
    const path=join(root,data.preview.previewId+'-'+randomUUID()+'.log');
    await saveCache(path,details);state.details=path;
   }catch{/* A preview can proceed if private details are unavailable. */}
   if(!json){
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
   if(verbose)write(details);
  },
  applying(id){state.applyId=id;},
  notice(text){state.note=text;},
 };
 async function finish(code:number,report:ReasonedReport){
  options.stop?.();
  const root=state.root;
  if(json||!root)return;
  if(report.phase==='native-preparation'){
   const label=code===130?'result.cancelled':code===3?'result.needsAction':code===1?'result.nativeFailed':
    report.installStatus==='not-applicable'?'result.nativePreview':report.installStatus==='up-to-date'?'result.nativeReady':'result.nativeComplete';
   write('\n'+t('result.heading',{label:t(label)})+'\n');return;
  }
  const install=report.phase==='apply'?report as unknown as InstallReport:undefined;
  const complete=install?.status==='complete';
  const result=code===130?'result.cancelled':complete?(code===0?'result.installComplete':'result.installAttention'):
   state.native?.installed&&!state.native.ready?'result.openSpecPartial':state.applyId&&!install?'result.installUnverified':
   code===1||code===2?'result.notInstalled':code===3?'result.needsAction':report.installStatus==='up-to-date'?'result.upToDate':
   report.nativeWorkflow==='ready'?'result.openSpecReady':'result.previewOnly';
  write('\n'+t('result.heading',{label:t(result)})+'\n');
  const preparation=report.nativePreparation as {kind?:string;progress?:{step?:string;status?:string}[]}|undefined;
  const nativeChanges=preparation?.kind==='superpowers'&&preparation.progress?.some(item=>item.step||item.status==='uncertain');
  if(!state.native&&!state.applyId&&!nativeChanges)write(t('result.noWrites')+'\n');
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
  const blockers=report.blockers as string[]|undefined;
  const pending=Array.isArray(report.pending)?report.pending[0]:undefined;
  const known=typeof pending==='string'?pending:pending?.reason;
  const toolWait=install&&code===3&&state.data?.plan.pendingRuntimeTools?.length
   ?t('result.toolWait',{tools:state.data.plan.pendingRuntimeTools.join(', '),reason:renderReason(install.runtimeSetup?.template[reasonDetail]??install.runtimeSetup?.template.reason??'')}):undefined;
  const reviewWait=install?.sourceReview?t('result.reviewWait'):undefined;
  const reason=state.error??applyReason(report,true)??toolWait??reviewWait??report[reasonDetail]??(typeof report.error==='string'?report.error:undefined)??blockers?.[0]??
   (typeof report.requestPath==='string'?t(report.phase==='generation'?'result.pendingGeneration':'result.pendingResearch',{path:report.requestPath}):undefined)??
   (typeof known==='string'?known:undefined)??(typeof report.message==='string'?report.message:undefined)??
   (code===1||code===2||code===3?state.note?.trim().split('\n')[0]:undefined);
  if(reason&&code!==130)write(t('result.reason',{reason:terminalText(renderReason(reason).trim().split('\n')[0])})+'\n');
  if(code===130)return;
  let next:string|undefined,nextDetail:ReasonInput|undefined;
  if(state.applyId&&!complete&&await interruptedApplyId(root,stateRoot??defaultStateRoot()).catch(()=>undefined)===state.applyId){
   next='rigup update '+quoteShell(root)+' --resume --review';
  }else if(install&&(applyReason(report)||toolWait)){
   next='rigup doctor '+quoteShell(root);
  }else if(typeof report.nextCommand==='string'){
   if(complete&&report.projectRules==='pending'&&report.researchNextStep&&!report.sourceReview)next=t('cli.openAgent');
   else {next=report.nextCommand;nextDetail=report[nextStepReasonDetail];}
  }else if(typeof report.resumeCommand==='string'){
   next=report.resumeCommand;
  }else if(typeof report.researchNextStep==='string'){
   next=report.researchNextStep;nextDetail=report[nextStepReasonDetail];
  }else if(code===1||code===3)next='rigup doctor '+quoteShell(root);
  if(next)write(t('result.next',{command:terminalText(renderReason(nextDetail??next))})+'\n');
 }
 return {state,presentation,finish};
}
