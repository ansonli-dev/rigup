export interface ProgressEvent {stage:string; completed:number; total?:number; next?:string; waiting?:string; estimateMs?:number; allStagesKnown?:boolean}
export function createProgress(clock:()=>number=Date.now): (event:ProgressEvent)=>string {
 const start=clock();
 return event => {
  const elapsed=Math.max(0,clock()-start);
  const count=event.total === undefined ? String(event.completed) : `${event.completed}/${event.total}`;
  const eta=event.allStagesKnown && event.estimateMs !== undefined && elapsed < event.estimateMs
   ? `${Math.ceil((event.estimateMs-elapsed)/1000)}s` : '待估算';
  return `${event.stage} ${count} 已用 ${Math.floor(elapsed/1000)}s；整体进度待估算；ETA ${eta}`+
   (event.waiting ? `；等待 ${event.waiting}` : '')+(event.next ? `；下一步 ${event.next}` : '');
 };
}

export interface RunProgressEvent extends ProgressEvent {task?:string;unit?:string;status?:'running'|'complete'|'failed'|'retry'|'waiting'|'reused';requiresUserAction?:boolean;planVersion?:number;eta?:{minMs:number;maxMs:number;basis:string};attempt?:number;retryLimit?:number}
export function createProgressReporter(options:{runId:string;phases:string[];isTTY:boolean;write:(text:string)=>void;clock?:()=>number}) {
 const clock=options.clock??Date.now,start=clock();let lastEmit=start,lastProgress=start,failed=false;let current:RunProgressEvent|undefined;let etaAt=start;
 const render=(live=false,changed?:string)=>{
  if(!current)return;const now=clock(),index=options.phases.indexOf(current.stage);const count=current.total===undefined?String(current.completed):current.completed+'/'+current.total;
  const human=current.requiresUserAction;const canEstimate=current.eta&&current.allStagesKnown&&!human&&current.status!=='retry'&&!failed&&now-etaAt<current.eta.maxMs;
  const eta=canEstimate?Math.max(0,Math.ceil((current.eta!.minMs-(now-etaAt))/1000))+'–'+Math.max(0,Math.ceil((current.eta!.maxMs-(now-etaAt))/1000))+'s ('+current.eta!.basis+')':'待估算';
  const state=failed?'失败/仍有失败项':human?'等待人工处理':current.status==='reused'?'复用已核验项':current.status==='retry'?'有限重试':current.status==='complete'?'本阶段完成':live?'仍在运行':current.status??'running';
  options.write('阶段 '+(index>=0?String(index+1)+'/'+options.phases.length:'待确定')+' '+current.stage+(current.task?' / '+current.task:'')+' '+count+'；'+state+'；已用 '+Math.floor((now-start)/1000)+'s；整体 ETA '+eta+(changed?'；清单变更 '+changed:'')+(current.waiting?'；等待 '+current.waiting:'')+(now-lastProgress>=60000?'；'+Math.floor((now-lastProgress)/1000)+'s 无有效进展，等待对象 '+(current.waiting??current.task??current.stage):'')+(current.next?'；下一步 '+current.next:'')+'\n');lastEmit=now;
 };
 return {
  event:(event:RunProgressEvent)=>{
   if(event.status==='retry'&&(event.attempt??0)>(event.retryLimit??0))throw new Error('retry limit exhausted');
   const now=clock();const same=current?.stage===event.stage&&current?.unit===event.unit;const changed=same&&current?.total!==undefined&&event.total!==undefined&&current.total!==event.total?current.total+' → '+event.total:undefined;
   if(!same||event.completed>(current?.completed??0)||event.task!==current?.task||event.status==='complete'||event.status==='reused')lastProgress=now;
   if(event.status==='failed')failed=true;
   current={...event};if(event.status==='retry'||event.requiresUserAction)delete current.eta;etaAt=now;render(false,changed);
  },
  tick:()=>{if(current&&clock()-lastEmit>=(options.isTTY?10000:30000))render(true);}
 };
}
