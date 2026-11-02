import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateStepResult,validateInventory} from '../src/types.js';
test('pending_host_cannot_carry_success_plan',()=>{
 assert.throws(()=>validateStepResult({status:'pending-host',requestId:'x',requestPath:'/tmp/x',nextCommand:'rigup update',value:{}}),/value/);
 assert.throws(()=>validateStepResult({status:'pending-host'}),/requestId/);
 assert.doesNotThrow(()=>validateStepResult({status:'complete',value:{}}));
});
test('inventory_requires_disposition_for_every_old_asset',()=>{
 assert.throws(()=>validateInventory(['old'],[]),/old/);
 assert.doesNotThrow(()=>validateInventory(['old'],[{logicalId:'old',action:'retain'}]));
});
