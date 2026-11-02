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
