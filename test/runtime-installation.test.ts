import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {project} from './helpers.js';
import {scanRepository} from '../src/analyzer/repository.js';
import {generateFoundation,prepareGeneration} from '../src/generator/generate.js';
import {preview} from '../src/installer/preview.js';
import {apply} from '../src/installer/apply.js';
import {applyRecordPath,loadManifest} from '../src/installer/baseline.js';
import type {SetupOptions} from '../src/types.js';

const exec=promisify(execFile);
const options={agents:['codex' as const],backend:'host' as const,tools:[{id:'codegraph' as const,install:true,initialize:true,agents:['codex' as const]}]};
async function plan(root:string){const profile=await scanRepository(root,options);return generateFoundation(profile,options,await prepareGeneration(profile,options));}
test('unsafe runtime input defers automatic tooling while installing independent configuration',()=>project(root=>project(cacheRoot=>project(async stateRoot=>{
 await exec('git',['init','--quiet',root]);await mkdir(join(root,'.rigup'));
 const bytes='RIGUP_NPM_REGISTRY="https://private.example.test/registry"\n';
 await writeFile(join(root,'.rigup/.env'),bytes,{mode:0o600});await exec('git',['-C',root,'add','--force','.rigup/.env']);
 const generated=await plan(root);assert.deepEqual(generated.pendingRuntimeTools,['codegraph']);assert.deepEqual(generated.operations,[]);
 const reviewed=await preview(generated,[],{cacheRoot});assert.equal(reviewed.executable,true,reviewed.blockers.join('\n'));
 const report=await apply(reviewed.previewId,{cacheRoot,stateRoot});assert.equal(report.exitCode,3);
 assert.ok(await readFile(join(root,'.codex/config.toml')));assert.ok(await loadManifest(root));
 assert.equal(await readFile(join(root,'.rigup/.env'),'utf8'),bytes);assert.equal(report.runtimeSetup?.template.state,'pending');
 assert.doesNotMatch(JSON.stringify(report),/private\.example\.test/);
 await assert.rejects(readFile(join(root,'.rigup/tools/codegraph/package.json')),{code:'ENOENT'});
}))));
test('changed registry is rejected before a new durable apply transaction is created',()=>project(root=>project(cacheRoot=>project(async stateRoot=>{
 const original=process.env.RIGUP_NPM_REGISTRY;
 try{
  process.env.RIGUP_NPM_REGISTRY='https://one.example.test/npm';
  const reviewed=await preview(await plan(root),[],{cacheRoot});assert.equal(reviewed.executable,true,reviewed.blockers.join('\n'));
  process.env.RIGUP_NPM_REGISTRY='https://two.example.test/npm';
  await assert.rejects(apply(reviewed.previewId,{cacheRoot,stateRoot}),/registry.*(?:changed|review)|(?:changed|review).*registry/i);
  assert.deepEqual(await readdir(root),[]);await assert.rejects(readFile(applyRecordPath(root,stateRoot)),{code:'ENOENT'});
 }finally{if(original===undefined)delete process.env.RIGUP_NPM_REGISTRY;else process.env.RIGUP_NPM_REGISTRY=original;}
}))));

for(const interruption of [undefined,'after-checks','after-manifest'])test('replayed runtime checks do not verify changed inputs: '+(interruption??'completed'),()=>project(root=>project(cacheRoot=>project(async stateRoot=>{
 const name='RIGUP_TEST_REPLAY_TOKEN',original=process.env[name],marker=join(cacheRoot,'check-runs');
 process.env[name]='synthetic-first-private-input';
 try{
  await writeFile(join(root,'environment.mjs'),'import {appendFileSync} from "node:fs";appendFileSync(process.argv[2],"run\\n");process.exit(process.env.'+name+'==="synthetic-first-private-input"?0:1);\n');
  const selected:SetupOptions={agents:[],backend:'host',sdd:'openspec',customer:{commands:{environment:{executable:process.execPath,args:['environment.mjs',marker],cwd:'.',envRefs:[name]}}}};
  const profile=await scanRepository(root,selected);
  const generated=await generateFoundation(profile,selected,await prepareGeneration(profile,selected));generated.runChecks=['environment'];
  const reviewed=await preview(generated,[],{cacheRoot});assert.equal(reviewed.executable,true,reviewed.blockers.join('\n'));
  if(interruption)await assert.rejects(apply(reviewed.previewId,{cacheRoot,stateRoot,hook:async point=>{if(point===interruption)throw Error('controller interrupted after checks');}}),/controller interrupted/);
  else{
   const first=await apply(reviewed.previewId,{cacheRoot,stateRoot});
   assert.equal(first.runtimeSetup?.capabilities.find(item=>item.capability==='customer:environment')?.verification,'passed');
  }
  assert.equal(await readFile(marker,'utf8'),'run\n');
  const path=join(root,'.rigup/.env');await writeFile(path,(await readFile(path,'utf8')).replace('synthetic-first-private-input','synthetic-second-private-input'));
  const replay=await apply(reviewed.previewId,{cacheRoot,stateRoot,recover:true});
  assert.equal(replay.runtimeSetup?.capabilities.find(item=>item.capability==='customer:environment')?.verification,'not-run');
  assert.equal(await readFile(marker,'utf8'),'run\n','recovery must not silently rerun a completed check');
  assert.doesNotMatch(JSON.stringify(replay),/synthetic-(?:first|second)-private-input/);
 }finally{if(original===undefined)delete process.env[name];else process.env[name]=original;}
}))));
