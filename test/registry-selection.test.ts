import {test} from 'node:test';
import assert from 'node:assert/strict';
import {access,mkdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {project} from './helpers.js';
import {softwareInstallRecipe,assertToolOperationRecipe} from '../src/integrations/tools/recipes.js';
import {loadUpstreamLock} from '../src/integrations/upstream.js';
import {executeOperation} from '../src/installer/operations.js';
import {stagedInstall} from '../src/installer/install-staging.js';
import {selectedNpmRegistry} from '../src/runtime-inputs.js';

test('approved registry survives verified native install staging and reaches dispatch for both tools',()=>project(async root=>project(async state=>{
 const before=process.env.RIGUP_NPM_REGISTRY;
 process.env.RIGUP_NPM_REGISTRY='https://npm.company.test/team';
 try{
  const registry=await selectedNpmRegistry(root);assert.equal(registry,'https://npm.company.test/team/');
  for(const id of ['openwiki','codegraph'] as const){
   const pin=(await loadUpstreamLock()).find(item=>item.integrationId===id)!;
   const operation=softwareInstallRecipe(root,id,pin.version,pin.packageIntegrity,undefined,registry);
   assert.equal(operation.registry,registry);assertToolOperationRecipe(root,operation,pin,[]);
   const staged=stagedInstall(root,operation,{token:'11111111-1111-1111-1111-111111111111'});
   assert.equal(staged.registry,registry);
   const result=await executeOperation(operation,{stateRoot:state,authorizationRef:'approved',launch:async actual=>{
    assert.equal(actual.parameters.args[actual.parameters.args.indexOf('--registry')+1],registry);
    return {status:'failed',message:'synthetic network unavailable'};
   }});
   assert.equal(result.status,'failed');
  }
 }finally{if(before===undefined)delete process.env.RIGUP_NPM_REGISTRY;else process.env.RIGUP_NPM_REGISTRY=before;}
})));

test('a registry change after review prevents fresh and resumed install dispatch and keeps package pins',()=>project(async root=>project(async state=>{
 const before=process.env.RIGUP_NPM_REGISTRY;
 process.env.RIGUP_NPM_REGISTRY='https://npm.company.test/approved/';
 const pin=(await loadUpstreamLock()).find(item=>item.integrationId==='openwiki')!;
 const operation=softwareInstallRecipe(root,'openwiki',pin.version,pin.packageIntegrity,undefined,process.env.RIGUP_NPM_REGISTRY);
 let calls=0;
 const dependencies={stateRoot:state,authorizationRef:'approved',launch:async()=>{calls++;return {status:'failed' as const,message:'fixture network failure'};}};
 try{
  process.env.RIGUP_NPM_REGISTRY='https://npm.company.test/changed/';
  assert.equal((await executeOperation(operation,dependencies)).status,'pending');
  assert.equal(calls,0);await assert.rejects(access(join(root,'.rigup/tools')),{code:'ENOENT'});
  process.env.RIGUP_NPM_REGISTRY=operation.registry;
  assert.equal((await executeOperation(operation,dependencies)).status,'failed');assert.equal(calls,1);
  process.env.RIGUP_NPM_REGISTRY='https://npm.company.test/changed/';
  assert.equal((await executeOperation(operation,{...dependencies,restoringApproval:true})).status,'pending');assert.equal(calls,1);
  assert.throws(()=>assertToolOperationRecipe(root,{...operation,version:'999.0.0'},pin,[]),/version\/integrity/);
  assert.throws(()=>assertToolOperationRecipe(root,{...operation,query:{...operation.query,integrity:'sha512-wrong'}},pin,[]),/version\/integrity/);
 }finally{if(before===undefined)delete process.env.RIGUP_NPM_REGISTRY;else process.env.RIGUP_NPM_REGISTRY=before;}
})));

test('registry values reject credentials and query secrets without returning their bytes',()=>project(async root=>{
 const before=process.env.RIGUP_NPM_REGISTRY;
 try{
  for(const value of ['https://synthetic-secret@npm.test/','https://npm.test/?token=synthetic-secret','http://npm.company.test/']){
   process.env.RIGUP_NPM_REGISTRY=value;
   await assert.rejects(selectedNpmRegistry(root),error=>error instanceof Error&&!error.message.includes('synthetic-secret')&&error.message.includes('RIGUP_NPM_REGISTRY'));
  }
  delete process.env.RIGUP_NPM_REGISTRY;
  assert.equal(await selectedNpmRegistry(root),undefined);
  const operation=softwareInstallRecipe(root,'openwiki','1.2.3');
  assert.equal(operation.registry,undefined);
  assert.equal(operation.parameters.args[operation.parameters.args.indexOf('--registry')+1],'https://registry.npmjs.org/');
 }finally{if(before===undefined)delete process.env.RIGUP_NPM_REGISTRY;else process.env.RIGUP_NPM_REGISTRY=before;}
}));
