import {test} from 'node:test';import assert from 'node:assert/strict';
import {project} from './helpers.js';import {writeFile,readFile,mkdir} from 'node:fs/promises';
import {prepareGitlab} from '../src/integrations/gitlab/ci.js';import {replaceOwned} from '../src/installer/ownership.js';import {parse} from 'yaml';
test('gitlab_include_preserves_existing_jobs_comments_and_includes',()=>project(async root=>{
 const original='# keep comment\ninclude:\n  - local: customer.yml\n\ncustomer-job:\n  script: echo customer\n';await writeFile(root+'/.gitlab-ci.yml',original);const result=await prepareGitlab(root,{checks:['test']});const asset=result.assets.find(a=>a.target==='.gitlab-ci.yml')!;assert.ok(asset);const next=replaceOwned(original,asset.ownership,asset.content)!;assert.match(next,/# keep comment/);const config=parse(next);assert.equal(config['customer-job'].script,'echo customer');assert.deepEqual(config.include,[{local:'customer.yml'},{local:'.rigup/gitlab-ci.yml'}]);
}));
test('wiki_update_has_no_self_trigger_loop',()=>project(async root=>{
 const result=await prepareGitlab(root,{checks:[],openwiki:{envRefs:['ANTHROPIC_API_KEY'],sourcePaths:['src/**/*']}});const ci=result.assets.find(a=>a.target==='.rigup/gitlab-ci.yml')!;assert.ok(ci);const config=parse(ci.content);const job=config['rigup:openwiki'];assert.ok(job.rules.some((r:any)=>r.when==='never'));assert.deepEqual(job.rules.find((r:any)=>r.changes).changes,['src/**/*']);assert.doesNotMatch(ci.content,/git push|git commit/);
}));
import {runSnapshot} from '../templates/scripts/check-snapshot.mjs';import {runOpenWikiCI} from '../templates/scripts/openwiki-ci-update.mjs';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
const exec=promisify(execFile);
test('ci_preserves_exit_status_and_reports',()=>project(async root=>{
 await exec('git',['-C',root,'init','-q']);await exec('git',['-C',root,'config','user.name','Fixture']);await exec('git',['-C',root,'config','user.email','fixture@example.org']);await writeFile(root+'/check.mjs',"import {mkdirSync,writeFileSync} from 'node:fs';mkdirSync('reports',{recursive:true});writeFileSync('reports/junit.xml','<testsuite failures=\"1\"/>');process.exit(8)");await exec('git',['-C',root,'add','.']);await exec('git',['-C',root,'commit','-qm','fixture']);const commit=(await exec('git',['-C',root,'rev-parse','HEAD'])).stdout.trim();
 const report=await runSnapshot({root,mode:'ci',commands:[{executable:process.execPath,args:['check.mjs'],cwd:'.',envRefs:[]}],reportPaths:['reports/junit.xml']});assert.equal(report.exitCode,8);assert.equal(report.snapshots[0].commit,commit);assert.match(await readFile(root+'/rigup-reports/'+commit+'/reports/junit.xml','utf8'),/failures="1"/);
}));
test('missing_secrets_are_pending_and_generated_wiki_updates_are_skipped',async()=>{
 const config={envRefs:['MODEL_SECRET'],command:{executable:'must-not-run',args:[]},packageJson:'missing',version:'0.7.3'};const env={CI_PIPELINE_SOURCE:'push',CI_COMMIT_BRANCH:'main',CI_DEFAULT_BRANCH:'main',CI_COMMIT_SHA:'actual'};
 const result=await runOpenWikiCI(config,{env});assert.equal(result.status,'pending');assert.equal(result.exitCode,3);assert.doesNotMatch(JSON.stringify(result),/secret-value/);assert.equal((await runOpenWikiCI(config,{env:{...env,RIGUP_WIKI_GENERATED:'1'}})).status,'skipped');
});
import {prepareCustomer} from '../src/integrations/gitlab/customer.js';
test('customer_runtime_declarations_are_not_install_plugins_or_release_adapters',()=>{
 assert.throws(()=>prepareCustomer({agents:['codex'],backend:'host',sdd:'openspec',customer:{installer:'evil.js'} as any}),/customer/);
 const result=prepareCustomer({agents:['codex'],backend:'host',sdd:'openspec',customer:{commands:{deploy:{executable:'customer-deploy',args:[],cwd:'.',envRefs:['DEPLOY_TOKEN']}},deployment:{adapter:'unverified-customer',target:'production',authorizationReference:'existing-approval',recoveryRunbook:'docs/recovery.md'}}});assert.deepEqual(result.operations,[]);assert.ok(result.warnings.some(w=>/Release binding pending/.test(w)));assert.ok(!result.assets.some(a=>a.target.includes('change-release')));
});
