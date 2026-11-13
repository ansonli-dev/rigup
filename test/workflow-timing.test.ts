import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createWorkflowFixture} from './workflow-fixture-support.js';

test('Windows workflow commands allow a slow successful subprocess',{skip:process.platform!=='win32',timeout:120_000},async()=>{
 const fixture=await createWorkflowFixture();
 try{
  // Exceeds the old 15 s command budget; the child still has a finite exit.
  assert.equal(await fixture.node(['-e','setTimeout(()=>process.stdout.write("slow success"),16000)']),'slow success');
 }finally{await fixture.close();}
});
