import type {WorkflowTurnResult} from './live-workflow-support.js';

export interface NativeGoalObservedLine {line:string;observedAt:string;workingFiles?:Record<string,string>}
export interface NativeGoalExpected {root:string;objective:string;maxObservedTokens:number}
export interface NativeGoalEvidence {verified:boolean;reasons:string[];threadId?:string;goalId?:string;sqlGoalTokens?:number;diagnostics:string[]}
export interface NativeGoalObservation {observation:WorkflowTurnResult['observation'];nativeGoal:NativeGoalEvidence;rawLines:readonly string[]}

type ObjectValue=Record<string,unknown>;
const object=(value:unknown):ObjectValue|undefined=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as ObjectValue:undefined;
const list=(value:unknown):unknown[]=>Array.isArray(value)?value:[];
const integer=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>=0;
const text=(value:unknown)=>typeof value==='string'?value:'';
const normalizePath=(value:unknown)=>{const path=text(value).replaceAll('\\','/').replace(/\/$/,'');return /^[a-z]:/i.test(path)?path.toLowerCase():path;};
const tokenKeys=['input_tokens','cached_input_tokens','cache_write_input_tokens','output_tokens','reasoning_output_tokens','total_tokens'] as const;
type NativeUsage=Record<(typeof tokenKeys)[number],number>;
function nativeUsage(value:unknown):NativeUsage|undefined{
 const data=object(value);if(!data||!tokenKeys.every(key=>integer(data[key])))return;
 const usage=data as NativeUsage;
 if(usage.cached_input_tokens>usage.input_tokens||usage.cache_write_input_tokens>usage.input_tokens||usage.reasoning_output_tokens>usage.output_tokens||usage.total_tokens<usage.input_tokens+usage.output_tokens)return;
 return usage;
}
const sameUsage=(one:NativeUsage|undefined,two:NativeUsage|undefined)=>!!one&&!!two&&tokenKeys.every(key=>one[key]===two[key]);
const parseObject=(value:string)=>{try{return object(JSON.parse(value));}catch{return undefined;}};
type Invocation={name:string;args?:ObjectValue};
// Only literal tool arguments establish continuation identity. Dynamic JS stays unverified; it is never evaluated.
function scriptInvocations(input:string):Invocation[]{
 const tokens=[...input.matchAll(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|[A-Za-z_$][\w$]*|\d+|[^\s]/g)].map(value=>value[0]).filter(value=>!value.startsWith('//')&&!value.startsWith('/*'));
 const literal=(value:string):unknown=>{
  if(/^\d+$/.test(value))return Number(value);
  if(value.startsWith('"')){try{return JSON.parse(value);}catch{return undefined;}}
  if(/^'(?:[^'\\\r\n]|\\['"\\/bfnrt])*'$/.test(value))return value.slice(1,-1).replace(/\\(.)/g,(_,char:string)=>({b:'\b',f:'\f',n:'\n',r:'\r',t:'\t'}[char]??char));
  return undefined;
 };
 const invocations:Invocation[]=[];
 for(let index=0;index<tokens.length;index++)if(tokens[index]==='tools'&&tokens[index+1]==='.'&&['exec_command','write_stdin'].includes(tokens[index+2])&&tokens[index+3]==='('){
  const name=tokens[index+2],fields:string[][]=[];let field:string[]=[],depth=0,end=-1;
  if(tokens[index+4]==='{')for(let cursor=index+5;cursor<tokens.length;cursor++){
   const token=tokens[cursor];if(token==='}'&&depth===0){fields.push(field);if(tokens[cursor+1]===')')end=cursor+1;break;}
   if(token===','&&depth===0){fields.push(field);field=[];continue;}
   if(['{','[','('].includes(token))depth++;if(['}',']',')'].includes(token))depth--;field.push(token);
  }
  const before=tokens.slice(0,index),after=tokens.slice(end+1);while(after.at(-1)===';')after.pop();
  const direct=before.join(' ')==='text ( await'&&after.join(' ')===')';
  const assigned=before.length===4&&['const','let','var'].includes(before[0])&&/^[A-Za-z_$][\w$]*$/.test(before[1])&&before[2]==='='&&before[3]==='await'&&after.join(' ')==='; text ( '+before[1]+' )';
  const settled=before.join(' ')==='text ( await Promise . allSettled ( ['&&after.join(' ')==='] ) )';
  const args:ObjectValue={};let valid=end>=0&&(direct||assigned||settled)&&!tokens.includes('`');
  for(const field of fields.filter(value=>value.length)){
   const key=/^[A-Za-z_$][\w$]*$/.test(field[0])?field[0]:literal(field[0]);
   if(typeof key!=='string'||field[1]!==':'||Object.hasOwn(args,key)){valid=false;continue;}
   args[key]=field.length===3?literal(field[2]):undefined;
  }
  invocations.push({name,args:valid?args:undefined});
 }
 return invocations;
}
interface CommandOrigin {command:string;callId:string;turnId:string}
interface PendingCommand {origin?:CommandOrigin;turnId:string;sessionId?:number;open:boolean}
interface NativeCall {kind:string;name:string;input:string;done:boolean;turnId:string;origin?:CommandOrigin;sessionId?:number;cellId?:string;commandTool:boolean;invalidContinuation?:boolean}

// Decode only actual tool-result envelopes. Never recursively parse a command's stdout as another command.
function commandResults(value:unknown,cells:string[],depth=0):ObjectValue[]{
 if(depth>12)return [];
 if(typeof value==='string'){
  const running=/^Script running with cell ID ([\w:-]+)(?:\s|$)/.exec(value);if(running){cells.push(running[1]);return [];}
  try{return commandResults(JSON.parse(value),cells,depth+1);}catch{return [];}
 }
 if(Array.isArray(value))return value.flatMap(item=>commandResults(item,cells,depth+1));
 const data=object(value);if(!data)return [];
 if(typeof data.chunk_id==='string'&&data.chunk_id&&typeof data.output==='string')return [data];
 if(data.status==='fulfilled')return commandResults(data.value,cells,depth+1);
 if(['input_text','text'].includes(text(data.type)))return commandResults(data.text,cells,depth+1);
 if(Array.isArray(data.content))return commandResults(data.content,cells,depth+1);
 return [];
}

export function observeNativeGoal(lines:readonly NativeGoalObservedLine[],expected:NativeGoalExpected):NativeGoalObservation{
 const reasons:string[]=[],diagnostics:string[]=[],tools:WorkflowTurnResult['observation']['tools']=[],assistantMessages:string[]=[],rawLines=lines.map(value=>value.line);
 const fail=(reason:string)=>{if(!reasons.includes(reason))reasons.push(reason);};
 const calls=new Map<string,NativeCall>(),responses=new Set<string>(),sessions=new Map<number,PendingCommand>(),cells=new Map<string,PendingCommand>();
 let binding:ObjectValue|undefined,summary:ObjectValue|undefined,driverStart=false,pasted=false,entered=false,session=false,activeGoal=false,nativeActive=false;
 let threadId:string|undefined,goalId:string|undefined,goalState:ObjectValue|undefined,currentTurn:string|undefined,nativeCount=0,ordinal=0,previousArrival=-Infinity,dirtyUsage=false;
 let final:{text:string;turnId:string;index:number;timestamp:number}|undefined,terminal:{turnId:string;text:string;index:number;timestamp:number}|undefined;
 let latestUsage:NativeUsage|undefined,lastGenerationUsage:NativeUsage|undefined,latestCountIndex=-1,lastAssistantIndex=-1,lastModelIndex=-1,lastUsageIndex=-1,sqlGoalTokens:number|undefined;
 const summed=Object.fromEntries(tokenKeys.map(key=>[key,0])) as NativeUsage;
 const sameGoal=(value:ObjectValue|undefined)=>!!value&&value.thread_id===threadId&&value.goal_id===goalId&&value.objective===expected.objective;
 if(!expected.root||!expected.objective||!integer(expected.maxObservedTokens)||expected.maxObservedTokens<1)fail('Invalid expected native goal contract');
 for(const [index,arrival] of lines.entries()){
  const observed=Date.parse(arrival.observedAt);
  if(!Number.isFinite(observed)||observed<previousArrival)fail('Missing or out-of-order root-observed arrival');else previousArrival=observed;
  let record:ObjectValue|undefined;try{record=object(JSON.parse(arrival.line));}catch{/* Retain the original malformed line below. */}
  if(!record){fail('Malformed driver JSON line');continue;}
  if(record.sequence!==index+1)fail('Driver event sequence is incomplete');
  if(summary)fail('Driver events followed its terminal summary');
  if(record.type==='driver_start'){
   if(driverStart||index!==0)fail('Ambiguous driver start');driverStart=true;
   if(normalizePath(record.root)!==normalizePath(expected.root)||record.objective!==expected.objective)fail('Driver root or objective differs');
  }else if(record.type==='goal_paste')pasted=true;
  else if(record.type==='goal_enter'){if(!pasted)fail('Goal enter was not preceded by native command input');entered=true;}
  else if(record.type==='native_binding'){
   if(binding||!entered)fail('Ambiguous or unentered native goal binding');binding=record;threadId=text(record.threadId);goalId=text(record.goalId);
   const meta=object(record.sessionMetadata);
   if(!threadId||!goalId||record.objective!==expected.objective||normalizePath(record.workspace)!==normalizePath(expected.root)||meta?.id!==threadId||normalizePath(meta?.cwd)!==normalizePath(expected.root)||!text(record.rolloutPath))fail('Native binding identity or workspace differs');
  }else if(record.type==='goal_state'){
   const state=object(record.goal);if(!sameGoal(state)){fail('Foreign native goal state');continue;}
   if(!integer(state!.tokens_used)||!integer(state!.updated_at_ms))fail('Native goal state is incomplete');
   if(state!.status==='active'){if(goalState?.status==='complete')fail('Native goal resumed after completion');activeGoal=true;}
   else if(state!.status!=='complete')fail('Native goal is paused, blocked or limited');
   goalState=state;
  }else if(record.type==='native_event'){
   nativeCount++;
   if(!binding||record.threadId!==threadId||record.goalId!==goalId||record.rolloutPath!==binding.rolloutPath)fail('Foreign native event identity');
   const event=object(record.event),payload=object(event?.payload);if(!event){fail('Malformed native event');continue;}
   if(event.ordinal!==ordinal++)fail('Native rollout was truncated or reordered');
   const nativeTime=Date.parse(text(event.timestamp));if(!Number.isFinite(nativeTime))fail('Native event timestamp is missing');
   if(event.type==='session_meta'){
    if(session||payload?.id!==threadId||normalizePath(payload?.cwd)!==normalizePath(expected.root))fail('Foreign or duplicate native session');session=true;
   }else if(event.type==='event_msg'&&payload){
    if(payload.type==='thread_goal_updated'){
     const state=object(payload.goal);
     if(payload.threadId!==threadId||state?.threadId!==threadId||state?.objective!==expected.objective)fail('Foreign native goal update');
     if(state?.status==='active'&&!currentTurn)nativeActive=true;
     if(state&&['paused','blocked','budget_limited','usage_limited'].includes(text(state.status)))fail('Native goal is paused, blocked or limited');
    }else if(payload.type==='task_started'||payload.type==='turn_started'){
     if(currentTurn||!nativeActive)fail('Native turn did not begin under the active goal');currentTurn=text(payload.turn_id);if(!currentTurn)fail('Native turn identity is missing');final=undefined;
    }else if(['task_complete','turn_complete','turn_aborted'].includes(text(payload.type))){
     if(payload.type==='turn_aborted'||!currentTurn||payload.turn_id!==currentTurn)fail('Native turn did not complete for this goal');
     terminal={turnId:text(payload.turn_id),text:text(payload.last_agent_message),index:nativeCount,timestamp:nativeTime};currentTurn=undefined;
    }else if(payload.type==='token_count'){
     const info=object(payload.info),usage=nativeUsage(info?.total_token_usage),last=nativeUsage(info?.last_token_usage);
     if(!usage||!last){if(dirtyUsage||responses.size)fail('Native generation usage is missing');continue;}
     if(!sameUsage(usage,summed))fail('Native cumulative usage does not cover every recorded generation');
     if(dirtyUsage&&lastUsageIndex<=lastModelIndex||!sameUsage(last,lastGenerationUsage))fail('Native output has no fresh generation usage');
     if(latestUsage&&tokenKeys.some(key=>usage[key]<latestUsage![key]))fail('Native cumulative usage decreased');
     latestUsage=usage;latestCountIndex=nativeCount;dirtyUsage=false;
    }
   }else if(event.type==='token_usage_record'){
    const usage=nativeUsage(payload?.usage),cumulative=nativeUsage(payload?.thread_token_usage),responseId=text(payload?.response_id);
    if(!payload||payload.thread_id!==threadId||payload.session_id!==threadId||payload.turn_id!==currentTurn||payload.root_turn_id!==currentTurn)fail('Foreign native generation usage');
    if(!usage||!responseId||responses.has(responseId)){fail('Native generation usage is missing or duplicated');continue;}
    responses.add(responseId);for(const key of tokenKeys)summed[key]+=usage[key];
    if(!nativeUsage(summed)||!sameUsage(cumulative,summed))fail('Native generation totals are incomplete');
    lastUsageIndex=nativeCount;lastGenerationUsage=usage;
   }else if(event.type==='response_item'&&payload){
    if(['function_call','custom_tool_call'].includes(text(payload.type))){
     const id=text(payload.call_id),input=text(payload.input??payload.arguments),name=text(payload.name);dirtyUsage=true;lastModelIndex=nativeCount;
     if(!currentTurn||!id||!input||!name||calls.has(id))fail('Native tool call identity is incomplete or duplicated');
     else{
      const call:NativeCall={kind:text(payload.type),name,input,done:false,turnId:currentTurn,commandTool:['exec','functions.exec','exec_command','functions.exec_command','write_stdin','functions.write_stdin','wait','functions.wait'].includes(name)};
      const isScript=['exec','functions.exec'].includes(name),invocations=isScript?scriptInvocations(input):[{name:name.replace(/^functions\./,''),args:parseObject(input)}],invocation=invocations.length===1?invocations[0]:undefined;
      if(invocation?.name==='wait'){
       const cellId=text(invocation.args?.cell_id),pending=cells.get(cellId);
       if(!pending?.open||pending.turnId!==currentTurn){fail('Native wait has no live cell in this turn');call.invalidContinuation=true;}
       else {call.cellId=cellId;call.origin=pending.origin;call.sessionId=pending.sessionId;}
      }else if(invocation?.name==='write_stdin'){
       const sessionId=invocation.args?.session_id,pending=typeof sessionId==='number'?sessions.get(sessionId):undefined;
       if(!pending?.open||pending.turnId!==currentTurn){fail('Native continuation has no live session in this turn');call.invalidContinuation=true;}
       else {call.sessionId=sessionId as number;call.origin=pending.origin;}
      }else if(invocation?.name==='exec_command'&&typeof invocation.args?.cmd==='string')call.origin={command:invocation.args.cmd,callId:id,turnId:currentTurn};
      else if(invocations.some(value=>value.name==='write_stdin')){fail('Native session continuation is ambiguous');call.invalidContinuation=true;}
      calls.set(id,call);
     }
    }else if(['function_call_output','custom_tool_call_output'].includes(text(payload.type))){
     const id=text(payload.call_id),call=calls.get(id);
     if(!call||call.done||payload.type!==call.kind+'_output'){fail('Native tool output has no matching call');continue;}call.done=true;
     if(call.turnId!==currentTurn){fail('Native tool output crossed its originating turn');continue;}
     if(!call.commandTool){diagnostics.push('Non-command native tool output retained: '+id);continue;}
     if(call.invalidContinuation)continue;
     const runningCells:string[]=[],results=commandResults(payload.output,runningCells);
     for(const cellId of runningCells){
      if(call.cellId?cellId!==call.cellId:cells.has(cellId)){fail('Native cell identity is mismatched or reused');continue;}
      cells.set(cellId,{origin:call.origin,turnId:call.turnId,sessionId:call.sessionId,open:true});
     }
     if(call.cellId&&!runningCells.includes(call.cellId))cells.get(call.cellId)!.open=false;
     if(!results.length&&!runningCells.length)diagnostics.push('No completed command result in native output: '+id);
     for(const result of results){
      const sessionId=result.session_id;
      if(sessionId!==undefined&&(!integer(sessionId)||call.sessionId!==undefined&&sessionId!==call.sessionId)){fail('Native command returned a mismatched session');continue;}
      if(typeof result.exit_code==='number'&&Number.isSafeInteger(result.exit_code)){
       if(call.sessionId!==undefined)sessions.get(call.sessionId)!.open=false;
       if(call.cellId&&!call.origin){diagnostics.push('Native cell command provenance is unknown: '+id);continue;}
       tools.push({type:'command_execution',command:call.origin?.command??call.input,aggregated_output:result.output,exit_code:result.exit_code,callId:id,originCallId:call.origin?.callId??id,chunkId:result.chunk_id,observedAt:arrival.observedAt,...(arrival.workingFiles?{workingFiles:{...arrival.workingFiles}}:{})});
      }else if(integer(sessionId)){
       const pending=sessions.get(sessionId);
       if(!call.origin||pending&&(pending.origin!==call.origin||!pending.open)){fail('Native yielded session has ambiguous command provenance');continue;}
       sessions.set(sessionId,{origin:call.origin,turnId:call.turnId,open:true});
      }else diagnostics.push('Native command has unknown exit: '+id+'/'+result.chunk_id);
     }
    }else if(payload.type==='message'&&payload.role==='assistant'){
     dirtyUsage=true;lastAssistantIndex=nativeCount;lastModelIndex=nativeCount;
     const message=list(payload.content).map(object).filter(part=>part?.type==='output_text').map(part=>text(part?.text)).join('\n');assistantMessages.push(message);
     if(payload.phase==='final_answer'&&payload.status==='completed'){
      const meta=object(payload.internal_chat_message_metadata_passthrough);
      if(!currentTurn||meta?.turn_id!==currentTurn)fail('Final reply belongs to another native turn');
      final={text:message,turnId:currentTurn??'',index:nativeCount,timestamp:nativeTime};
     }
    }else if(payload.type==='reasoning'){dirtyUsage=true;lastModelIndex=nativeCount;}
   }
  }else if(record.type==='driver_complete')summary=object(record.summary);
 }
 if(!driverStart||!binding||!session||!activeGoal||!nativeActive||!sameGoal(goalState)||goalState?.status!=='complete')fail('Same native goal active-to-complete evidence is missing');
 if(currentTurn||!final||!terminal||final.index!==lastAssistantIndex||final.turnId!==terminal.turnId||final.index>=terminal.index||final.text!==terminal.text||terminal.timestamp<Number(goalState?.updated_at_ms))fail('Final assistant reply and after-goal terminal completion do not match');
 if([...calls.values()].some(call=>!call.done))fail('Native tool calls remain incomplete');
 if([...sessions.values(),...cells.values()].some(pending=>pending.open))fail('Native asynchronous commands remain incomplete');
 if(!latestUsage||!responses.size||dirtyUsage||!final||!terminal||latestCountIndex<=final.index||latestCountIndex>=terminal.index||!sameUsage(latestUsage,summed))fail('Final native generation usage is incomplete');
 if(!summary)fail('Native driver summary is missing');
 else{
  const finalGoals=list(summary.goalsAfterExit).map(object),bound=object(summary.binding);
  if(normalizePath(summary.root)!==normalizePath(expected.root)||summary.objective!==expected.objective||bound?.threadId!==threadId||bound?.goalId!==goalId||bound?.rolloutPath!==binding?.rolloutPath||finalGoals.length!==1||!sameGoal(finalGoals[0])||finalGoals[0]?.status!=='complete')fail('Persisted final native goal identity differs');
  if(summary.stopReason!=='native-goal-complete'||summary.goalComplete!==true||summary.passedDispatch!==true||summary.nativeTerminalObservedAfterGoal!==true||!Array.isArray(summary.parseErrors)||summary.parseErrors.length||summary.nativeEventCount!==nativeCount)fail('Native driver ended incompletely or reported truncated data');
  if(typeof summary.elapsedSeconds!=='number'||typeof summary.timeoutSeconds!=='number'||summary.elapsedSeconds>summary.timeoutSeconds)fail('Native driver exceeded its wall budget');
  if(!sameUsage(nativeUsage(summary.observedTotalTokenUsage),latestUsage)||summary.observedTotalTokens!==latestUsage?.total_tokens)fail('Driver cumulative usage differs from observed native usage');
  if(integer(summary.sqlGoalTokens))sqlGoalTokens=summary.sqlGoalTokens;
  if(!integer(finalGoals[0]?.tokens_used)||sqlGoalTokens!==finalGoals[0]?.tokens_used)fail('Persisted native SQL goal counter is inconsistent');
  if(!integer(finalGoals[0]?.updated_at_ms)||!terminal||terminal.timestamp<Number(finalGoals[0]?.updated_at_ms))fail('Native terminal precedes the persisted complete goal');
 }
 const knownUsage=!latestUsage||summed.total_tokens>=latestUsage.total_tokens?summed:latestUsage;
 if(knownUsage.total_tokens>expected.maxObservedTokens||sqlGoalTokens!==undefined&&sqlGoalTokens>expected.maxObservedTokens)fail('Native goal exceeded its full observed token budget');
 const observedUsage={input:knownUsage.input_tokens,output:knownUsage.output_tokens,total:knownUsage.total_tokens};
 const verified=reasons.length===0;
 return {observation:{tools,usage:verified?observedUsage:undefined,usageComplete:verified,observedUsage,assistantMessages,answer:final?.text??''},nativeGoal:{verified,reasons,threadId,goalId,sqlGoalTokens,diagnostics},rawLines};
}
