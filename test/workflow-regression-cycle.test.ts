import {workflowCommandTimeoutMs} from './workflow-timeouts.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createWorkflowFixture} from './workflow-fixture-support.js';
import {captureWorkflowState,observedRegressionCycle,workflowWorkingFiles} from './workflow-observation-support.js';
import {runLiveCommand} from './live-process-support.js';
import {npmCommand} from '../src/npm-command.mjs';

const source='export function greet(name) { const value=name.trim(); if(!value) throw new TypeError("Name required"); return "Hello, "+value; }\n';
const imports='import {test} from "node:test";import assert from "node:assert/strict";import {greet} from "../src/greet.js";\n';
const tests=imports+'test("rejects empty and whitespace names",()=>{for(const name of ["", " ", "\\t\\n"])assert.throws(()=>greet(name),TypeError);});\ntest("preserves valid names",()=>assert.equal(greet(" Ada Lovelace "),"Hello, Ada Lovelace"));\n';
for(const scenario of ['codex','opencode','omp','missing-red','suppressed-red','after-fix','unchanged-tests','infrastructure-failure','unrelated-assertion','timeout','after-green','before-finding'] as const)test('agent must observe the real blank regression RED before the delivered GREEN: '+scenario,async()=>{
 const fixture=await createWorkflowFixture({testCommand:'node --test '+(scenario==='opencode'?'--test-reporter=spec ':'')+'test/greet.test.js'});
 try{
  const initialSource=await readFile(fixture.root+'/src/greet.js','utf8'),initialTests=await readFile(fixture.root+'/test/greet.test.js','utf8'),before=await captureWorkflowState(fixture),firstEvent=fixture.events.length,tools:any[]=[];
  const wrap=(command:string,output:string,exit:number|null)=>{
   const observedAt=new Date().toISOString(),observedTick=performance.now(),workingFiles=workflowWorkingFiles(fixture.root);
   if(scenario==='opencode')return {tool:'shell',state:{status:'completed',input:{command},output,metadata:{exit}},observedAt,observedTick,workingFiles};
   if(scenario==='omp'||scenario==='timeout')return {role:'toolResult',toolName:'bash',input:{command},isError:exit!==0,details:{...(exit!==0?{exitCode:exit}:{}),...(scenario==='timeout'&&exit!==0?{timedOut:true}:{})},content:[{type:'text',text:output}],observedAt,observedTick,workingFiles};
   return {type:'command_execution',command,aggregated_output:output,exit_code:exit,observedAt,observedTick,workingFiles};
  };
  const observeMr=async(action:string)=>wrap('node tools/mr.mjs '+action,await fixture.node(['tools/mr.mjs',action]),0);
  const observeTest=async()=>{const command=npmCommand(['test']);const result=await runLiveCommand(command.executable,command.args,{cwd:fixture.root,env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,ComSpec:process.env.ComSpec,HOME:fixture.control+'/home',USERPROFILE:fixture.control+'/home',NO_COLOR:'1'},timeoutMs:workflowCommandTimeoutMs,maxBuffer:200000});return wrap('npm test',result.stdout+result.stderr,result.code);};
  if(scenario!=='before-finding')tools.push(await observeMr('status'));
  if(scenario!=='unchanged-tests')await writeFile(fixture.root+'/test/greet.test.js',scenario==='infrastructure-failure'?'import "../src/missing.js";\n':scenario==='unrelated-assertion'?imports+'test("unrelated",()=>assert.equal(1,2));\n':tests);
  if(scenario==='after-fix')await writeFile(fixture.root+'/src/greet.js',source);
  if(scenario!=='missing-red'&&scenario!=='after-green'){
   const red=await observeTest();if(scenario==='suppressed-red')red.aggregated_output='';tools.push(red);
  }
  if(scenario==='before-finding'){await writeFile(fixture.root+'/test/greet.test.js',initialTests);tools.push(await observeMr('status'));}
  await writeFile(fixture.root+'/test/greet.test.js',tests);await writeFile(fixture.root+'/src/greet.js',source);
  await fixture.git(['add','.']);await fixture.git(['commit','-qm','Regression and scoped repair']);
  tools.push(await observeMr('inspect-outgoing'),await observeMr('test-outgoing'));
  await fixture.node(['tools/mr.mjs','record-review','Actual scoped diff and configured test check reviewed']);await fixture.git(['push','origin','HEAD:main']);const head=await fixture.head();
  if(scenario==='after-green'){await writeFile(fixture.root+'/src/greet.js',initialSource);tools.push(await observeTest());await writeFile(fixture.root+'/src/greet.js',source);}
  const result=await observedRegressionCycle(fixture,head,before,fixture.events.slice(firstEvent),tools);
  assert.equal(result.passed,['codex','opencode','omp'].includes(scenario),JSON.stringify(result));
 }finally{await fixture.close();}
});
