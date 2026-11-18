import assert from 'node:assert/strict';
import {join} from 'node:path';
import {test} from 'node:test';
import {runCli} from '../src/cli.js';
import {NativeBlocker,toBlocker} from '../src/integrations/host-setup/blockers.js';
import {project} from './helpers.js';

test('a blocker preserves its evidence and suppresses opaque error messages',()=>{
 assert.deepEqual(toBlocker('omp',new NativeBlocker('host-plugin-disabled','Disabled.',{evidence:['/example']})),{
  code:'host-plugin-disabled',host:'omp',reason:'Disabled.',evidence:['/example'],suggest:[],agent_can_draft:true,
 });
 const unknown=toBlocker('omp',new Error('private upstream response'));
 assert.equal(unknown.code,'prerequisite-unverified');
 assert.doesNotMatch(unknown.reason,/private upstream response/);
});

test('non-interactive native setup exposes missing CLI evidence in JSON and text',()=>project(root=>project(async home=>{
 const output:string[]=[],errors:string[]=[];
 const bin=join(home,'missing bin');
 assert.equal(await runCli(['init',root,'--agents','omp','--sdd','superpowers','--prepare-native','--json'],{
  cwd:root,isTTY:false,write:text=>output.push(text),writeError:text=>errors.push(text),
  services:{nativeSetup:{home,env:{PATH:bin},stateRoot:join(home,'state')}},
 }),3);
 const report=JSON.parse(output.join(''));
 assert.equal(report.nativePreparation.hosts[0].status,'manual');
 assert.deepEqual(report.nativePreparation.blockers.map(({host,code}: {host:string;code:string})=>({host,code})),[
  {host:'omp',code:'cli-not-runnable'},
 ]);
 assert.deepEqual(report.nativePreparation.blockers[0].evidence,[bin]);
 assert.match(errors.join(''),/cli-not-runnable/);
 assert.match(errors.join(''),/draft the fix commands.*user approve/);
})));

test('an unsupported OMP profile reports its variable name without its value',()=>project(root=>project(async home=>{
 const output:string[]=[];
 assert.equal(await runCli(['init',root,'--agents','omp','--sdd','superpowers','--prepare-native','--json'],{
  cwd:root,isTTY:false,write:text=>output.push(text),
  services:{nativeSetup:{home,env:{OMP_PROFILE:'bad private profile'},stateRoot:join(home,'state')}},
 }),3);
 const {blockers}=JSON.parse(output.join('')).nativePreparation;
 assert.equal(blockers[0].code,'prerequisite-unverified');
 assert.deepEqual(blockers[0].evidence,['<environment> (OMP_PROFILE)']);
 assert.match(blockers[0].reason,/OMP_PROFILE/);
 assert.doesNotMatch(output.join(''),/bad private profile/);
})));
