import {test} from 'node:test';import assert from 'node:assert/strict';
import {live,record} from './live-support.js';import {liveGenerationPrerequisites,driveLiveGeneration} from './live-generation-support.js';
for(const backend of ['native','host'] as const)for(const kind of ['service','monorepo'] as const)test('live '+backend+' '+kind+' generation and counterexample update',{skip:!live},async t=>{
 if(process.env.RIGUP_LIVE_PROJECTS&&!process.env.RIGUP_LIVE_PROJECTS.split(',').includes(kind)){t.skip('Case not selected for this bounded live run');return;}
 const missing=await liveGenerationPrerequisites(backend);if(missing){await record('generation-'+backend+'-'+kind,{caseId:'generation/'+backend+'/'+kind,status:'pending',reason:missing,checkedAt:new Date().toISOString()});t.skip(missing);return;}
 const result=await driveLiveGeneration(kind,backend);assert.equal(result.executionStatus,'passed',result.reason);
});
