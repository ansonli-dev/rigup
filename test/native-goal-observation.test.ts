import {test} from 'node:test';
import assert from 'node:assert/strict';
import {observeNativeGoal,type NativeGoalObservedLine} from './native-goal-observation-support.js';
import {workflowToolSucceeded} from './workflow-observation-support.js';

// Sanitized shapes from the retained Codex 0.166.0 native /goal rollout; this is unit evidence only.
const root='/fixture/workspace with space 中文',thread='native-thread',goal='native-goal',turn='native-turn',objective='Implement the reviewed greeting GOAL and verify it.';
const expected={root,objective,maxObservedTokens:70000},base=Date.parse('2026-11-12T10:29:12.000Z');
const usage=(input:number,cached:number,output:number)=>({input_tokens:input,cached_input_tokens:cached,cache_write_input_tokens:0,output_tokens:output,reasoning_output_tokens:0,total_tokens:input+output});
const usageParts=[usage(16098,0,85),usage(16398,15872,23),usage(16481,16128,21),usage(16694,16128,68)];
const finalAnswer='Delivery status: complete\nThe same native goal finished with verified evidence.';
function fixture(){
 const raw:any[]=[];const add=(type:string,payload:unknown)=>{raw.push({timestamp:new Date(base+raw.length*100).toISOString(),ordinal:raw.length,type,payload});};
 const total=usage(0,0,0);let response=0;
 const count=()=>{const current=usageParts[response++];for(const key of Object.keys(total) as (keyof typeof total)[])total[key]+=current[key];add('token_usage_record',{thread_id:thread,session_id:thread,turn_id:turn,root_turn_id:turn,response_id:'response-'+response,usage:current,thread_token_usage:{...total},turn_token_usage:{...total}});add('event_msg',{type:'token_count',info:{total_token_usage:{...total},last_token_usage:current}});};
 const call=(kind:string,id:string,name:string,input:string)=>add('response_item',{type:kind,call_id:id,name,status:'completed',...(kind==='custom_tool_call'?{input}:{arguments:input})});
 const result=(kind:string,id:string,output:unknown)=>add('response_item',{type:kind,call_id:id,output});
 const exec=(chunk:string,exit:number|null,output:string)=>({chunk_id:chunk,exit_code:exit,output,wall_time_seconds:0.01});
 add('session_meta',{id:thread,cwd:root,cli_version:'0.166.0'});
 add('event_msg',{type:'thread_goal_updated',threadId:thread,goal:{threadId:thread,objective,status:'active'}});
 add('event_msg',{type:'task_started',turn_id:turn});
 add('response_item',{type:'message',role:'assistant',phase:'commentary',status:'completed',content:[{type:'output_text',text:'This intermediate text must not become the final handoff.'}]});
 call('custom_tool_call','first','exec','text(await Promise.allSettled([tools.exec_command({cmd:"cat GOAL.md"}),tools.exec_command({cmd:"npm test"})]))');
 result('custom_tool_call_output','first',[{type:'input_text',text:'Script completed\nOutput:\n'},{type:'input_text',text:JSON.stringify([{status:'fulfilled',value:exec('read',0,'Actual GOAL contents')},{status:'fulfilled',value:exec('red',1,'Missing expected exception (TypeError)\n# fail 1')},{status:'fulfilled',value:exec('unknown',null,'No completed process result')}])}]);count();
 call('function_call','second','exec','text(await tools.exec_command({cmd:"cat proof.txt"}))');
 result('function_call_output','second',JSON.stringify({content:[{type:'text',text:JSON.stringify(exec('proof',0,'actual-proof'))}]}));count();
 call('custom_tool_call','mark','exec','text(await tools.update_goal({status:"complete"}))');
 result('custom_tool_call_output','mark',[{type:'input_text',text:JSON.stringify({goal:{threadId:thread,objective,status:'complete',tokensUsed:16732}})}]);
 const updatedAt=Date.parse(raw.at(-1).timestamp);count();
 add('response_item',{type:'message',role:'assistant',phase:'final_answer',status:'completed',content:[{type:'output_text',text:finalAnswer}],internal_chat_message_metadata_passthrough:{turn_id:turn}});count();
 add('event_msg',{type:'task_complete',turn_id:turn,last_agent_message:finalAnswer});
 const active={thread_id:thread,goal_id:goal,objective,status:'active',tokens_used:0,created_at_ms:base,updated_at_ms:base},complete={...active,status:'complete',tokens_used:16732,updated_at_ms:updatedAt};
 const records:any[]=[{type:'driver_start',root,objective,timeoutSeconds:90,tokenBudget:70000},{type:'goal_paste'},{type:'goal_enter'},{type:'native_binding',threadId:thread,goalId:goal,workspace:root,objective,rolloutPath:'/private/native-rollout.jsonl',sessionMetadata:{id:thread,cwd:root}},{type:'goal_state',goal:active}];
 for(const event of raw){records.push({type:'native_event',threadId:thread,goalId:goal,rolloutPath:'/private/native-rollout.jsonl',driverObservedAt:event.timestamp,event});if(event.type==='response_item'&&event.payload.call_id==='mark'&&event.payload.type==='custom_tool_call_output')records.push({type:'goal_state',goal:complete});}
 records.push({type:'driver_complete',summary:{root,objective,stopReason:'native-goal-complete',binding:{threadId:thread,goalId:goal,rolloutPath:'/private/native-rollout.jsonl'},goalsAfterExit:[complete],parseErrors:[],goalComplete:true,passedDispatch:true,nativeTerminalObservedAfterGoal:true,nativeEventCount:raw.length,observedTotalTokenUsage:{...total},observedTotalTokens:total.total_tokens,sqlGoalTokens:16732,elapsedSeconds:20,timeoutSeconds:90}});
 return records.map((record,index)=>({line:JSON.stringify({sequence:index+1,...record}),observedAt:new Date(base+20000+index*10).toISOString(),workingFiles:{'src/greet.js':'a'.repeat(64),'test/greet.test.js':(index<7?'b':'c').repeat(64)}}));
}
function rewrite(lines:NativeGoalObservedLine[],predicate:(value:any)=>boolean,change:(value:any)=>void){const line=lines.find(value=>predicate(JSON.parse(value.line)))!;const value=JSON.parse(line.line);change(value);line.line=JSON.stringify(value);}
function resequence(lines:NativeGoalObservedLine[]){
 let ordinal=0;for(const [index,line]of lines.entries()){const value=JSON.parse(line.line);value.sequence=index+1;if(value.type==='native_event')value.event.ordinal=ordinal++;if(value.type==='driver_complete')value.summary.nativeEventCount=ordinal;line.line=JSON.stringify(value);}
 return lines;
}

test('native goal normalization binds the final reply, full cumulative usage and actual nested command results',()=>{
 const lines=fixture(),result=observeNativeGoal(lines,expected);
 assert.equal(result.nativeGoal.verified,true,result.nativeGoal.reasons.join('; '));assert.equal(result.observation.answer,finalAnswer);assert.equal(result.observation.assistantMessages.length,2);
 assert.equal(result.observation.usageComplete,true);assert.equal(result.observation.usage?.total,65868);assert.equal(result.nativeGoal.sqlGoalTokens,16732,'native SQL accounting is a separate diagnostic');
 assert.equal(result.observation.tools.length,3,'retain exit 1 RED evidence, omit unknown command results and non-command goal output');
 assert.deepEqual(result.observation.tools.map(tool=>[tool.chunkId,tool.exit_code]),[['read',0],['red',1],['proof',0]]);
 assert.deepEqual(result.observation.tools.map(workflowToolSucceeded),[true,false,true]);
 assert.ok(result.nativeGoal.diagnostics.some(value=>value.includes('unknown')),'a mixed batch retains a diagnostic for its unknown-exit child');
 const receipt=lines.find(line=>JSON.parse(line.line).event?.payload?.type==='custom_tool_call_output')!;
 assert.equal(result.observation.tools[0].observedAt,receipt.observedAt);assert.deepEqual(result.observation.tools[1].workingFiles,receipt.workingFiles);
 assert.deepEqual(result.rawLines,lines.map(line=>line.line));
});

for(const defect of ['missing-record','record-before-output','stale-last-usage'] as const)test('a stale token count cannot account for the latest model generation: '+defect,()=>{
 const lines=fixture(),recordIndex=lines.findIndex(line=>JSON.parse(line.line).event?.payload?.response_id==='response-4');
 if(defect==='missing-record'){
  lines.splice(recordIndex,1);
  const previous=JSON.parse(lines.find(line=>JSON.parse(line.line).event?.payload?.response_id==='response-3')!.line).event.payload.thread_token_usage;
  rewrite(lines,value=>value.event?.payload?.type==='token_count'&&value.event.payload.info.total_token_usage.total_tokens===65868,value=>{value.event.payload.info={total_token_usage:previous,last_token_usage:usageParts[2]};});
  rewrite(lines,value=>value.type==='driver_complete',value=>{value.summary.observedTotalTokenUsage=previous;value.summary.observedTotalTokens=previous.total_tokens;});
 }else if(defect==='record-before-output'){
  const record=lines.splice(recordIndex,1)[0],finalIndex=lines.findIndex(line=>JSON.parse(line.line).event?.payload?.phase==='final_answer');
  record.observedAt=lines[finalIndex].observedAt;lines.splice(finalIndex,0,record);
 }else rewrite(lines,value=>value.event?.payload?.type==='token_count'&&value.event.payload.info.total_token_usage.total_tokens===65868,value=>{value.event.payload.info.last_token_usage=usageParts[2];});
 const result=observeNativeGoal(resequence(lines),{...expected,maxObservedTokens:defect==='missing-record'?55000:70000});
 assert.equal(result.nativeGoal.verified,false,'fresh final generation accounting is mandatory');assert.equal(result.observation.usageComplete,false);assert.equal(result.observation.usage,undefined);
});

test('missing final cumulative usage is rejected while preserving the full known generation subtotal',()=>{
 const lines=fixture(),index=lines.findIndex(line=>JSON.parse(line.line).event?.payload?.type==='token_count'&&JSON.parse(line.line).event.payload.info.total_token_usage.total_tokens===65868);lines.splice(index,1);
 const result=observeNativeGoal(resequence(lines),expected);assert.equal(result.nativeGoal.verified,false);assert.equal(result.observation.usage,undefined);
 assert.equal(result.observation.observedUsage.total,65868,'a missing summary cannot erase a generation already present in the raw evidence');
});

// These envelopes preserve actual no-model exec_command/write_stdin and exec/wait shapes from the R6 reproductions.
const blankFailure='✖ rejects empty and whitespace names\nℹ fail 1\nAssertionError [ERR_ASSERTION]: Missing expected exception (TypeError).\n';
function asynchronousFixture(kind:'session'|'cell',exit:number|null=1){
 const lines=fixture();
 rewrite(lines,value=>value.event?.payload?.call_id==='first'&&value.event.payload.type==='custom_tool_call',value=>{value.event.payload.input='const result = await tools.exec_command({cmd: "npm test", yield_time_ms: 1000}); text(result);';});
 rewrite(lines,value=>value.event?.payload?.call_id==='first'&&value.event.payload.type==='custom_tool_call_output',value=>{value.event.payload.output=kind==='session'?JSON.stringify({chunk_id:'initial',wall_time_seconds:1.001282875,session_id:12685,output:'> test\n> node --test test.mjs\n'}):'Script running with cell ID g60:31';});
 rewrite(lines,value=>value.event?.payload?.call_id==='second'&&value.event.payload.type==='function_call',value=>{value.event.payload.name=kind==='cell'?'functions.wait':'functions.exec';value.event.payload.arguments=kind==='cell'?JSON.stringify({cell_id:'g60:31',yield_time_ms:1000}):'text(await tools.write_stdin({session_id: 12685, chars: "", yield_time_ms: 1000}));';});
 rewrite(lines,value=>value.event?.payload?.call_id==='second'&&value.event.payload.type==='function_call_output',value=>{value.event.payload.output=[{type:'input_text',text:JSON.stringify({chunk_id:'final',wall_time_seconds:0.000006709,exit_code:exit,output:exit===0?'Tests passed\n':blankFailure})}];});
 return lines;
}

for(const kind of ['session','cell'] as const)for(const exit of [0,1] as const)test('asynchronous native command evidence keeps the originating command and actual final arrival: '+kind+'/'+exit,()=>{
 const lines=asynchronousFixture(kind,exit),output=lines.find(line=>JSON.parse(line.line).event?.payload?.call_id==='second'&&JSON.parse(line.line).event.payload.type==='function_call_output')!;
 output.workingFiles={'src/greet.js':'d'.repeat(64),'test/greet.test.js':'e'.repeat(64)};
 const result=observeNativeGoal(lines,expected);assert.equal(result.nativeGoal.verified,true,result.nativeGoal.reasons.join('; '));
 assert.equal(result.observation.tools.length,1,'the running chunk is not a completed command');const tool=result.observation.tools[0];
 assert.match(tool.command,/\bnpm test\b/);assert.equal(tool.exit_code,exit);assert.equal(workflowToolSucceeded(tool),exit===0);
 assert.equal(tool.observedAt,output.observedAt);assert.deepEqual(tool.workingFiles,output.workingFiles);assert.equal(tool.callId,'second');
 assert.equal(tool.originCallId,'first');assert.deepEqual(result.rawLines,lines.map(line=>line.line));
});

for(const kind of ['session','cell'] as const)for(const defect of ['wrong-id','unknown-id','cross-turn','missing-final','missing-hash','unknown-exit','id-only-in-string'] as const)test('asynchronous evidence rejects mismatched continuations without backfilling: '+kind+'/'+defect,()=>{
 const lines:NativeGoalObservedLine[]=asynchronousFixture(kind);
 if(defect==='wrong-id'||defect==='id-only-in-string')rewrite(lines,value=>value.event?.payload?.call_id==='second'&&value.event.payload.type==='function_call',value=>{value.event.payload.arguments=kind==='cell'?JSON.stringify({cell_id:'foreign-cell'}):defect==='id-only-in-string'?'text("tools.write_stdin({session_id:12685})"); text(await tools.exec_command({cmd:"true"}));':'text(await tools.write_stdin({session_id:99999}));';});
 if(defect==='unknown-id')rewrite(lines,value=>value.event?.payload?.call_id==='first'&&value.event.payload.type==='custom_tool_call_output',value=>{value.event.payload.output='No identified running command';});
 if(defect==='cross-turn'){
  const second=lines.findIndex(line=>JSON.parse(line.line).event?.payload?.call_id==='second'&&JSON.parse(line.line).event.payload.type==='function_call'),sample=JSON.parse(lines[second].line);
  const event=(payload:unknown)=>({...lines[second],line:JSON.stringify({...sample,event:{...sample.event,type:'event_msg',payload}})});
  lines.splice(second,0,event({type:'task_complete',turn_id:turn,last_agent_message:'Continuing.'}),event({type:'task_started',turn_id:'next-turn'}));
  for(const line of lines.slice(second+2)){const value=JSON.parse(line.line),payload=value.event?.payload;if(payload?.turn_id===turn)payload.turn_id='next-turn';if(payload?.root_turn_id===turn)payload.root_turn_id='next-turn';if(payload?.internal_chat_message_metadata_passthrough)payload.internal_chat_message_metadata_passthrough.turn_id='next-turn';line.line=JSON.stringify(value);}
 }
 if(defect==='missing-final')rewrite(lines,value=>value.event?.payload?.call_id==='second'&&value.event.payload.type==='function_call_output',value=>{value.event.payload.output=kind==='session'?JSON.stringify({chunk_id:'still-running',session_id:12685,output:''}):'Script running with cell ID g60:31';});
 if(defect==='missing-hash')delete lines.find(line=>JSON.parse(line.line).event?.payload?.call_id==='second'&&JSON.parse(line.line).event.payload.type==='function_call_output')!.workingFiles;
 if(defect==='unknown-exit')rewrite(lines,value=>value.event?.payload?.call_id==='second'&&value.event.payload.type==='function_call_output',value=>{value.event.payload.output=JSON.stringify({chunk_id:'unknown-final',exit_code:null,output:blankFailure});});
 const result=observeNativeGoal(resequence(lines),expected);
 if(defect==='missing-hash'){assert.equal(result.nativeGoal.verified,true);assert.equal(result.observation.tools.length,1);assert.equal(result.observation.tools[0].workingFiles,undefined);}
 else if(defect==='unknown-exit'){assert.equal(result.observation.tools.length,0);assert.ok(result.nativeGoal.diagnostics.some(value=>value.includes('unknown')));}
  else {assert.equal(result.nativeGoal.verified,false,result.nativeGoal.reasons.join('; '));assert.equal(result.observation.tools.some(tool=>/\bnpm test\b/.test(tool.command)),false,'unbound output must not be attributed to the original npm test');}
});

for(const path of ['direct-session','quoted-session','repeat-session','repeat-cell','cell-then-session','session-then-cell'] as const)test('native continuation provenance survives actual tool envelope variants: '+path,()=>{
 const lines=asynchronousFixture(path==='repeat-cell'||path==='cell-then-session'?'cell':'session');
 if(path==='direct-session'){
  rewrite(lines,value=>value.event?.payload?.call_id==='first'&&value.event.payload.type==='custom_tool_call',value=>{value.event.payload.type='function_call';value.event.payload.name='functions.exec_command';delete value.event.payload.input;value.event.payload.arguments=JSON.stringify({cmd:'npm test',yield_time_ms:1000});});
  rewrite(lines,value=>value.event?.payload?.call_id==='first'&&value.event.payload.type==='custom_tool_call_output',value=>{value.event.payload.type='function_call_output';});
  rewrite(lines,value=>value.event?.payload?.call_id==='second'&&value.event.payload.type==='function_call',value=>{value.event.payload.name='functions.write_stdin';value.event.payload.arguments=JSON.stringify({session_id:12685,chars:''});});
 }else if(path==='quoted-session')rewrite(lines,value=>value.event?.payload?.call_id==='second'&&value.event.payload.type==='function_call',value=>{value.event.payload.arguments="// A continuation of the actual session.\ntext(await tools.write_stdin({'session_id': 12685, chars: ''}));";});
 else {
  const toCell=path==='repeat-cell'||path==='session-then-cell';
  rewrite(lines,value=>value.event?.payload?.call_id==='second'&&value.event.payload.type==='function_call_output',value=>{value.event.payload.output=toCell?'Script running with cell ID '+(path==='repeat-cell'?'g60:31':'g61:42'):JSON.stringify({chunk_id:'intermediate',session_id:12685,output:'still running\n'});});
  rewrite(lines,value=>value.event?.payload?.call_id==='mark'&&value.event.payload.type==='custom_tool_call',value=>{value.event.payload.type='function_call';value.event.payload.name=toCell?'functions.wait':'functions.exec';delete value.event.payload.input;value.event.payload.arguments=toCell?JSON.stringify({cell_id:path==='repeat-cell'?'g60:31':'g61:42'}):'text(await tools.write_stdin({session_id:12685}));';});
  rewrite(lines,value=>value.event?.payload?.call_id==='mark'&&value.event.payload.type==='custom_tool_call_output',value=>{value.event.payload.type='function_call_output';value.event.payload.output=JSON.stringify({chunk_id:'last-poll',exit_code:1,output:blankFailure});});
 }
 const result=observeNativeGoal(lines,expected);assert.equal(result.nativeGoal.verified,true,result.nativeGoal.reasons.join('; '));assert.equal(result.observation.tools.length,1);
 const tool=result.observation.tools[0],last=lines.find(line=>JSON.parse(line.line).event?.payload?.call_id===tool.callId&&JSON.parse(line.line).event.payload.type==='function_call_output')!;
 assert.equal(tool.command,'npm test');assert.equal(tool.originCallId,'first');assert.equal(tool.exit_code,1);assert.equal(workflowToolSucceeded(tool),false);assert.equal(tool.observedAt,last.observedAt);assert.deepEqual(tool.workingFiles,last.workingFiles);
});

for(const defect of ['wrong-returned-session','dynamic-session','conditional-call','conditional-start','cross-turn-output','lost-final-generation','cell-id-in-stdout'] as const)test('native continuation cannot borrow unrelated identity, output or usage: '+defect,()=>{
 const lines=asynchronousFixture('session');
 if(defect==='wrong-returned-session')rewrite(lines,value=>value.event?.payload?.call_id==='second'&&value.event.payload.type==='function_call_output',value=>{value.event.payload.output=JSON.stringify({chunk_id:'foreign',session_id:33333,exit_code:1,output:blankFailure});});
 if(defect==='dynamic-session')rewrite(lines,value=>value.event?.payload?.call_id==='second'&&value.event.payload.type==='function_call',value=>{value.event.payload.arguments='text(await tools.write_stdin({session_id:Number("12685")}));';});
 if(defect==='conditional-call')rewrite(lines,value=>value.event?.payload?.call_id==='second'&&value.event.payload.type==='function_call',value=>{value.event.payload.arguments='if(false) text(await tools.write_stdin({session_id:12685}));';});
 if(defect==='conditional-start')rewrite(lines,value=>value.event?.payload?.call_id==='first'&&value.event.payload.type==='custom_tool_call',value=>{value.event.payload.input='if(false) text(await tools.exec_command({cmd:"npm test"}));';});
 if(defect==='cross-turn-output'){
  const index=lines.findIndex(line=>JSON.parse(line.line).event?.payload?.call_id==='second'&&JSON.parse(line.line).event.payload.type==='function_call_output'),sample=JSON.parse(lines[index].line);
  for(const payload of [{type:'task_started',turn_id:'foreign-turn'},{type:'task_complete',turn_id:turn,last_agent_message:'Continuing.'}])lines.splice(index,0,{...lines[index],line:JSON.stringify({...sample,event:{...sample.event,type:'event_msg',payload}})});
 }
 if(defect==='lost-final-generation')rewrite(lines,value=>value.event?.payload?.response_id==='response-4',value=>{delete value.event.payload.usage;});
 if(defect==='cell-id-in-stdout')rewrite(lines,value=>value.event?.payload?.call_id==='second'&&value.event.payload.type==='function_call_output',value=>{value.event.payload.output=JSON.stringify({chunk_id:'actual-stdout',exit_code:1,output:'Script running with cell ID invented\n'+blankFailure});});
 const result=observeNativeGoal(resequence(lines),expected);
 if(defect==='cell-id-in-stdout'){assert.equal(result.nativeGoal.verified,true);assert.equal(result.observation.tools.length,1);assert.match(result.observation.tools[0].aggregated_output,/Script running/);}
 else{assert.equal(result.nativeGoal.verified,false);assert.equal(result.observation.usageComplete,false);if(defect!=='lost-final-generation')assert.equal(result.observation.tools.length,0);}
});

test('native goal normalization never supplies historical timestamps or source hashes after the event',()=>{
 const lines:NativeGoalObservedLine[]=fixture();const output=lines.find(line=>JSON.parse(line.line).event?.payload?.type==='custom_tool_call_output')!;delete output.workingFiles;
 const result=observeNativeGoal(lines,expected);assert.equal(result.nativeGoal.verified,true);assert.equal(result.observation.tools[0].workingFiles,undefined);assert.equal(result.observation.tools[0].observedAt,output.observedAt);
});

for(const defect of ['foreign-thread','foreign-goal','foreign-session','blocked','paused','stale-terminal','late-persisted-update','missing-final','commentary-final','late-commentary','wrong-final','missing-usage','missing-generation-usage','stale-usage','sql-only-budget','orphan-output','duplicate-call','incomplete-call','unknown-exit','truncated-driver','truncated-native','parse-error','missing-arrival'] as const)test('native goal normalization rejects incomplete or mismatched evidence: '+defect,()=>{
 const lines:NativeGoalObservedLine[]=fixture();
 if(defect==='foreign-thread')rewrite(lines,value=>value.type==='native_event',value=>{value.threadId='foreign';});
 if(defect==='foreign-goal')rewrite(lines,value=>value.type==='goal_state',value=>{value.goal.goal_id='foreign';});
 if(defect==='foreign-session')rewrite(lines,value=>value.event?.type==='session_meta',value=>{value.event.payload.id='foreign';});
 if(defect==='blocked'||defect==='paused')rewrite(lines,value=>value.type==='goal_state'&&value.goal.status==='complete',value=>{value.goal.status=defect;});
 if(defect==='stale-terminal')rewrite(lines,value=>value.type==='goal_state'&&value.goal.status==='complete',value=>{value.goal.updated_at_ms=base+999999;});
 if(defect==='late-persisted-update')rewrite(lines,value=>value.type==='driver_complete',value=>{value.summary.goalsAfterExit[0].updated_at_ms=base+999999;});
 if(defect==='late-commentary'){
  rewrite(lines,value=>value.event?.payload?.phase==='final_answer',value=>{value.event.payload.phase='commentary';value.event.payload.content=[{type:'output_text',text:'Blocked: implementation is incomplete.'}];});
  rewrite(lines,value=>value.event?.payload?.phase==='commentary',value=>{value.event.payload.phase='final_answer';value.event.payload.content=[{type:'output_text',text:finalAnswer}];value.event.payload.internal_chat_message_metadata_passthrough={turn_id:turn};});
 }
 if(defect==='missing-final'||defect==='commentary-final')rewrite(lines,value=>value.event?.payload?.phase==='final_answer',value=>{value.event.payload.phase=defect==='missing-final'?'analysis':'commentary';});
 if(defect==='wrong-final')rewrite(lines,value=>value.event?.payload?.type==='task_complete',value=>{value.event.payload.last_agent_message='A different response';});
 if(defect==='missing-usage')rewrite(lines,value=>value.event?.payload?.type==='token_count',value=>{value.event.payload.info=null;});
 if(defect==='missing-generation-usage')rewrite(lines,value=>value.event?.type==='token_usage_record',value=>{delete value.event.payload.usage;});
 if(defect==='stale-usage')rewrite(lines,value=>value.event?.payload?.type==='token_count'&&value.event.payload.info.total_token_usage.total_tokens===65868,value=>{value.event.payload.info.total_token_usage=usageParts[0];});
 if(defect==='orphan-output')rewrite(lines,value=>value.event?.payload?.type==='custom_tool_call_output',value=>{value.event.payload.call_id='foreign-call';});
 if(defect==='duplicate-call')rewrite(lines,value=>value.event?.payload?.call_id==='second'&&value.event.payload.type==='function_call',value=>{value.event.payload.call_id='first';});
 if(defect==='incomplete-call')rewrite(lines,value=>value.event?.payload?.type==='custom_tool_call_output',value=>{value.event.payload.type='unrecognized_response';});
 if(defect==='unknown-exit')rewrite(lines,value=>value.event?.payload?.type==='custom_tool_call_output',value=>{value.event.payload.output=[{type:'input_text',text:'Truncated unknown exec result'}];});
 if(defect==='truncated-driver')lines.pop();
 if(defect==='truncated-native')rewrite(lines,value=>value.event?.ordinal===4,value=>{value.event.ordinal=99;});
 if(defect==='parse-error')rewrite(lines,value=>value.type==='driver_complete',value=>{value.summary.parseErrors=['Truncated JSON line'];});
 if(defect==='missing-arrival')lines[7].observedAt='';
 const result=observeNativeGoal(lines,{...expected,maxObservedTokens:defect==='sql-only-budget'?30000:70000});
 if(defect==='unknown-exit'){
  assert.equal(result.nativeGoal.verified,true,'unknown command output is diagnostic, not a fabricated usage failure');assert.equal(result.observation.tools.length,1);assert.ok(result.nativeGoal.diagnostics.length>0);
 }else{assert.equal(result.nativeGoal.verified,false);assert.equal(result.observation.usageComplete,false);assert.equal(result.observation.usage,undefined);assert.ok(result.nativeGoal.reasons.length>0);}
 assert.deepEqual(result.rawLines,lines.map(line=>line.line),'all raw evidence, including failures, stays available');
});
