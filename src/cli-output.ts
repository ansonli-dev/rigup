import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {digest} from './analyzer/evidence.js';
import {privateDirectory,saveCache} from './generator/cache.js';
import {interruptedApplyId,type InstallReport} from './installer/apply.js';
import {absentDigest,platformFileMode} from './installer/file-state.js';
import {defaultStateRoot} from './installer/lock.js';
import type {PreviewData} from './installer/preview.js';
import {defaultNpmRegistry} from './integrations/tools/npm-resolution.js';
import {quoteShell} from './shell-command.js';
import type {RunProgressEvent} from './progress.js';

export interface LifecyclePresentation {
 progress(event:RunProgressEvent):void;
 preview(data:PreviewData):Promise<void>;
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

function operationDetails(operation:PreviewData['preview']['operations'][number]):string {
 return operation.id+' '+operation.query.name+'@'+operation.version+
  (operation.kind==='install'?' registry '+(operation.registry??defaultNpmRegistry):'')+
  ' scope '+(operation.global?operation.global.prefix:operation.declaredWrites.join(', '))+
  (operation.kind==='install'&&operation.query.integrity?' integrity '+operation.query.integrity:'');
}

function fileDetails(data:PreviewData):string {
 const mode=(value:number|undefined)=>value===undefined?'absent':value.toString(8).padStart(4,'0');
 const lines=data.preview.items.flatMap(item=>[
  terminalText(item.action+' '+item.target+(item.reason?' — '+item.reason:'')),
  ...(item.beforeMode!==item.afterMode?['mode '+mode(item.beforeMode)+' -> '+mode(item.afterMode)]:[]),
  ...(item.before===undefined?[]:['--- owned before (filtered)',terminalText(item.before,true)]),
  ...(item.after===undefined?[]:['+++ owned after (filtered)',terminalText(item.after,true)]),
 ]);
 return [...lines,...(data.preview.projectDocuments??[]).map(item=>terminalText(item.action+' '+item.target+' — '+item.reason)),
  ...data.preview.operations.map(operation=>'operation '+terminalText(operationDetails(operation))),
  ...data.preview.blockers.map(blocker=>'Blocked: '+terminalText(blocker)),
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
 const state:{root?:string;data?:PreviewData;native?:NativeResult;applyId?:string;error?:string;note?:string;details?:string}={};
 const seen=new Set<string>();
 const stageLabels:Record<string,string>={detect:'Detect',research:'Research',generation:'Generate',preview:'Prepare preview',apply:'Install'};
 const presentation:LifecyclePresentation={
  progress(event){
   const label=stageLabels[event.stage]??event.stage;
   if(options.stage)options.stage(label,!!event.requiresUserAction||event.status==='complete'||event.status==='failed');
   else if(!seen.has(event.stage)){seen.add(event.stage);write(label+'…\n');}
  },
  async preview(data){
   state.data=data;
   const details=fileDetails(data);
   try{
    const root=await privateDirectory(join(stateRoot??defaultStateRoot(),'details'),data.plan.root);
    const path=join(root,data.preview.previewId+'-'+randomUUID()+'.log');
    await saveCache(path,details);state.details=path;
   }catch{/* A preview can proceed if private details are unavailable. */}
   if(!json){
    const changes=previewPaths(data);
    write('Preview '+data.preview.previewId+'\n');
    for(const action of ['Create','Update','Delete'] as const){
     const paths=changes.filter(change=>change.action===action);
     if(paths.length)write(action+' '+paths.length+' file(s)\n');
    }
    const actions=['Create','Update','Delete'];
    const sorted=changes.sort((a,b)=>actions.indexOf(a.action)-actions.indexOf(b.action)||a.target.localeCompare(b.target));
    const shown=state.details?sorted.slice(0,15):sorted;
    for(const change of shown)write('  '+change.action+' '+terminalText(change.target)+'\n');
    if(shown.length<sorted.length)write('  '+(sorted.length-shown.length)+' more\n');
    for(const operation of data.preview.operations)write('  '+terminalText(operationDetails(operation))+'\n');
    if(data.preview.executable)write('Apply can also update .rigup/.env and installation metadata.\n');
    write(state.details?'Details: '+terminalText(state.details)+'\n':'Details unavailable. Use --verbose to inspect the preview.\n');
   }
   if(verbose)write(details);
  },
  applying(id){state.applyId=id;},
  notice(text){state.note=text;},
 };
 async function finish(code:number,report:Record<string,unknown>){
  options.stop?.();
  const root=state.root;
  if(json||!root)return;
  if(report.phase==='native-preparation'){
   const label=code===130?'Cancelled':code===3?'Needs action':code===1?'Preparation failed':
    report.installStatus==='not-applicable'?'Native preparation preview':report.installStatus==='up-to-date'?'Native workflow already ready':'Native preparation complete';
   write('\nResult: '+label+'\n');return;
  }
  const install=report.phase==='apply'?report as unknown as InstallReport:undefined;
  const complete=install?.status==='complete';
  const result=code===130?'Cancelled':complete?(code===0?'Install complete':'Install complete, needs attention'):
   state.native?.installed&&!state.native.ready?'OpenSpec partially prepared':state.applyId&&!install?'Installation outcome unverified':
   code===1||code===2?'Not installed':code===3?'Needs action':report.installStatus==='up-to-date'?'Up to date':
   report.nativeWorkflow==='ready'?'OpenSpec ready':'Preview only';
  write('\nResult: '+result+'\n');
  const preparation=report.nativePreparation as {kind?:string;progress?:{step?:string;status?:string}[]}|undefined;
  const nativeChanges=preparation?.kind==='superpowers'&&preparation.progress?.some(item=>item.step||item.status==='uncertain');
  if(!state.native&&!state.applyId&&!nativeChanges)write('Nothing was written to the project.\n');
  if(state.native){
   const native=state.native;
  if(native.ready)write('OpenSpec '+terminalText(native.version??'CLI')+' and selected project entries are ready.\n');
  else if(native.installed)write('OpenSpec CLI '+terminalText(native.version??'')+' installed and verified in '+terminalText(native.prefix??'')+'.'
    +(native.receiptFailed?' Its receipt was not saved.':' Some project changes may have been written.')+'\n');
  else write('OpenSpec preparation started. Some changes may have been written.\n');
  }
  if(state.applyId){
   if(install)write(install.written.length+' managed project target(s) changed.\n');
   if(install?.runtimeSetup?.template.state==='written')write('.rigup/.env updated.\n');
   for(const operation of install?.operations??[])if(operation.status==='done'&&operation.globalReceipt)write(terminalText(operation.message)+'\n');
   if(install?.operations.some(operation=>operation.status==='done'))write('Completed or previously installed tool operations verified.\n');
   if(!complete)write('Some installation changes may have been written.\n');
  }
  const blockers=report.blockers as string[]|undefined;
  const pending=Array.isArray(report.pending)?report.pending[0]:undefined;
  const known=typeof pending==='string'?pending:pending?.reason;
  const toolWait=install&&code===3&&state.data?.plan.pendingRuntimeTools?.length
   ?'Tool installation pending for '+state.data.plan.pendingRuntimeTools.join(', ')+'. '+(install.runtimeSetup?.template.reason??''):undefined;
  const reviewWait=install?.sourceReview?'Approved rule sources changed. Review current sources before relying on project rules.':undefined;
  const reason=state.error??applyReason(report)??toolWait??reviewWait??(typeof report.error==='string'?report.error:undefined)??blockers?.[0]??
   (typeof report.requestPath==='string'?'Pending host '+(report.phase==='generation'?'generation':'research')+': '+report.requestPath:undefined)??
   (typeof known==='string'?known:undefined)??(typeof report.message==='string'?report.message:undefined)??
   (code===1||code===2||code===3?state.note?.trim().split('\n')[0]:undefined);
  if(reason&&code!==130)write('Reason: '+terminalText(reason.trim().split('\n')[0])+'\n');
  if(code===130)return;
  let next:string|undefined;
  if(state.applyId&&!complete&&await interruptedApplyId(root,stateRoot??defaultStateRoot()).catch(()=>undefined)===state.applyId){
   next='rigup update '+quoteShell(root)+' --resume --review';
  }else if(install&&(applyReason(report)||toolWait)){
   next='rigup doctor '+quoteShell(root);
  }else if(typeof report.nextCommand==='string'){
   next=complete&&report.projectRules==='pending'&&report.researchNextStep&&!report.sourceReview
    ?'Open a selected agent and call rigup_begin with the project root.':report.nextCommand;
  }else if(typeof report.resumeCommand==='string'){
   next=report.resumeCommand;
  }else if(typeof report.researchNextStep==='string'){
   next=report.researchNextStep;
  }else if(code===1||code===3)next='rigup doctor '+quoteShell(root);
  if(next)write('Next: '+terminalText(next)+'\n');
 }
 return {state,presentation,finish};
}
