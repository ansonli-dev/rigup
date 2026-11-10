import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createProgress} from '../src/progress.js';

test('research_without_denominator_does_not_invent_percentage', () => {
 let now=0; const p=createProgress(()=>now);
 now=12000;
 const text=p({stage:'研究',completed:3,next:'生成'});
 assert.match(text,/研究/); assert.match(text,/12s/); assert.match(text,/生成/);
 assert.doesNotMatch(text,/%/); assert.match(text,/待估算/);
});
test('unknown_required_stage_and_overrun_withdraw_eta', () => {
 let now=0; const p=createProgress(()=>now);
 assert.match(p({stage:'研究',completed:1,total:4,estimateMs:1000,allStagesKnown:false}),/待估算/);
 now=2000;
 assert.match(p({stage:'研究',completed:2,total:4,estimateMs:1000,allStagesKnown:true}),/待估算/);
});
import {createProgressReporter} from '../src/progress.js';
test('progress_explains_current_and_next_steps',()=>{
 let now=0,out='';const p=createProgressReporter({runId:'run',phases:['generation','preview','apply'],isTTY:false,clock:()=>now,write:s=>out+=s});p.event({stage:'generation',task:'guide',completed:1,total:3,next:'preview',status:'running'});assert.match(out,/1\/3/);assert.match(out,/guide/);assert.match(out,/preview/);assert.match(out,/Stage 1\/3.*ETA unknown/);assert.doesNotMatch(out,/%|[\u3400-\u9fff]/);
});
test('quiet_task_emits_liveness_without_fake_completion',()=>{
 let now=0,out='';const p=createProgressReporter({runId:'run',phases:['research','generation'],isTTY:false,clock:()=>now,write:s=>out+=s});p.event({stage:'research',completed:0,waiting:'provider response',next:'generation'});out='';now=29999;p.tick();assert.equal(out,'');now=30000;p.tick();assert.match(out,/provider response/);assert.match(out,/0/);out='';now=60000;p.tick();assert.match(out,/60s|60 秒/);assert.doesNotMatch(out,/%|100/);
});
test('retry_and_manual_wait_update_eta',()=>{
 let now=0,out='';const p=createProgressReporter({runId:'run',phases:['apply'],isTTY:true,clock:()=>now,write:s=>out+=s});p.event({stage:'apply',completed:0,total:2,eta:{minMs:1000,maxMs:3000,basis:'two comparable measured tasks'},allStagesKnown:true});assert.match(out,/two comparable/);out='';p.event({stage:'apply',completed:0,total:2,status:'retry',attempt:1,retryLimit:1});assert.match(out,/ETA unknown/);out='';p.event({stage:'apply',completed:0,total:2,status:'waiting',requiresUserAction:true,waiting:'external decision'});now=10000;p.tick();assert.match(out,/waiting for user action/);assert.doesNotMatch(out,/ETA \d/);assert.throws(()=>p.event({stage:'apply',completed:0,status:'retry',attempt:2,retryLimit:1}),/retry|limit/);
});
test('replan_explains_denominator_change_and_failure_is_not_completion',()=>{
 let out='';const p=createProgressReporter({runId:'run',phases:['generation'],isTTY:false,write:s=>out+=s});p.event({stage:'generation',completed:1,total:2,planVersion:1});out='';p.event({stage:'generation',completed:1,total:3,planVersion:2});assert.match(out,/2.*3/);assert.match(out,/plan changed/);out='';p.event({stage:'generation',completed:1,total:3,status:'failed'});assert.match(out,/failed/);assert.doesNotMatch(out,/100%/);
});
