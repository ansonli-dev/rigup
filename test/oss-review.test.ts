import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chmod, mkdir, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises';
import {join, relative} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {project} from './helpers.js';
import {executeLifecycle} from '../src/lifecycle.js';
import {loadOptions} from '../src/config.js';
import {filterContent, READ_POLICY_VERSION} from '../src/analyzer/read-policy.js';
import {loadManifest} from '../src/installer/baseline.js';
import {doctor} from '../src/installer/doctor.js';
import {apply, restoreInterruptedPreview} from '../src/installer/apply.js';
import {preview, loadPreview} from '../src/installer/preview.js';
import {scanRepository} from '../src/analyzer/repository.js';
import {generate} from '../src/generator/generate.js';
import {signature, saveCache} from '../src/generator/cache.js';

const exec = promisify(execFile);
const backend = {run: async ():Promise<never> => {throw Error('No model call is permitted in this regression');}};
async function skillFixture(fn:(fixture:any)=>Promise<void>) {
  await project(async control => {
    const root=join(control,'project'), skill=join(control,'skill'), cache=join(control,'cache'), state=join(control,'state');
    await mkdir(root); await mkdir(skill);
    await writeFile(join(skill,'SKILL.md'),'---\nname: oss-review-canary\ndescription: Regression fixture\n---\nRead the current task.\n');
    const source=join(skill,'run.sh'), target=join(root,'.agents/skills/oss-review-canary/run.sh');
    await writeFile(source,'#!/bin/sh\nprintf "fixture\\n"\n'); await chmod(source,0o644);
    const options={agents:['codex' as const],backend:'host' as const,customSkills:[{source:skill}]};
    const services={cacheRoot:cache,stateRoot:state,backend};
    const install=()=>executeLifecycle(root,options,{yes:true,sessionsEnded:true},()=>{},services);
    const prepare=async()=>{
      const generated=await generate(await scanRepository(root,options),options,backend,(await loadManifest(root))?.assets??[],{cacheRoot:join(cache,'generation')});
      if(generated.status!=='complete')throw Error('Deterministic fixture did not produce a plan');
      return preview(generated.value,[],{cacheRoot:cache});
    };
    await fn({control,root,skill,source,target,cache,state,options,install,prepare});
  });
}
const mode=async(path:string)=>(await stat(path)).mode&0o777;

test('review handoff shell command round-trips hostile directory names without expansion',()=>project(async control=>{
  const root=join(control,'project$(touch dollar-marker)`touch tick-marker` \'" spaced\nline');
  await mkdir(root);let report:any;
  const code=await executeLifecycle(root,{agents:['codex'],backend:'host'},{review:true},()=>{},{cacheRoot:join(control,'cache'),stateRoot:join(control,'state'),backend,report:value=>{report=value;}});
  assert.equal(code,3);assert.ok(report.nextCommand);
  const output=await exec('sh',['-c','rigup() { printf "%s\\0" "$@"; }\n'+report.nextCommand],{cwd:control});
  assert.deepEqual(output.stdout.split('\0').slice(0,-1),['update',root,'--apply',report.previewId,'--sessions-ended']);
  assert.ok(!(await readdir(control)).some(name=>name==='dollar-marker'||name==='tick-marker'));
}));

test('review structured credential comments are redacted with line accounting and quoted hashes preserved',()=>{
  for(const [path,raw] of [
    ['settings.jsonc','{\n // api_key = review-jsonc-canary\n "safe": "public # marker" // public comment\n}\n'],
    ['settings.toml','safe = "public # marker" # password = review-toml-canary\n# public comment\n'],
    ['settings.yaml','safe: "public # marker" # token: review-yaml-canary\n# public comment\n'],
    ['block.jsonc','{\n /* password = review-block-canary\n    another line */\n "safe": "public # marker"\n}\n'],
  ]){
    const filtered=filterContent(path,raw);
    assert.doesNotMatch(filtered,/review-(?:jsonc|toml|yaml|block)-canary/);
    assert.equal(filtered.split('\n').length,raw.split('\n').length);
    assert.match(filtered,/public # marker/);
  }
});

test('review real host export excludes credential containers and sensitive comments under a revised policy',()=>project(async control=>{
  const root=join(control,'project');await mkdir(root);
  const sources={
    'settings.jsonc':'{\n // api_key = export-jsonc-canary\n "safe": true\n}\n',
    'settings.toml':'safe = true\n# password = export-toml-canary\n',
    'settings.yaml':'safe: true\n# token = export-yaml-canary\n',
    '.netrc':'machine example.test login user password export-netrc-canary\n',
  };
  for(const [name,text]of Object.entries(sources))await writeFile(join(root,name),text);
  let report:any;
  const code=await executeLifecycle(root,{agents:['codex'],backend:'host',sdd:'openspec'},{dryRun:true},()=>{},{cacheRoot:join(control,'cache'),stateRoot:join(control,'state'),report:value=>{report=value;}});
  assert.equal(code,3);assert.equal(report.phase,'research');
  const exported=await readFile(report.requestPath,'utf8');
  assert.doesNotMatch(exported,/export-(?:jsonc|toml|yaml|netrc)-canary/);
  assert.notEqual(READ_POLICY_VERSION,'4','old accepted evidence must be invalidated');
  const profile=await scanRepository(root,{agents:['codex'],backend:'host'});assert.ok(!profile.files.includes('.netrc'));
}));

test('browser authentication snapshots and credential backups never enter research exports',()=>project(async control=>{
  const root=join(control,'project');await mkdir(root);await mkdir(join(root,'.auth'));
  const browser=JSON.stringify({cookies:[{name:'session',value:'browser-cookie-canary'}],origins:[{origin:'https://example.test',localStorage:[{name:'session',value:'browser-local-canary'}]}]});
  await writeFile(join(root,'.auth/user.json'),browser);await writeFile(join(root,'browser-state.json'),browser);
  await writeFile(join(root,'.netrc.backup'),'machine example.test login user password backup-netrc-canary\n');
  // Synthetic marker with no cryptographic key material; exercise content denial.
  const key='-----BEGIN '+'PRIVATE KEY-----\nbackup-key-canary\n-----END PRIVATE KEY-----\n';
  await writeFile(join(root,'dev.key.backup'),key);await writeFile(join(root,'certificate-notes.txt'),key);
  let report:any;
  assert.equal(await executeLifecycle(root,{agents:['codex'],backend:'host',sdd:'openspec'},{dryRun:true},()=>{},{cacheRoot:join(control,'cache'),stateRoot:join(control,'state'),report:value=>{report=value;}}),3);
  const exported=await readFile(report.requestPath,'utf8');assert.doesNotMatch(exported,/browser-(?:cookie|local)-canary|backup-(?:netrc|key)-canary/);
  const profile=await scanRepository(root,{agents:['codex'],backend:'host'});for(const path of ['.auth/user.json','.netrc.backup','dev.key.backup','certificate-notes.txt'])assert.ok(!profile.files.includes(path));
  assert.notEqual(READ_POLICY_VERSION,'5','invalidate earlier browser-state exports');
}));

test('review binary skill resources survive repeated lifecycle and byte updates',()=>skillFixture(async({root,skill,install})=>{
  const bytes=Buffer.from([0,1,2,3,255]);await writeFile(join(skill,'image.bin'),bytes);
  assert.equal(await install(),0);assert.equal(await install(),0);
  const target=join(root,'.agents/skills/oss-review-canary/image.bin');assert.deepEqual(await readFile(target),bytes);
  const next=Buffer.from([255,0,4,5]);await writeFile(join(skill,'image.bin'),next);assert.equal(await install(),0);assert.deepEqual(await readFile(target),next);
}));

test('review upstream mode-only skill update is installed and truthfully diagnosed',()=>skillFixture(async({root,source,target,install})=>{
  assert.equal(await install(),0);assert.equal(await mode(target),0o644);
  await chmod(source,0o755);assert.equal(await install(),0);assert.equal(await mode(target),0o755);
  const manifest=await loadManifest(root);assert.equal(manifest!.assets.find(asset=>asset.target.endsWith('/run.sh'))!.mode,0o755);
  const health=await doctor(root);assert.equal(health.diagnostics.find(item=>item.id.endsWith('/run.sh'))?.state,'configured');
}));

test('review user chmod is preserved and diagnosed while divergent upstream chmod conflicts',()=>skillFixture(async({root,source,target,install})=>{
  await chmod(source,0o755);assert.equal(await install(),0);
  await chmod(target,0o640);assert.equal(await install(),0);assert.equal(await mode(target),0o640);
  const health=await doctor(root);assert.equal(health.diagnostics.find(item=>item.id.endsWith('/run.sh'))?.state,'pending');
  const before=(await loadManifest(root))!.installId;
  await chmod(source,0o700);assert.equal(await install(),1);assert.equal(await mode(target),0o640);assert.equal((await loadManifest(root))!.installId,before);
}));

test('review chmod after preview invalidates apply before writes',()=>skillFixture(async({root,source,target,cache,state,install,prepare})=>{
  await install();const before=(await loadManifest(root))!.installId;
  await chmod(source,0o755);const view=await prepare();assert.equal(view.executable,true);
  const item=view.items.find((entry:any)=>entry.target.endsWith('/run.sh'));assert.equal(item.action,'update');assert.equal(item.beforeMode,0o644);assert.equal(item.afterMode,0o755);
  await chmod(target,0o600);await assert.rejects(apply(view.previewId,{cacheRoot:cache,stateRoot:state}),/mode|permission|stale|changed/);
  assert.equal(await mode(target),0o600);assert.equal((await loadManifest(root))!.installId,before);
}));

test('review interrupted mode-only application survives ordinary-cache loss',()=>skillFixture(async({root,source,target,cache,state,options,install,prepare})=>{
  await install();const before=(await loadManifest(root))!.installId;await chmod(source,0o755);const view=await prepare();
  await assert.rejects(apply(view.previewId,{cacheRoot:cache,stateRoot:state,hook:async point=>{if(point==='after-file')throw Error('interrupt after mode write');}}),/interrupt after mode write/);
  assert.equal(await mode(target),0o755);assert.equal((await loadManifest(root))!.installId,before);
  await rm(cache,{recursive:true,force:true});assert.equal(await restoreInterruptedPreview(root,options,cache,state),view.previewId);
  assert.equal((await apply(view.previewId,{cacheRoot:cache,stateRoot:state,recover:true})).exitCode,0);assert.equal(await mode(target),0o755);
}));

test('review recovery rejects a user chmod even when bytes match both before and after',()=>skillFixture(async({root,source,target,cache,state,install,prepare})=>{
  await install();const before=(await loadManifest(root))!.installId;await chmod(source,0o755);const view=await prepare();
  await assert.rejects(apply(view.previewId,{cacheRoot:cache,stateRoot:state,hook:async point=>{if(point==='after-file')throw Error('interrupt mode write');}}),/interrupt mode write/);
  await chmod(target,0o700);await assert.rejects(apply(view.previewId,{cacheRoot:cache,stateRoot:state,recover:true}),/mode|permission|changed/);
  assert.equal(await mode(target),0o700);assert.equal((await loadManifest(root))!.installId,before);
}));

test('review final verification and completed replay check actual modes',()=>skillFixture(async({root,source,target,cache,state,install,prepare})=>{
  await install();const before=(await loadManifest(root))!.installId;await chmod(source,0o755);const view=await prepare();
  await assert.rejects(apply(view.previewId,{cacheRoot:cache,stateRoot:state,hook:async point=>{if(point==='before-manifest')await chmod(target,0o700);}}),/mode|permission|differs|changed/);
  assert.equal((await loadManifest(root))!.installId,before);
  await chmod(target,0o755);assert.equal((await apply(view.previewId,{cacheRoot:cache,stateRoot:state,recover:true})).exitCode,0);
  await chmod(target,0o700);await assert.rejects(apply(view.previewId,{cacheRoot:cache,stateRoot:state}),/mode|permission|changed/);
}));

test('review legacy previews without mode preconditions require regeneration',()=>skillFixture(async({source,target,cache,state,install,prepare})=>{
  await install();await chmod(source,0o755);const view=await prepare();const data:any=await loadPreview(view.previewId,cache);
  delete data.modePolicyVersion;for(const file of data.files)delete file.observedMode;
  await saveCache(join(cache,view.previewId+'.json'),JSON.stringify({digest:signature(data),data}));
  await assert.rejects(apply(view.previewId,{cacheRoot:cache,stateRoot:state}),/mode|permission|regenerate/);assert.equal(await mode(target),0o644);
}));

test('review profiles accept both absolute and project-relative explicit paths',()=>project(async control=>{
  const root=join(control,'project');await mkdir(root);const profile=join(control,'team.yaml');await writeFile(profile,'agents: [opencode]\nbackend: host\n');
  for(const path of [profile,relative(root,profile)]){const options=await loadOptions(root,{profile:path});assert.deepEqual(options.agents,['opencode']);assert.equal(options.backend,'host');}
}));
