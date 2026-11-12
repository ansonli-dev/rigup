import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createWriteStream} from 'node:fs';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {finished} from 'node:stream/promises';
import {prepareGitlab} from '../src/integrations/gitlab/ci.js';
import {liveVersion,startLiveCommand} from './live-process-support.js';
import {runnerEnvironment,redactGitlabEvidence,failedJobEvidence,boundedTrace} from './gitlab-runner-support.js';

const exec = promisify(execFile);
const pause = (ms:number) => new Promise(done => setTimeout(done, ms));

test('live local GitLab lints and runs generated checks reports and wiki guards', {skip: process.env.RIGUP_LIVE_GITLAB !== '1', timeout: 900_000}, async () => {
  const host = new URL(process.env.RIGUP_GITLAB_HOST!);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(host.hostname), 'use an explicitly provisioned disposable local GitLab');
  assert.equal(host.username + host.password + host.search + host.hash, '');
  const token = (await readFile(process.env.RIGUP_GITLAB_TOKEN_FILE!, 'utf8')).trim();
  assert.ok(token);
  const secrets=new Set([token]);
  const pipelineIds:number[]=[];
  const binary = process.env.RIGUP_GITLAB_RUNNER!;
  const runnerVersion = await liveVersion(binary);
  const control = await mkdtemp(join(tmpdir(), 'rigup-gitlab-live-'));
  const home = join(control, 'home');
  const root = join(control, 'source');
  await mkdir(home); await mkdir(root);
  const report:any = {caseId: 'gitlab/local-lint-runner', status: 'failed', startedAt: new Date().toISOString(), source: (await exec('git', ['rev-parse', 'HEAD'])).stdout.trim(), platform: process.platform, node: process.version, runnerVersion, pipelines: [], scope: 'Disposable local GitLab and shell runner with native job scripts, JUnit artifacts, a missing environment reference and wiki skip guards.'};
  let projectId:number|undefined;
  let runner:ReturnType<typeof startLiveCommand>|undefined;
  let runnerLog:ReturnType<typeof createWriteStream>|undefined;
  let runnerLogClosed:Promise<void>|undefined;
  const api = async (method:string, path:string, body?:unknown, text=false):Promise<any> => {
    const response = await fetch(new URL('/api/v4' + path, host), {method, headers: {'PRIVATE-TOKEN': token, 'Content-Type': 'application/json'}, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000)});
    const value = text ? await boundedTrace(response) : response.status === 204 ? null : await response.json();
    assert.ok(response.ok, `${method} ${path}: HTTP ${response.status}`);
    return value;
  };
  try {
    report.gitlabVersion = await api('GET', '/version');
    const project = await api('POST', '/projects', {name: 'rigup-live-' + randomUUID(), visibility: 'private', initialize_with_readme: true, default_branch: 'main', shared_runners_enabled: false, auto_devops_enabled: false});
    projectId = project.id;
    const base = `/projects/${projectId}`;
    const registered = await api('POST', '/user/runners', {runner_type: 'project_type', project_id: projectId, description: 'Rigup disposable local validation', run_untagged: true, locked: true});
    secrets.add(registered.token);
    const config = join(control, 'runner.toml');
    await writeFile(config, `concurrent = 1\ncheck_interval = 1\n[[runners]]\nname = "rigup-disposable"\nurl = ${JSON.stringify(host.origin)}\nid = ${registered.id}\ntoken = ${JSON.stringify(registered.token)}\nexecutor = "shell"\nshell = "bash"\nbuilds_dir = "builds"\ncache_dir = "cache"\n`, {mode: 0o600});
    let runnerError:Error|undefined;
    runnerLog = createWriteStream(join(control, 'runner.log'), {mode:0o600});
    runnerLogClosed = finished(runnerLog);
    void runnerLogClosed.catch(error => {runnerError = error;});
    runner = startLiveCommand(binary, ['run', '--config', config, '--working-directory', control], {cwd:control,
      env:await runnerEnvironment(home)});
    runner.stdout.pipe(runnerLog,{end:false});
    runner.stderr.pipe(runnerLog,{end:false});
    void runner.completed.then(
      code => {runnerError = Error('Disposable runner exited before pipeline completion (code '+code+')');},
      error => {runnerError = error;},
    );
    const commit = async (actions:unknown[], skip=true) => api('POST', base + '/repository/commits', {branch: 'main', commit_message: 'Rigup disposable fixture' + (skip ? ' [skip ci]' : ''), actions});
    const waitPipeline = async (id:number) => {
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        if (runnerError) throw runnerError;
        const pipeline = await api('GET', base + '/pipelines/' + id);
        if (['success', 'failed', 'canceled', 'skipped', 'manual'].includes(pipeline.status)) return pipeline;
        await pause(1000);
      }
      throw Error('Disposable GitLab pipeline timed out; inspect private runner log: ' + control);
    };
    const pipeline = async (pushSha?:string) => {
      let started;
      if (pushSha) {
        for (let attempt=0; attempt<60; attempt++) {
          [started] = await api('GET', base + '/pipelines?source=push&sha=' + pushSha);
          if (started) break;
          await pause(1000);
        }
        assert.ok(started, 'real commit push did not create a pipeline');
      } else started = await api('POST', base + '/pipeline', {ref: 'main'});
      pipelineIds.push(started.id);
      const finished = await waitPipeline(started.id);
      const jobs = await api('GET', base + '/pipelines/' + started.id + '/jobs');
      report.pipelines.push({id: started.id, sha: finished.sha, status: finished.status, jobs: jobs.map((job:any) => ({id: job.id, name: job.name, stage: job.stage, status: job.status, artifacts: job.artifacts.map((artifact:any) => ({file_type: artifact.file_type, filename: artifact.filename, size: artifact.size}))}))});
      return {finished, jobs};
    };
    const commands = [{executable: 'node', args: ['check.mjs'], cwd: '.', envRefs: []}];
    const initial = await prepareGitlab(root, {checks: ['test'], reportPaths: ['reports/junit.xml']}, commands);
    assert.deepEqual(initial.requirements, []);
    const check = `import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';const failed=readFileSync('mode.txt','utf8').trim()==='fail';mkdirSync('reports',{recursive:true});writeFileSync('reports/junit.xml','<testsuite name="local" tests="1" failures="'+(failed?1:0)+'"><testcase name="snapshot">'+(failed?'<failure/>':'')+'</testcase></testsuite>');process.exit(failed?7:0);\n`;
    const actions = initial.assets.map(asset => ({action: 'create', file_path: asset.target, content: asset.content}));
    actions.push({action: 'create', file_path: 'check.mjs', content: check}, {action: 'create', file_path: 'mode.txt', content: 'pass\n'});
    await commit(actions);
    const rootCI = initial.assets.find(asset => asset.target === '.gitlab-ci.yml')!.content;
    report.lint = await api('POST', base + '/ci/lint', {content: rootCI, ref: 'main', dry_run: true, include_jobs: true});
    assert.equal(report.lint.valid, true, JSON.stringify(report.lint.errors));
    const success = await pipeline(); assert.equal(success.finished.status, 'success');
    const passedJob = success.jobs.find((job:any) => job.name === 'rigup:checks'); assert.ok(passedJob);
    const passed = await api('GET', `${base}/jobs/${passedJob.id}/artifacts/reports/junit.xml`, undefined, true);
    assert.match(passed, /failures="0"/);
    report.successReport = passed;
    await commit([{action: 'update', file_path: 'mode.txt', content: 'fail\n'}]);
    const failure = await pipeline(); assert.equal(failure.finished.status, 'failed');
    const failedJob = failure.jobs.find((job:any) => job.name === 'rigup:checks');
    assert.equal(failedJob?.status, 'failed');
    const failed = await api('GET', `${base}/jobs/${failedJob.id}/artifacts/reports/junit.xml`, undefined, true);
    assert.match(failed, /failures="1"/);
    report.failureReport = failed;
    await writeFile(join(root, '.gitlab-ci.yml'), rootCI);
    const wiki = await prepareGitlab(root, {checks: ['test'], reportPaths: ['reports/junit.xml'], openwiki: {envRefs: ['RIGUP_MISSING_MODEL_TOKEN'], sourcePaths: ['src/**/*']}}, commands);
    await api('POST', base + '/variables', {key: 'RIGUP_WIKI_GENERATED', value: '1', protected: false});
    const guardedCommit = await commit([...wiki.assets.filter(asset => asset.target !== '.gitlab-ci.yml').map(asset => ({action: initial.assets.some(old => old.target === asset.target) ? 'update' : 'create', file_path: asset.target, content: asset.content})), {action: 'update', file_path: 'mode.txt', content: 'pass\n'}, {action: 'create', file_path: 'src/source.js', content: 'export const fixture = true;\n'}], false);
    const skipped = await pipeline(guardedCommit.id);
    assert.equal(skipped.finished.status, 'success'); assert.ok(!skipped.jobs.some((job:any) => job.name === 'rigup:openwiki'));
    await api('DELETE', base + '/variables/RIGUP_WIKI_GENERATED');
    const wikiCommit = await commit([{action: 'update', file_path: 'src/source.js', content: 'export const fixture = "updated";\n'}], false);
    const missing = await pipeline(wikiCommit.id); assert.equal(missing.finished.status, 'failed');
    const wikiJob = missing.jobs.find((job:any) => job.name === 'rigup:openwiki'); assert.equal(wikiJob?.status, 'failed');
    const trace = await api('GET', `${base}/jobs/${wikiJob.id}/trace`, undefined, true);
    assert.match(redactGitlabEvidence(trace,secrets), /Missing OpenWiki environment reference RIGUP_MISSING_MODEL_TOKEN/);
    report.wikiMissing = {status: wikiJob.status, missingRef: 'RIGUP_MISSING_MODEL_TOKEN'};
    report.status = 'passed';
  } catch (error) {
    report.reason = redactGitlabEvidence(error instanceof Error ? error.message : 'Local GitLab test failed',secrets);
    report.privateControl = control;
    throw Error(report.reason);
  } finally {
    let cleanupError:unknown;
    try {
      try { await runner?.stop('SIGQUIT'); }
      finally { runnerLog?.end(); await runnerLogClosed; }
    } catch (error) {
      cleanupError = error;
      report.status = 'failed';
      report.runnerCleanup = (error as Error).message;
      report.privateControl = control;
    }
    if (projectId !== undefined) {
      report.failedJobs=await failedJobEvidence(api,'/projects/'+projectId,pipelineIds,secrets);
      report.runnerTrace=redactGitlabEvidence((await readFile(join(control,'runner.log'),'utf8').catch(()=> 'Runner log unavailable')).slice(-256_000),secrets);
      try { await api('DELETE', '/projects/' + projectId); report.projectCleanup = 'deleted own disposable project'; }
      catch { report.projectCleanup = 'failed; remove own disposable instance before reuse'; }
    }
    report.finishedAt = new Date().toISOString();
    const out = process.env.RIGUP_LIVE_EVIDENCE_DIR ?? join(control, 'evidence');
    await mkdir(out, {recursive: true}); await writeFile(join(out, 'gitlab-local-runner.json'), redactGitlabEvidence(JSON.stringify(report, null, 2),secrets) + '\n');
    if (report.status === 'passed') await rm(control, {recursive: true, force: true});
    if (cleanupError) throw cleanupError;
  }
});
