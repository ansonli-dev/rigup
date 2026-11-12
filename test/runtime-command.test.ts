import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {executeCheck} from '../src/integrations/tools/project-check.mjs';
import {runProjectChecks} from '../src/integrations/tools/quality.js';
import {scanRepository} from '../src/analyzer/repository.js';
import {project} from './helpers.js';
import type {SetupOptions} from '../src/types.js';

test('declared environment check expands references only in transient argv and retains safe results',()=>project(async root=>{
 const original={...process.env};
 process.env.RUNTIME_HEADER='synthetic-check-secret';process.env.UNRELATED_CREDENTIAL='synthetic-unrelated-secret';
 const options:SetupOptions={agents:['codex'],backend:'host',projectRules:false,customer:{commands:{environment:{
  executable:process.execPath,args:['check.mjs','Authorization: Bearer ${RUNTIME_HEADER}'],cwd:'.',envRefs:['RUNTIME_HEADER'],
 }}}};
 try{
  await writeFile(join(root,'check.mjs'),`import {writeFileSync} from 'node:fs';
if(process.argv[2]!=='Authorization: Bearer synthetic-check-secret'||process.env.RUNTIME_HEADER!=='synthetic-check-secret'||process.env.UNRELATED_CREDENTIAL)process.exit(2);
writeFileSync('ran','yes');console.log(process.env.RUNTIME_HEADER);console.error(process.env.RUNTIME_HEADER);
`);
  const profile=await scanRepository(root,options);
  const results=await runProjectChecks(profile,['environment'],undefined,options);
  assert.equal(results[0].status,'passed');
  assert.equal(await readFile(join(root,'ran'),'utf8'),'yes');
  assert.deepEqual(results[0].command,options.customer!.commands!.environment);
  assert.doesNotMatch(JSON.stringify(results),/synthetic-/);
  await writeFile(join(root,'check.mjs'),`console.error(process.env.RUNTIME_HEADER);process.exit(1);`);
  const failed=await runProjectChecks(profile,['environment'],undefined,options);
  assert.equal(failed[0].status,'failed');
  assert.doesNotMatch(JSON.stringify(failed),/synthetic-/);
 }finally{
  for(const name of ['RUNTIME_HEADER','UNRELATED_CREDENTIAL'])if(original[name]===undefined)delete process.env[name];else process.env[name]=original[name];
 }
}));

test('missing or undeclared argv references block shell-free dispatch without exposing values',()=>project(async root=>{
 await writeFile(join(root,'check.mjs'),`import {writeFileSync} from 'node:fs';writeFileSync('ran','yes');`);
 for(const command of [
  {executable:process.execPath,args:['check.mjs','${DECLARED}'],cwd:'.',envRefs:['DECLARED']},
  {executable:process.execPath,args:['check.mjs','${UNDECLARED}'],cwd:'.',envRefs:[]},
 ]){
  const result=await executeCheck(command,root,{env:{UNDECLARED:'synthetic-undisclosed'}});
  assert.equal(result.status,'pending');
  assert.doesNotMatch(JSON.stringify(result),/synthetic-/);
 }
 await assert.rejects(readFile(join(root,'ran')),{code:'ENOENT'});
}));

test('invalid transient argument values produce a safe pending result instead of a secret-bearing spawn error',()=>project(async root=>{
 const command={executable:process.execPath,args:['--version','${DECLARED}'],cwd:'.',envRefs:['DECLARED']};
 const result=await executeCheck(command,root,{env:{DECLARED:'synthetic-spawn-secret\0invalid'}});
 assert.equal(result.status,'pending');assert.doesNotMatch(JSON.stringify(result),/synthetic-spawn-secret/);
 assert.deepEqual(result.command,command);
}));
