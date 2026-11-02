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
