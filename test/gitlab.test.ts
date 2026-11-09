import {test} from 'node:test';import assert from 'node:assert/strict';
import {project} from './helpers.js';import {writeFile,readFile} from 'node:fs/promises';
import {prepareGitlab} from '../src/integrations/gitlab/ci.js';import {replaceOwned} from '../src/installer/ownership.js';import {parse} from 'yaml';
import {execFile,spawnSync} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve} from 'node:path';
const exec=promisify(execFile);
const testCommand={executable:'npm',args:['run','test'],cwd:'.',envRefs:[]};
test('GitLab runs checks and OpenWiki through native job commands and reports',()=>project(async root=>{
 const selection={checks:['test' as const],reportPaths:['reports/junit.xml'],openwiki:{envRefs:['MODEL_TOKEN'],sourcePaths:['src/**/*']}};
 const result=await prepareGitlab(root,selection,[{executable:'npm',args:['run','test'],cwd:'app',envRefs:[]}]);
 const jobs=parse(result.assets.find(asset=>asset.target==='.rigup/gitlab-ci.yml')!.content);
 assert.match(jobs['rigup:checks'].script.join('\n'),/npm.*run.*test/);
 assert.deepEqual(jobs['rigup:checks'].artifacts.reports.junit,['reports/junit.xml']);
 assert.match(jobs['rigup:openwiki'].script.join('\n'),/openwiki --update --mode code --print/);
 assert.ok(result.assets.every(asset=>!asset.target.startsWith('.rigup/scripts/')));
}));
test('gitlab_include_preserves_existing_jobs_comments_and_includes',()=>project(async root=>{
 const original='# keep comment\ninclude:\n  - local: customer.yml\n\ncustomer-job:\n  script: echo customer\n';await writeFile(root+'/.gitlab-ci.yml',original);const result=await prepareGitlab(root,{checks:['test']},[testCommand]);const asset=result.assets.find(a=>a.target==='.gitlab-ci.yml')!;assert.ok(asset);const next=replaceOwned(original,asset.ownership,asset.content)!;assert.match(next,/# keep comment/);const config=parse(next);assert.equal(config['customer-job'].script,'echo customer');assert.deepEqual(config.include,[{local:'customer.yml'},{local:'.rigup/gitlab-ci.yml'}]);
}));
test('wiki_update_has_no_self_trigger_loop',()=>project(async root=>{
 const result=await prepareGitlab(root,{checks:[],openwiki:{envRefs:['ANTHROPIC_API_KEY'],sourcePaths:['src/**/*']}},[]);const ci=result.assets.find(a=>a.target==='.rigup/gitlab-ci.yml')!;assert.ok(ci);const config=parse(ci.content);const job=config['rigup:openwiki'];assert.ok(job.rules.some((r:any)=>r.when==='never'));assert.deepEqual(job.rules.find((r:any)=>r.changes).changes,['src/**/*']);assert.doesNotMatch(ci.content,/git push|git commit/);
}));
test('standalone_gitlab_jobs_have_a_regular_stage_on_initial_and_repeated_setup',()=>project(async root=>{
 const selection={checks:['test' as const],openwiki:{envRefs:['MODEL_TOKEN'],sourcePaths:['src/**/*']}};
 for(const repeated of [false,true]){
  if(repeated)await writeFile(root+'/.gitlab-ci.yml','# rigup:ci:start\ninclude:\n  - local: .rigup/gitlab-ci.yml\n# rigup:ci:end\n');
  const result=await prepareGitlab(root,selection,[testCommand]);const jobs=parse(result.assets.find(a=>a.target==='.rigup/gitlab-ci.yml')!.content);
  assert.equal(jobs['rigup:checks'].stage,'test');assert.equal(jobs['rigup:openwiki'].stage,'test');assert.deepEqual(result.requirements,[]);
 }
}));
test('gitlab_jobs_use_an_existing_regular_stage_without_replacing_customer_stages',()=>project(async root=>{
 const original='stages: [compile, verify, publish]\ncustomer-job:\n  stage: compile\n  script: echo customer\n';await writeFile(root+'/.gitlab-ci.yml',original);
 const result=await prepareGitlab(root,{checks:['test']},[testCommand]);const jobs=parse(result.assets.find(a=>a.target==='.rigup/gitlab-ci.yml')!.content);assert.equal(jobs['rigup:checks'].stage,'compile');
 assert.equal(await readFile(root+'/.gitlab-ci.yml','utf8'),original);
}));
test('gitlab_reserved_only_stages_require_a_customer_decision',()=>project(async root=>{
 await writeFile(root+'/.gitlab-ci.yml','stages: [.pre, .post]\n');const result=await prepareGitlab(root,{checks:['test']},[testCommand]);assert.ok(result.requirements.some(r=>/regular stage/.test(r.reason)));
}));
test('gitlab_external_include_stages_are_not_guessed',()=>project(async root=>{
 await writeFile(root+'/.gitlab-ci.yml','include:\n  - local: customer.yml\ncustomer-job:\n  stage: customer-stage\n  script: echo customer\n');
 const result=await prepareGitlab(root,{checks:['test']},[testCommand]);const jobs=parse(result.assets.find(a=>a.target==='.rigup/gitlab-ci.yml')!.content);assert.equal(jobs['rigup:checks'].stage,'.pre');
}));
async function runnerShell(root:string) {
 if(process.platform!=='win32')return 'sh';
 // Git for Windows ships the POSIX shell used by its native hooks.
 const {stdout}=await exec('git',['--exec-path'],{cwd:root});
 return resolve(stdout.trim(),'../../../bin/sh.exe');
}
async function fixtureCommit(root:string){
 await exec('git',['init','-q'],{cwd:root});
 await exec('git',['-c','user.name=Fixture','-c','user.email=fixture@example.org','commit','-qm','fixture','--allow-empty'],{cwd:root});
 return (await exec('git',['rev-parse','HEAD'],{cwd:root})).stdout.trim();
}
test('ci_preserves_exit_status_and_reports',()=>project(async root=>{
 const commit=await fixtureCommit(root);
 await writeFile(root+'/check.mjs',"import {mkdirSync,writeFileSync} from 'node:fs';if(process.argv[2]!==\"a'b\")process.exit(9);mkdirSync('reports',{recursive:true});writeFileSync('reports/junit.xml','<testsuite failures=\"1\"/>');process.exit(8)");
 const prepared=await prepareGitlab(root,{checks:['test'],reportPaths:['reports/junit.xml']},[{executable:process.execPath,args:['check.mjs',"a'b"],cwd:'.',envRefs:[]}]);
 const job=parse(prepared.assets[0].content)['rigup:checks'];
 const shell=await runnerShell(root);
 const run=(sha:string)=>spawnSync(shell,['-ec',job.script.join('\n')],{cwd:root,env:{...process.env,CI_COMMIT_SHA:sha}});
 assert.equal(run('wrong-revision').status,1);
 await assert.rejects(readFile(root+'/reports/junit.xml'),{code:'ENOENT'});
 assert.equal(run(commit).status,8);
 assert.match(await readFile(root+'/reports/junit.xml','utf8'),/failures="1"/);
}));
test('the native wiki job reports missing environment references',()=>project(async root=>{
 const commit=await fixtureCommit(root);
 const prepared=await prepareGitlab(root,{checks:[],openwiki:{envRefs:['MODEL_SECRET'],sourcePaths:['src/**/*']}},[]);
 const job=parse(prepared.assets[0].content)['rigup:openwiki'];
 const result=spawnSync(await runnerShell(root),['-ec',job.script.join('\n')],{cwd:root,env:{...process.env,MODEL_SECRET:'',CI_COMMIT_SHA:commit},encoding:'utf8'});
 assert.equal(result.status,3);
 assert.equal(result.stderr.trim(),'Missing OpenWiki environment reference MODEL_SECRET');
}));
import {prepareCustomer} from '../src/integrations/gitlab/customer.js';
test('customer_runtime_declarations_are_not_install_plugins_or_release_adapters',()=>{
 assert.throws(()=>prepareCustomer({agents:['codex'],backend:'host',sdd:'openspec',customer:{installer:'evil.js'} as any}),/customer/);
 const result=prepareCustomer({agents:['codex'],backend:'host',sdd:'openspec',customer:{commands:{deploy:{executable:'customer-deploy',args:[],cwd:'.',envRefs:['DEPLOY_TOKEN']}},deployment:{adapter:'unverified-customer',target:'production',authorizationReference:'existing-approval',recoveryRunbook:'docs/recovery.md'}}});assert.deepEqual(result.operations,[]);assert.ok(result.warnings.some(w=>/Release binding pending/.test(w)));assert.ok(!result.assets.some(a=>a.target.includes('change-release')));
});
