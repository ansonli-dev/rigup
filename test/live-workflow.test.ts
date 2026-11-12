import {test} from 'node:test';
import assert from 'node:assert/strict';
import {record} from './live-support.js';
import {nativeWorkflowProbe,workflowCases} from './live-workflow-support.js';

// Explicit opt-in: an unavailable host/authentication is a failed gate, never a simulated pass.
const enabled=process.env.RIGUP_LIVE_WORKFLOW==='1';
const hosts=(process.env.RIGUP_LIVE_WORKFLOW_HOSTS??'codex,opencode,omp').split(',');
const cases=(process.env.RIGUP_LIVE_WORKFLOW_CASES??workflowCases.join(',')).split(',');
for(const host of ['codex','opencode','omp'] as const)for(const scenario of workflowCases)test('native workflow '+host+' '+scenario,{skip:!enabled||!hosts.includes(host)||!cases.includes(scenario)},async()=>{
 const result=await nativeWorkflowProbe(host,scenario);
 await record('workflow-'+host+'-'+scenario,result);
 assert.equal(result.status,scenario==='no-skill-boundary'||scenario==='loaded-bypass'?'observed':'passed',result.reason);
 if(scenario==='loaded-bypass')assert.ok(['refused','host-override'].includes(result.bypassOutcome),'Unverified bypass behavior remains an incomplete gate');
});
