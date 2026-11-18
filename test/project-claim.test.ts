import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {chmod,mkdir,readFile,readdir,rm,stat,writeFile} from 'node:fs/promises';
import {devNull} from 'node:os';
import {isAbsolute,join,relative} from 'node:path';
import {test} from 'node:test';
import {promisify} from 'node:util';
import {runCli} from '../src/cli.js';
import {signature} from '../src/generator/cache.js';
import {prepareRigupResearchMcp} from '../src/integrations/agents/rigup-config.js';
import {saveOpenSpecPreparation} from '../src/integrations/sdd/openspec-project.js';
import type {OpenSpecPreparation} from '../src/integrations/sdd/openspec-setup.js';
import {apply} from '../src/installer/apply.js';
import {loadManifest,trustedBaseline} from '../src/installer/baseline.js';
import {loadPreview} from '../src/installer/preview.js';
import {project,testEnvironment} from './helpers.js';

const exec=promisify(execFile);
const gitEnv={...process.env,GIT_CONFIG_GLOBAL:devNull,GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0'};
const git=async (cwd:string,...args:string[])=>(await exec('git',args,{cwd,env:gitEnv})).stdout;
const failUnexpected=async()=>{throw Error('Claim must not run an external operation');};
const cliServices=(workspace:string)=>({
 cacheRoot:join(workspace,'cache'), stateRoot:join(workspace,'state'),
 backend:{run:failUnexpected}, npmView:failUnexpected,
});
async function command(workspace:string,root:string,args:string[],exit:number,isTTY=false){
 let output='',stderr='';
 let report:Record<string,unknown>={};
 const code=await runCli(isTTY?args:[...args,'--json'],{
  cwd:root,isTTY,outputIsTTY:isTTY,ask:failUnexpected,write:text=>output+=text,writeError:text=>stderr+=text,
  services:{...cliServices(workspace),report:value=>{report=value;}},
 });
 assert.equal(code,exit,output+stderr);
 return {result:isTTY?report:JSON.parse(output),text:isTTY?output:stderr};
}
async function init(workspace:string,root:string,agents='claude'){
 const {result}=await command(workspace,root,['init','--agents',agents,'--sdd','none','--defer-research','--review'],3);
 await command(workspace,root,['update','--apply',result.previewId],0);
}
async function source(workspace:string){
 const root=join(workspace,'source');
 await mkdir(root);
 await git(root,'init','--quiet');
 await git(root,'config','core.autocrlf','false');
 return root;
}
async function commit(root:string){
 await git(root,'add','--all');
 await git(root,'-c','user.name=Rigup Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','--quiet','-m','fixture');
}
async function clone(workspace:string,root:string,autocrlf='false'){
 const target=join(workspace,'clone-'+autocrlf);
 await git(workspace,'clone','--quiet','--no-local','--config','core.autocrlf='+autocrlf,root,target);
 return target;
}
async function tracked(root:string){
 const paths=(await git(root,'ls-files','-z')).split('\0').filter(Boolean);
 return Promise.all(paths.map(async path=>{
  const file=join(root,path);
  const bytes=await readFile(file);
  return {path,bytes,hash:createHash('sha256').update(bytes).digest('hex'),mode:(await stat(file)).mode&0o777};
 }));
}

test('CLI claims a committed Claude setup in LF and CRLF clones',()=>project(async workspace=>{
 const original=await source(workspace);
 await init(workspace,original);
 const entry=join(original,'CLAUDE.md');
 await writeFile(entry,'Customer header\n'+await readFile(entry,'utf8')+'Customer footer\n');
 const mcp=join(original,'.mcp.json');
 const config=JSON.parse(await readFile(mcp,'utf8'));
 config.mcpServers.user={url:'https://example.invalid/mcp',type:'http'};
 await writeFile(mcp,JSON.stringify(config,null,2)+'\n');
 await commit(original);
 for(const mode of ['false','true']){
  const root=await clone(workspace,original,mode);
  const before=await tracked(root);
  assert.equal(before.length,4);
  assert.equal(before.every(file=>file.bytes.includes(Buffer.from('\r\n'))),mode==='true');
  assert.equal(await loadManifest(root),undefined);
  assert.equal(await git(root,'status','--porcelain'),'');
  const doctor=await command(workspace,root,['doctor'],3);
  assert.match(doctor.result.nextCommand,/rigup update .* --review/);
  const update=await command(workspace,root,['update','--review','--language','en'],3);
  assert.deepEqual(update.result.claim,{agents:['claude']});
  assert.equal(update.result.executable,true);
  assert.doesNotMatch(update.text,/\.codex\/config\.toml|AGENTS\.md/);
  const review=await command(workspace,root,['init','--review','--language','en'],3,true);
  assert.match(review.text,/only.*local installation record/i);
  assert.deepEqual(review.result.claim,{agents:['claude']});
  assert.equal(await loadManifest(root),undefined);
  const approval=await loadPreview(update.result.previewId,join(workspace,'cache','previews'));
  assert.ok(approval.preview.items.every(item=>item.action==='keep'||item.action==='noop'));
  assert.deepEqual(approval.plan.options.agents,['claude']);
  const applied=await command(workspace,root,['update','--apply',update.result.previewId],0);
  assert.deepEqual(applied.result.written,[]);
  assert.deepEqual(await tracked(root),before);
  assert.equal(await git(root,'status','--porcelain'),'');
  const installed=await loadManifest(root);
  assert.deepEqual(installed?.options?.agents,['claude']);
  assert.equal(installed?.assets.some(asset=>asset.logicalId==='mcp:claude:user'),false);
  for(const asset of installed!.assets)assert.notEqual(await trustedBaseline(root,asset),undefined);
 }
}));

test('empty and unrelated repositories point to init without creating a preview',()=>project(async workspace=>{
 const root=await source(workspace);
 for(const addOrdinaryFiles of [false,true]){
  if(addOrdinaryFiles){
   await writeFile(join(root,'AGENTS.md'),'Team instructions\n');
   await writeFile(join(root,'.mcp.json'),JSON.stringify({mcpServers:{
    rigup:{type:'http',url:'https://example.invalid/rigup-mcp.mjs'},
    unrelated:{command:'node',args:['.rigup/rigup-mcp.mjs']},
   }}));
  }
  const before=await readdir(root);
  for(const args of [['update'],['update','--backend','host','--review'],['doctor']]){
   const {result}=await command(workspace,root,args,3);
   assert.match(result.nextCommand,/^rigup init /);
   assert.ok(!result.claim);
   assert.ok(!result.previewId||result.previewId==='doctor');
  }
  assert.deepEqual(await readdir(root),before);
 }
}));

test('fresh noninteractive init uses PATH only when agent selection is absent',t=>project(async workspace=>{
 const root=await source(workspace);
 const bin=join(workspace,'bin');
 await mkdir(bin);
 testEnvironment(t,{RIGUP_CONSUMER_PATH:bin});
 const noAgent=await command(workspace,root,['init','--review'],3);
 assert.equal(noAgent.result.previewId,undefined);
 assert.match(JSON.stringify(noAgent.result.requiredInput),/--agents/);
 await writeFile(join(bin,process.platform==='win32'?'claude.cmd':'claude'),'',{mode:0o755});
 for(const [args,agent] of [[[], 'claude'],[['--agents','omp'],'omp']] as const){
  const {result}=await command(workspace,root,['init','--review',...args],3);
  const data=await loadPreview(result.previewId,join(workspace,'cache','previews'));
  assert.deepEqual(data.plan.options.agents,[agent]);
 }
 const profile=join(root,'setup.yaml');
 await writeFile(profile,'agents: [opencode]\n');
 const preferred=await command(workspace,root,['init','--profile',profile,'--review'],3);
 assert.deepEqual((await loadPreview(preferred.result.previewId,join(workspace,'cache','previews'))).plan.options.agents,['opencode']);
 await writeFile(profile,'agents: []\n');
 const noSelection=await command(workspace,root,['init','--profile',profile,'--review'],3);
 assert.equal(noSelection.result.previewId,undefined);
}));

test('recovery uses exact services and rejects dangling project state',()=>project(async workspace=>{
 const original=await source(workspace);
 await init(workspace,original,'claude,codex,opencode,omp');
 await commit(original);
 const root=await clone(workspace,original);
 const all=await command(workspace,root,['update','--review'],3);
 assert.deepEqual(all.result.claim?.agents,['claude','codex','opencode','omp']);
 const codex=join(root,'.codex','config.toml');
 const codexConfig=await readFile(codex,'utf8');
 await writeFile(codex,codexConfig+'\n[mcp_servers.rigup.env]\nFIXTURE = "local"\n');
 const nestedService=await command(workspace,root,['update','--review'],3);
 assert.equal(nestedService.result.previewId,undefined);
 assert.match(nestedService.text,/\.codex\/config\.toml/);
 await rm(codex);
 await rm(join(root,'opencode.jsonc'));
 const remaining=await command(workspace,root,['update','--review'],3);
 assert.deepEqual(remaining.result.claim?.agents,['claude','omp']);
 const target=join(root,'.mcp.json');
 const originalService=await readFile(target,'utf8');
 const modified=JSON.parse(originalService);
 modified.mcpServers.rigup.args[modified.mcpServers.rigup.args.length-1]='codex';
 await writeFile(target,JSON.stringify(modified));
 const badBinding=await command(workspace,root,['update','--review'],3);
 assert.equal(badBinding.result.previewId,undefined);
 assert.match(badBinding.text,/\.mcp\.json/);
 await writeFile(target,originalService);
 await rm(join(root,'.rigup','rigup-mcp.mjs'));
 const missingLauncher=await command(workspace,root,['update','--review'],3);
 assert.equal(missingLauncher.result.previewId,undefined);
 assert.match(missingLauncher.text,/\.rigup\/rigup-mcp\.mjs/);
 assert.equal(await loadManifest(root),undefined);
}));

test('claim preserves an older launcher and verified custom targets with rules disabled',()=>project(async workspace=>{
 const original=await source(workspace);
 await mkdir(join(original,'.rigup'));
 await mkdir(join(original,'custom-skill'));
 await writeFile(join(original,'custom-skill','SKILL.md'),'---\nname: clone-canary\ndescription: Fixture skill\n---\nCanary\n');
 await writeFile(join(original,'custom-skill','bytes.bin'),Buffer.from([0,1,255]),{mode:0o755});
 await writeFile(join(original,'source.md'),'# {{name}}\n');
 const config={
  agents:['claude'], sdd:'none', customSkills:[{source:'custom-skill'}],
  templates:[{source:'source.md',target:'docs/rigup/custom.md',values:{name:'Canary'}}],
  mcp:[{id:'custom',url:'https://example.invalid/mcp'}],
  tools:[{id:'codegraph',install:true,agents:['claude']}],
 };
 const file=join(original,'.rigup','config.yaml');
 await writeFile(file,JSON.stringify({...config,tools:[]}));
 await init(workspace,original);
 const {agents:_,...inherited}=config;
 await writeFile(file,JSON.stringify({...inherited,projectRules:false}));
 const launcher=await readFile(new URL('../templates/rigup-mcp.mjs',import.meta.url),'utf8');
 await writeFile(join(original,'.rigup','rigup-mcp.mjs'),launcher.replace('__RIGUP_VERSION__','0.9.0'));
 await commit(original);
 const root=await clone(workspace,original,'true');
 const before=await tracked(root);
 const {result}=await command(workspace,root,['update','--review'],3);
 assert.deepEqual(result.claim,{agents:['claude']});
 assert.equal(result.executable,true);
 const installed=await apply(result.previewId,{
  cacheRoot:join(workspace,'cache','previews'),stateRoot:join(workspace,'state'),runChecks:failUnexpected,
 });
 assert.deepEqual(installed.written,[]);
 assert.deepEqual(installed.operations,[]);
 assert.deepEqual(await tracked(root),before);
 assert.equal(await git(root,'status','--porcelain'),'');
 const manifest=await loadManifest(root);
 assert.equal(manifest?.options?.projectRules,false);
 assert.equal(manifest?.projectRules,undefined);
 assert.equal(manifest?.versions?.rigup,'0.9.0');
 assert.deepEqual(manifest?.installedTools,{});
 for(const id of ['mcp:claude:custom','skill:.claude/skills/clone-canary/bytes.bin','template:docs/rigup/custom.md']){
  const asset=manifest?.assets.find(entry=>entry.logicalId===id);
  assert.ok(asset,id);
  assert.notEqual(await trustedBaseline(root,asset),undefined);
 }
 assert.ok(!(await readdir(join(root,'.rigup'))).includes('.env'));
 const followup=await command(workspace,root,['update','--dry-run','--tools','none'],3);
 const next=await loadPreview(followup.result.previewId,join(workspace,'cache','previews'));
 assert.deepEqual(next.plan.options.agents,['claude']);
 assert.equal(next.plan.options.projectRules,false);
 assert.equal(next.preview.executable,false,'retirement still requires explicit consent');
 assert.deepEqual(await tracked(root),before);

 const localConfig=join(root,'.rigup','config.yaml');
 await writeFile(localConfig,JSON.stringify({...inherited,projectRules:false,documentLanguage:'en'}));
 const repeated=await apply(result.previewId,{
  cacheRoot:join(workspace,'cache','previews'),stateRoot:join(workspace,'state'),
 });
 assert.match(repeated.nextCommand!,/rigup update .* --review/);
 assert.equal(repeated.projectRules,undefined);
 assert.equal(repeated.sourceReview,undefined);
 assert.equal((await loadManifest(root))?.options?.projectRules,false);
}));

test('claim freshness and the original journal protect committed files',()=>project(async workspace=>{
 const original=await source(workspace);
 await init(workspace,original);
 await commit(original);
 const root=await clone(workspace,original);
 const prepare=async()=>(await command(workspace,root,['update','--review'],3)).result.previewId as string;
 const deps={cacheRoot:join(workspace,'cache','previews'),stateRoot:join(workspace,'state')};
 const entry=join(root,'CLAUDE.md');
 const before=await tracked(root);
 const stale=await prepare();
 await writeFile(entry,Buffer.concat([await readFile(entry),Buffer.from('Later edit\n')]));
 await assert.rejects(()=>apply(stale,deps),/changed/i);
 assert.equal(await loadManifest(root),undefined);
 await writeFile(entry,before.find(file=>file.path==='CLAUDE.md')!.bytes);
 const profile=join(workspace,'profile.yaml');
 await writeFile(profile,'agents: [claude]\n');
 const profiled=await command(workspace,root,['update','--profile',profile,'--review'],3);
 await writeFile(profile,'agents: [codex]\n');
 await assert.rejects(()=>apply(profiled.result.previewId,deps),/input changed.*profile.yaml/i);
 assert.equal(await loadManifest(root),undefined);
 const exclude=join(root,(await git(root,'rev-parse','--git-path','info/exclude')).trim());
 const oldExclude=await readFile(exclude);
 const ignoreFile=join(root,'.rigup','.gitignore');
 const oldIgnore=await readFile(ignoreFile);
 await writeFile(ignoreFile,oldIgnore.toString().replace('/manifest.json\n',''));
 await writeFile(exclude,'/.rigup/manifest.json\n');
 const unprotected=await prepare();
 await writeFile(exclude,oldExclude);
 await assert.rejects(()=>apply(unprotected,deps),/must be ignored by Git/i);
 assert.equal(await loadManifest(root),undefined);
 await writeFile(ignoreFile,oldIgnore);
 if(process.platform!=='win32'){
  const changedMode=await prepare();
  const initialMode=before.find(file=>file.path==='CLAUDE.md')!.mode;
  await chmod(entry,initialMode^0o100);
  await assert.rejects(()=>apply(changedMode,deps),/changed/i);
  await chmod(entry,initialMode);
 }
 const id=await prepare();
 const competing=await prepare();
 await assert.rejects(()=>apply(id,{...deps,hook:async point=>{if(point==='before-manifest')throw Error('simulated interruption');}}),/simulated interruption/);
 await assert.rejects(()=>apply(competing,{...deps,recover:true}),/original installation/i);
 const pending=await command(workspace,root,['update','--resume','--review'],3);
 assert.equal(pending.result.previewId,id);
 await assert.rejects(()=>apply(id,{...deps,recover:true,hook:async point=>{if(point==='after-manifest')throw Error('simulated finalization interruption');}}),/simulated finalization interruption/);
 for(const report of [await apply(id,{...deps,recover:true}),await apply(id,deps)])assert.deepEqual(report.written,[]);
 assert.deepEqual(await tracked(root),before);
 assert.equal(await git(root,'status','--porcelain'),'');
}));

const applyDeps=(workspace:string)=>({cacheRoot:join(workspace,'cache','previews'),stateRoot:join(workspace,'state')});
async function claimPreview(workspace:string,root:string){
 const {result}=await command(workspace,root,['update','--review'],3);
 assert.equal(result.executable,true);
 return result.previewId as string;
}

test('resuming a claim rechecks links to unmanaged files before publishing the manifest',()=>project(async workspace=>{
 const original=await source(workspace);
 await init(workspace,original);
 await writeFile(join(original,'guide.md'),'# Team guide\n');
 const entry=join(original,'CLAUDE.md');
 await writeFile(entry,(await readFile(entry,'utf8')).replace('<!-- rigup:end -->','- [Team guide](guide.md)\n<!-- rigup:end -->'));
 await commit(original);
 const root=await clone(workspace,original);
 const id=await claimPreview(workspace,root);
 const deps=applyDeps(workspace);
 await assert.rejects(()=>apply(id,{...deps,hook:async point=>{
  if(point==='before-manifest')throw Error('stop before publish');
 }}),/stop before publish/);
 await rm(join(root,'guide.md'));
 await assert.rejects(()=>apply(id,{...deps,recover:true}),/navigation link unavailable: guide\.md/);
 assert.equal(await loadManifest(root),undefined);
 await writeFile(join(root,'guide.md'),'# Team guide\n');
 assert.deepEqual((await apply(id,{...deps,recover:true})).written,[]);
 assert.equal(await git(root,'status','--porcelain'),'');
}));

test('missing external custom sources leave a warning while missing required outputs block a claim',()=>project(async workspace=>{
 const original=await source(workspace);
 const skill=join(workspace,'external-skill');
 const template=join(workspace,'external-template.md');
 const skillNote=join(workspace,'skill-note.md');
 const skillReference='.claude/skills/claim-external/references/note.md';
 await mkdir(skill);
 await writeFile(join(skill,'SKILL.md'),'---\nname: claim-external\ndescription: Fixture skill\n---\nCanary\n');
 await writeFile(template,'# Optional source\n');
 await writeFile(skillNote,'# Optional skill note\n');
 await mkdir(join(original,'.rigup'));
 await writeFile(join(original,'.rigup','config.yaml'),JSON.stringify({agents:['claude'],
  customSkills:[{source:skill}],templates:[{source:template,target:'docs/rigup/extra.md'},{source:skillNote,target:skillReference}],
 }));
 await init(workspace,original);
 await commit(original);
 const root=await clone(workspace,original);
 const before=await tracked(root);
 await rm(skill,{recursive:true});
 await rm(template);
 const candidate=await command(workspace,root,['update','--review'],3);
 assert.equal(candidate.result.executable,true);
 for(const path of [skill,template,skillReference])assert.ok(candidate.result.warnings.some((warning:string)=>warning.includes(path)),path);
 const target=join(root,'docs','rigup','extra.md');
 const bytes=await readFile(target);
 await rm(target);
 const blocked=await command(workspace,root,['update','--review'],1);
 assert.equal(blocked.result.executable,false);
 assert.match(blocked.result.blockers.join('\n'),/navigation link unavailable: docs\/rigup\/extra\.md/);
 assert.equal(await loadManifest(root),undefined);
 await writeFile(target,bytes);
 const report=await apply(candidate.result.previewId,applyDeps(workspace));
 assert.deepEqual(report.written,[]);
 const manifest=await loadManifest(root);
 assert.ok(manifest?.assets.some(asset=>asset.logicalId==='mcp:claude:rigup'));
 assert.equal(manifest?.assets.some(asset=>asset.target==='docs/rigup/extra.md'||asset.target===skillReference||asset.logicalId.startsWith('skill:')),false);
 assert.deepEqual(await tracked(root),before);
}));

test('a launcher string in an unrelated OMP service URL does not imply a Rigup command',()=>project(async workspace=>{
 const original=await source(workspace);
 await init(workspace,original);
 await mkdir(join(original,'.omp'));
 const userCommand={mcpServers:{rigup:{type:'http',url:'https://example.invalid/.rigup/rigup-mcp.mjs'}}};
 await writeFile(join(original,'.omp','mcp.json'),JSON.stringify(userCommand));
 await commit(original);
 const root=await clone(workspace,original);
 const id=await claimPreview(workspace,root);
 const data=await loadPreview(id,applyDeps(workspace).cacheRoot);
 assert.deepEqual(data.preview.claim?.agents,['claude']);
 assert.ok(data.plan.assets.every(asset=>asset.target!=='.omp/mcp.json'));
 const rigup=JSON.parse((await prepareRigupResearchMcp(root,'omp')).content);
 rigup.command='different-node';
 rigup.args[rigup.args.length-1]='claude';
 await writeFile(join(root,'.omp','mcp.json'),JSON.stringify({mcpServers:{rigup}}));
 const broken=await command(workspace,root,['update','--review'],3);
 assert.equal(broken.result.previewId,undefined);
 assert.match(broken.result.pending.join('\n'),/\.omp\/mcp\.json/);
}));

test('claim approval rejects edits after option resolution for config and profile inputs',()=>project(async workspace=>{
 const original=await source(workspace);
 await init(workspace,original);
 await commit(original);
 const root=await clone(workspace,original);
 const projectConfig=join(root,'.rigup','config.yaml');
 for(const mode of ['config','profile']){
  const edited=mode==='config'?projectConfig:join(workspace,'profile.yaml');
  await writeFile(projectConfig,'agents: [claude]\n');
  await writeFile(edited,'agents: [claude]\nprojectRules: false\n');
  const args=['update','--review','--language','en',...(mode==='profile'?['--profile',edited]:[])];
  let output='',changed=false;
  const exit=await runCli([...args,'--json'],{
   cwd:root,isTTY:false,write:text=>output+=text,services:cliServices(workspace),
   writeError:text=>{
    if(changed||!text.startsWith('update: '))return;
    writeFileSync(edited,'agents: [claude]\nprojectRules: true\n');
    changed=true;
   },
  });
  assert.equal(changed,true);
  assert.equal(exit,2,output);
  const report=JSON.parse(output);
  assert.equal(report.previewId,undefined);
  assert.match(report.error,/config\.yaml|profile\.yaml/);
  const next=await command(workspace,root,args,3);
  const approved=await loadPreview(next.result.previewId,applyDeps(workspace).cacheRoot);
  assert.equal(approved.plan.options.projectRules,true);
 }
}));

test('claim leaves a customized Codex service with nested env outside the adopted inventory',()=>project(async workspace=>{
 const original=await source(workspace);
 await mkdir(join(original,'.rigup'));
 await writeFile(join(original,'.rigup','config.yaml'),JSON.stringify({agents:['codex'],
  mcp:[{id:'custom',url:'https://example.invalid/mcp'}],
 }));
 await init(workspace,original,'codex');
 const config=join(original,'.codex','config.toml');
 await writeFile(config,(await readFile(config,'utf8'))+'\n[mcp_servers.custom.env]\nFIXTURE = "override"\n');
 await commit(original);
 const root=await clone(workspace,original);
 const before=await tracked(root);
 const review=await command(workspace,root,['update','--review'],3);
 assert.equal(review.result.executable,true);
 assert.match(review.result.warnings.join('\n'),/\.codex\/config\.toml/);
 const report=await apply(review.result.previewId,applyDeps(workspace));
 assert.deepEqual(report.written,[]);
 const manifest=await loadManifest(root);
 assert.ok(manifest?.assets.some(asset=>asset.logicalId==='mcp:codex:rigup'));
 assert.ok(!manifest?.assets.some(asset=>asset.logicalId==='mcp:codex:custom'));
 assert.deepEqual(await tracked(root),before);
}));

test('a saved claim reports the original OpenSpec resume command and waits',()=>project(async workspace=>{
 const original=await source(workspace);
 await init(workspace,original);
 await commit(original);
 const root=await clone(workspace,original);
 const id=await claimPreview(workspace,root);
 const {stateRoot}=applyDeps(workspace);
 const approval:OpenSpecPreparation={
  kind:'existing',scope:'global',root,agents:['claude'],needsRoot:true,needsEntries:[],
  cliIdentity:'fixture',cliVersion:'1.16.0',
 };
 const record={version:1 as const,root,approval,approvalDigest:signature(approval),complete:false};
 await saveOpenSpecPreparation(record,stateRoot);
 const blockedPreview=await command(workspace,root,['update','--review'],3);
 const blockedApply=await command(workspace,root,['update','--apply',id],3);
 assert.match(blockedApply.result.nextCommand,/--install-scope global --resume$/);
 assert.equal(blockedApply.result.nextCommand,blockedPreview.result.nextCommand);
 assert.match(blockedApply.result.pending.join('\n'),/Resume the original OpenSpec preparation/);
 assert.deepEqual(blockedApply.result.written,[]);
 assert.equal(await loadManifest(root),undefined);
 assert.ok(!(await readdir(join(root,'.rigup'))).includes('baseline'));
 await saveOpenSpecPreparation({...record,complete:true},stateRoot);
 assert.deepEqual((await command(workspace,root,['update','--apply',id],0)).result.written,[]);
}));

test('a hard interruption during claim publication leaves its manifest stage ignored',()=>project(async workspace=>{
 const original=await source(workspace);
 await init(workspace,original);
 await commit(original);
 const root=await clone(workspace,original);
 const id=await claimPreview(workspace,root);
 const deps=applyDeps(workspace);
 const script=[
  "import fs from 'node:fs/promises';",
  "import {writeSync} from 'node:fs';",
  "import {syncBuiltinESMExports} from 'node:module';",
  'const rename=fs.rename;',
  'fs.rename=async (src,dst)=>{',
  ' if(dst==='+JSON.stringify(join(root,'.rigup','manifest.json'))+'){writeSync(1,src);process.kill(process.pid,"SIGKILL");}',
  ' return rename(src,dst);',
  '};',
  'syncBuiltinESMExports();',
  'const {apply}=await import('+JSON.stringify(new URL('../src/installer/apply.ts',import.meta.url).href)+');',
  'await apply('+JSON.stringify(id)+','+JSON.stringify(deps)+');',
 ].join('\n');
 let stage='';
 await assert.rejects(()=>exec(process.execPath,['--import','tsx','--input-type=module','-e',script]),error=>{
  const stopped=error as {signal?:string;code?:number;stdout?:string};
  stage=stopped.stdout??'';
  return stage.length>0&&(process.platform==='win32'?stopped.code===1:stopped.signal==='SIGKILL');
 });
 assert.equal(await loadManifest(root),undefined);
 assert.equal(await git(root,'status','--porcelain'),'');
 const stagedIn=relative(join(root,'.rigup','baseline'),stage);
 assert.ok(!isAbsolute(stagedIn)&&!stagedIn.startsWith('..'));
 assert.ok((await stat(stage)).isFile());
 assert.deepEqual((await apply(id,{...deps,recover:true})).written,[]);
 assert.equal(await git(root,'status','--porcelain'),'');
}));
