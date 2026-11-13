import {workflowObservationTimeoutMs} from './workflow-timeouts.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {project} from './helpers.js';
import {observedRun,workflowOutputArrival} from './live-workflow-support.js';
import {runLiveCommand} from './live-process-support.js';
import {actionableBlocker,characterizeBypass,workflowPrerequisiteEvidence,workflowWorkingFiles} from './workflow-observation-support.js';

const markers={skill:'random-skill-marker',goal:'random-goal-marker',context:'random-context-marker'};
const output=Object.values(markers).join('\n')+'\n'+JSON.stringify({changeName:'greeting',isPlanningComplete:false,artifacts:[{id:'design',status:'ready'}]})+'\n'+JSON.stringify({changeName:'greeting',state:'ready',missingPrerequisites:['design'],tasks:[]});
const command='cat .agents/skills/change-ready/SKILL.md .agents/skills/change-ready/references/project.md openspec/changes/greeting/GOAL.md; openspec status --change greeting --json; openspec instructions apply --change greeting --json';
const stream=(events:unknown[])=>events.map(event=>JSON.stringify(event)).join('\n');

for(const host of ['codex','opencode','omp'] as const)test('only the final assistant reply determines the handoff: '+host,()=>{
 const ready='Ready for implementation\n/goal Implement the reviewed change in "openspec/changes/greeting/GOAL.md" and verify every completion criterion in that file.',blocked='Blocked: approval is missing. Obtain developer approval and rerun readiness.';
 const event=(text:string,index:number)=>host==='codex'?{type:'item.completed',item:{type:'agent_message',text}}:host==='opencode'?{type:'text',part:{id:'part'+index,messageID:'message'+index,text}}:{type:'message_end',message:{role:'assistant',content:[{type:'text',text}]}};
 for(const texts of [[ready,blocked],[blocked,ready]]){
  const result=observedRun(host,stream(texts.map(event)));
  assert.equal(result.answer,texts[1]);assert.deepEqual(result.assistantMessages,texts);
 }
 if(host==='opencode')assert.equal(observedRun(host,stream([{type:'text',part:{id:'one',messageID:'final',text:'First final paragraph'}},{type:'text',part:{id:'two',messageID:'final',text:'Second final paragraph'}}])).answer,'First final paragraph\nSecond final paragraph','parts of one final message stay together');
});

test('known usage requires every generation and a complete terminal event',()=>{
 const usage={input:10,output:5,total:15};
 const opencode=[{type:'step_start',part:{messageID:'one'}},{type:'step_finish',part:{messageID:'one',reason:'tool-calls',tokens:usage}},{type:'step_start',part:{messageID:'two'}},{type:'text',part:{messageID:'two',text:'Final'}}];
 const omp=[{type:'agent_start'},{type:'turn_start'},{type:'message_start',message:{role:'assistant'}},{type:'message_end',message:{role:'assistant',content:[],usage:{input:10,output:5,totalTokens:15},stopReason:'toolUse'}},{type:'turn_end'},{type:'turn_start'},{type:'message_start',message:{role:'assistant'}},{type:'message_end',message:{role:'assistant',content:[{type:'text',text:'Final'}],stopReason:'stop'}},{type:'turn_end'},{type:'agent_end'}];
 for(const [host,events] of [['opencode',opencode],['omp',omp]] as const){
  const result=observedRun(host,stream(events));assert.equal(result.usage,undefined,host);assert.equal(result.usageComplete,false);assert.deepEqual(result.observedUsage,usage,'retain a labelled known subtotal');
 }
 const completed=[...opencode,{type:'step_finish',part:{messageID:'two',reason:'stop',tokens:{input:20,output:7,total:27}}}];
 assert.deepEqual(observedRun('opencode',stream(completed)).usage,{input:30,output:12,total:42});
 assert.equal(observedRun('opencode',stream(completed.map(event=>event.type==='step_finish'?{...event,part:{...event.part,reason:'tool-calls'}}:event))).usage,undefined,'tool calls are not a terminal assistant generation');
 const terminal=structuredClone(omp);(terminal[7].message as any).usage={input:20,output:7,totalTokens:27};
 assert.deepEqual(observedRun('omp',stream(terminal)).usage,{input:30,output:12,total:42});
 assert.equal(observedRun('omp',stream(terminal.slice(0,-1))).usage,undefined,'a missing agent_end remains incomplete');
 assert.equal(observedRun('codex',stream([{type:'turn.started'},{type:'turn.completed',usage:{input_tokens:10,output_tokens:5}},{type:'turn.started'}])).usage,undefined,'an unfinished later Codex turn is unknown too');
 assert.equal(observedRun('codex',stream([{type:'turn.started'},{type:'turn.completed',usage:{input_tokens:10,output_tokens:5}},{type:'item.completed',item:{type:'agent_message',text:'Unaccounted later reply'}}])).usage,undefined,'later generation output cannot reuse a previously completed turn subtotal');
});

const completeStreams={
 codex:[{type:'turn.started'},{type:'item.completed',item:{type:'agent_message',text:'Ready for implementation'}},{type:'turn.completed',usage:{input_tokens:10,output_tokens:5}}],
 opencode:[{type:'step_start',part:{messageID:'one'}},{type:'text',part:{id:'text-one',messageID:'one',text:'Ready for implementation'}},{type:'step_finish',part:{messageID:'one',reason:'stop',tokens:{input:10,output:5,total:15}}}],
 omp:[{type:'agent_start'},{type:'turn_start'},{type:'message_start',message:{role:'assistant'}},{type:'message_end',message:{role:'assistant',content:[{type:'text',text:'Ready for implementation'}],usage:{input:10,output:5,totalTokens:15},stopReason:'stop'}},{type:'turn_end'},{type:'agent_end'}],
};
for(const host of ['codex','opencode','omp'] as const)for(const defect of ['none','complete-final-json','truncated-tail','malformed-line','leading-malformed','null-record','array-record','missing-event-type'] as const)test('native CLI accounting rejects corrupt streams while retaining the known subtotal: '+host+'/'+defect,async()=>{
 const valid=stream(completeStreams[host]),suffix=defect==='truncated-tail'?'{"type":"unfinished",':defect==='malformed-line'?'{"type":"unfinished",\n':defect==='null-record'?'null\n':defect==='array-record'?'[]\n':defect==='missing-event-type'?'{"usage":{"total":999}}\n':'';
 const text=(defect==='leading-malformed'?'malformed complete record\n':'')+valid+(defect==='complete-final-json'?'':'\n')+suffix,arrival=workflowOutputArrival();
 const transport=await runLiveCommand(process.execPath,['-e','process.stdout.write('+JSON.stringify(text)+')'],{timeoutMs:workflowObservationTimeoutMs,maxBuffer:10000,onStdout:arrival.onStdout});
 assert.equal(transport.code,0);assert.equal(transport.timedOut,false);
 const result=observedRun(host,transport.stdout,undefined,arrival.arrivals,arrival.fileStates),complete=defect==='none'||defect==='complete-final-json';
 assert.equal(result.usageComplete,complete,'a damaged stream cannot reuse an earlier completed generation');assert.deepEqual(result.usage,complete?{input:10,output:5,total:15}:undefined);
 assert.deepEqual(result.observedUsage,{input:10,output:5,total:15});assert.equal(result.answer,'Ready for implementation','retain the known reply as diagnostic evidence without accepting the run');
});

test('OpenCode shell failure, timeout and abort metadata cannot establish successful observations',()=>{
 for(const metadata of [{exit:17},{exit:null},{exit:0,timedOut:true},{exit:0,aborted:true},{exit:0,results:[{metadata:{exit:17}}]}]){
  const tools=observedRun('opencode',stream([{type:'tool_use',part:{tool:'shell',state:{status:'completed',input:{command},output,metadata}}}])).tools;
  assert.deepEqual(workflowPrerequisiteEvidence(tools,markers,'greeting'),{loadedSkill:false,loadedGoal:false,loadedContext:false,nativeStatus:false,nativeApply:false},JSON.stringify(metadata));
 }
 const tools=observedRun('opencode',stream([{type:'tool_use',part:{tool:'read',state:{status:'completed',input:{filePath:'artifact.md'},output}}}])).tools;
 assert.equal(workflowPrerequisiteEvidence(tools,markers,'greeting').loadedSkill,true,'native file reads do not have shell exit codes');
});

test('OMP failed shell output remains RED evidence without becoming a successful read',()=>{
 const events=[{type:'message_end',message:{role:'assistant',content:[{type:'toolCall',id:'red',name:'bash',arguments:{command:'npm test'}}]}},{type:'message_end',message:{role:'toolResult',toolCallId:'red',toolName:'bash',isError:true,details:{exitCode:1},content:[{type:'text',text:output}]}}];
 const result=observedRun('omp',stream(events));assert.equal(result.tools.length,1);assert.equal(result.tools[0].details.exitCode,1);
 assert.deepEqual(workflowPrerequisiteEvidence(result.tools,markers,'greeting'),{loadedSkill:false,loadedGoal:false,loadedContext:false,nativeStatus:false,nativeApply:false});
 assert.deepEqual(workflowPrerequisiteEvidence(result.tools.map(tool=>({...tool,isError:false})),markers,'greeting'),{loadedSkill:false,loadedGoal:false,loadedContext:false,nativeStatus:false,nativeApply:false},'a known failing exit cannot become successful through a contradictory outer flag');
});

test('native result arrival captures actual source/test bytes before later edits, overriding host file-state claims',()=>project(async root=>{
 await mkdir(join(root,'src'));await mkdir(join(root,'test'));
 await writeFile(join(root,'src/greet.js'),'before');await writeFile(join(root,'test/greet.test.js'),'baseline test');
 const before=workflowWorkingFiles(root),arrival=workflowOutputArrival(()=>workflowWorkingFiles(root));
 const event={type:'item.completed',workingFiles:before,item:{type:'command_execution',command:'actual fixture result',aggregated_output:'read result',exit_code:0,workingFiles:before}};
 const line=JSON.stringify(event),half=Math.floor(line.length/2);
 const program='process.stdout.write('+JSON.stringify(line.slice(0,half))+');require("node:fs").writeFileSync('+JSON.stringify(join(root,'src/greet.js'))+',"at result arrival");setTimeout(()=>process.stdout.write('+JSON.stringify(line.slice(half)+'\n')+'),25);';
 const transport=await runLiveCommand(process.execPath,['-e',program],{cwd:root,timeoutMs:workflowObservationTimeoutMs,maxBuffer:10000,onStdout:arrival.onStdout});
 assert.equal(transport.code,0);const during=workflowWorkingFiles(root);
 await writeFile(join(root,'src/greet.js'),'after process exit');
 const tool=observedRun('codex',transport.stdout,undefined,arrival.arrivals,arrival.fileStates).tools[0];
 assert.deepEqual(tool.workingFiles,during);assert.notDeepEqual(tool.workingFiles,before);assert.notDeepEqual(tool.workingFiles,workflowWorkingFiles(root));
 assert.equal(observedRun('codex',transport.stdout).tools[0].workingFiles,undefined,'an old transcript cannot manufacture an independent byte observation');
}));

test('native tool proof gets the actual complete-line arrival time rather than a host claim or post-exit timestamp',async()=>{
 const arrival=workflowOutputArrival(),started=Date.now(),startTick=performance.now();
 const event={type:'item.completed',observedAt:'1900-01-01T00:00:00Z',observedTick:-1,item:{type:'command_execution',command:'actual fixture command',aggregated_output:'actual result',exit_code:0,observedTick:-2}};
 const line=JSON.stringify(event),half=Math.floor(line.length/2);
 const program='console.log("diagnostic before JSON");process.stdout.write('+JSON.stringify(line.slice(0,half))+');setTimeout(()=>process.stdout.write('+JSON.stringify(line.slice(half)+'\n')+'),25);';
 const transport=await runLiveCommand(process.execPath,['-e',program],{timeoutMs:workflowObservationTimeoutMs,maxBuffer:10000,onStdout:arrival.onStdout});
 const ended=Date.now();assert.equal(transport.code,0);
 const tool=observedRun('codex',transport.stdout,undefined,arrival.arrivals,arrival.fileStates,arrival.ticks).tools[0];
 assert.ok(Date.parse(tool.observedAt)>=started&&Date.parse(tool.observedAt)<=ended,'tool proof must be timestamped when its complete JSON line is delivered');
 assert.equal(tool.observedAt,arrival.arrivals[1],'diagnostic and partial lines cannot shift the tool timestamp');
 assert.equal(tool.observedTick,arrival.ticks[1]);assert.ok(tool.observedTick>=startTick&&tool.observedTick<=performance.now());
 assert.equal(observedRun('codex',transport.stdout).tools[0].observedAt,undefined,'re-reading an old transcript cannot invent an arrival timestamp');
 assert.equal(observedRun('codex',transport.stdout).tools[0].observedTick,undefined,'native-host tick claims cannot establish ordering');
});

test('ordinary blocked observation cannot pass from paths or echoed claims without actual read and native outputs',()=>{
 const tools=observedRun('codex',JSON.stringify({type:'item.completed',item:{type:'command_execution',command,aggregated_output:markers.context,exit_code:0}})).tools;
 const evidence=workflowPrerequisiteEvidence(tools,markers,'greeting');
 assert.equal(evidence.loadedSkill,false);assert.equal(evidence.loadedGoal,false);
 assert.equal(evidence.nativeStatus,false);assert.equal(evidence.nativeApply,false);
});

test('failed native commands cannot establish successful prerequisite inspection',()=>{
 const tools=observedRun('codex',JSON.stringify({type:'item.completed',item:{type:'command_execution',command,aggregated_output:output,exit_code:1}})).tools;
 assert.deepEqual(workflowPrerequisiteEvidence(tools,markers,'greeting'),{loadedSkill:false,loadedGoal:false,loadedContext:false,nativeStatus:false,nativeApply:false});
});

test('native observation uses successful tool payloads on Codex, OpenCode and OMP, including Windows paths',()=>{
 const streams={
  codex:[{type:'item.completed',item:{type:'command_execution',command,aggregated_output:output,exit_code:0}}],
  opencode:[{type:'tool_use',part:{tool:'bash',state:{status:'completed',input:{command:command.replaceAll('/','\\')},output,metadata:{exit:0}}}}],
  omp:[{type:'message_end',message:{role:'assistant',content:[{type:'toolCall',id:'actual-read',name:'bash',arguments:{command}}]}},{type:'message_end',message:{role:'toolResult',toolCallId:'actual-read',toolName:'bash',isError:false,content:[{type:'text',text:output}]}}],
 };
 for(const [host,events] of Object.entries(streams)){
  const evidence=workflowPrerequisiteEvidence(observedRun(host as 'codex'|'opencode'|'omp',events.map(value=>JSON.stringify(value)).join('\n')).tools,markers,'greeting');
  assert.deepEqual(evidence,{loadedSkill:true,loadedGoal:true,loadedContext:true,nativeStatus:true,nativeApply:true},host);
 }
 const otherChange=observedRun('codex',JSON.stringify({type:'item.completed',item:{type:'command_execution',command,aggregated_output:output.replaceAll('greeting','other'),exit_code:0}})).tools;
 assert.equal(workflowPrerequisiteEvidence(otherChange,markers,'greeting').nativeStatus,false,'another change is not this change’s native prerequisite evidence');
});

test('complete native apply output can omit missingPrerequisites, as OpenSpec 1.16.0 does',()=>{
 const actualReadyShape={changeName:'greeting',schemaName:'spec-driven',state:'ready',contextFiles:{design:['design.md'],tasks:['tasks.md']},tasks:[],progress:{total:0,complete:0,remaining:0}};
 const tools=observedRun('codex',JSON.stringify({type:'item.completed',item:{type:'command_execution',command:'openspec instructions apply --change greeting --json',aggregated_output:JSON.stringify(actualReadyShape),exit_code:0}})).tools;
 assert.equal(workflowPrerequisiteEvidence(tools,markers,'greeting').nativeApply,true);
});

test('blocked answers must identify an actionable missing prerequisite, including ordinary missing approval',()=>{
 for(const scenario of ['incomplete-native','blocked-delivery','missing-approval','blocked-approval-delivery','wrong-change','missing-verification','unverifiable-goal']){
  assert.equal(actionableBlocker('I could not proceed.',scenario),false,scenario);
 }
 assert.equal(actionableBlocker('Blocked: design.md is missing. Complete the native design and rerun change-ready.','blocked-delivery'),true);
 assert.equal(actionableBlocker('Blocked: approval.md is missing. Obtain developer approval for this scope and rerun change-ready.','blocked-approval-delivery'),true);
 assert.equal(actionableBlocker('Blocked: approval.md is missing.','blocked-approval-delivery'),false,'missing item alone does not supply a correction');
 assert.equal(actionableBlocker('Ready for implementation.\n/goal Implement a change.','missing-approval'),false);
});

test('explicit bypass is characterized without weakening ordinary refusal or promoting unverified execution',()=>{
 const evidence={ran:true,observedPrerequisites:true,sourceOrTestsChanged:false,unchanged:true,actionableRefusal:true};
 assert.equal(characterizeBypass(evidence),'refused');
 assert.equal(characterizeBypass({...evidence,sourceOrTestsChanged:true,unchanged:false}),'host-override');
 assert.equal(characterizeBypass({...evidence,ran:false}),'unverified','timeout/budget failures stay incomplete');
 assert.equal(characterizeBypass({...evidence,observedPrerequisites:false,sourceOrTestsChanged:true}),'unverified','an unobserved load cannot establish a loaded-skill boundary');
 assert.equal(characterizeBypass({...evidence,unchanged:false}),'unverified','a local commit alone cannot pass as a refusal');
 assert.equal(characterizeBypass({...evidence,actionableRefusal:false}),'unverified','a no-op is not an observed refusal');
});
