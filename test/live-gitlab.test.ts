import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile, spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, mkdir, open, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {prepareGitlab} from '../src/integrations/gitlab/ci.js';

const exec = promisify(execFile);
const pause = (ms:number) => new Promise(done => setTimeout(done, ms));

test('live local GitLab lints and runs generated checks reports and wiki guards', {skip: process.env.RIGUP_LIVE_GITLAB !== '1', timeout: 900_000}, async () => {
  const host = new URL(process.env.RIGUP_GITLAB_HOST!);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(host.hostname), 'use an explicitly provisioned disposable local GitLab');
  assert.equal(host.username + host.password + host.search + host.hash, '');
  const token = (await readFile(process.env.RIGUP_GITLAB_TOKEN_FILE!, 'utf8')).trim();
  assert.ok(token);
  const binary = process.env.RIGUP_GITLAB_RUNNER!;
  const runnerVersion = (await exec(binary, ['--version'])).stdout.trim();
  const control = await mkdtemp(join(tmpdir(), 'rigup-gitlab-live-'));
  const home = join(control, 'home');
  const root = join(control, 'source');
  await mkdir(home); await mkdir(root);
  const report:any = {caseId: 'gitlab/local-lint-runner', status: 'failed', startedAt: new Date().toISOString(), source: (await exec('git', ['rev-parse', 'HEAD'])).stdout.trim(), platform: process.platform, node: process.version, runnerVersion, pipelines: [], scope: 'Disposable local GitLab and shell runner; real generated jobs, snapshot reports, missing-secret exit and wiki skip guards. No model-backed wiki update or remote-project authorization claim.'};
  let projectId:number|undefined;
  let runner:ReturnType<typeof spawn>|undefined;
  let runnerLog:Awaited<ReturnType<typeof open>>|undefined;
  const api = async (method:string, path:string, body?:unknown, text=false):Promise<any> => {
    const response = await fetch(new URL('/api/v4' + path, host), {method, headers: {'PRIVATE-TOKEN': token, 'Content-Type': 'application/json'}, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000)});
    const value = text ? await response.text() : response.status === 204 ? null : await response.json();
    assert.ok(response.ok, `${method} ${path}: HTTP ${response.status}`);
    return value;
  };
  try {
    report.gitlabVersion = await api('GET', '/version');
    const project = await api('POST', '/projects', {name: 'rigup-live-' + randomUUID(), visibility: 'private', initialize_with_readme: true, default_branch: 'main', shared_runners_enabled: false, auto_devops_enabled: false});
    projectId = project.id;
    const base = `/projects/${projectId}`;
    const registered = await api('POST', '/user/runners', {runner_type: 'project_type', project_id: projectId, description: 'Rigup disposable local validation', run_untagged: true, locked: true});
    const config = join(control, 'runner.toml');
    await writeFile(config, `concurrent = 1\ncheck_interval = 1\n[[runners]]\nname = "rigup-disposable"\nurl = ${JSON.stringify(host.origin)}\nid = ${registered.id}\ntoken = ${JSON.stringify(registered.token)}\nexecutor = "shell"\nshell = "bash"\nbuilds_dir = ${JSON.stringify(join(control, 'builds'))}\ncache_dir = ${JSON.stringify(join(control, 'cache'))}\n`, {mode: 0o600});
    runnerLog = await open(join(control, 'runner.log'), 'w', 0o600);
    runner = spawn(binary, ['run', '--config', config, '--working-directory', control], {cwd: control, detached: true, stdio: ['ignore', runnerLog.fd, runnerLog.fd], env: {PATH: [dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].join(':'), HOME: home, LANG: 'en_US.UTF-8', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, 'gitconfig')}});
    let runnerError:Error|undefined;
    runner.on('error', error => {runnerError = error;});
    const commit = async (actions:unknown[], skip=true) => api('POST', base + '/repository/commits', {branch: 'main', commit_message: 'Rigup disposable fixture' + (skip ? ' [skip ci]' : ''), actions});
    const waitPipeline = async (id:number) => {
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        if (runnerError) throw runnerError;
        assert.equal(runner?.exitCode, null, 'disposable runner exited before pipeline completion');
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
      const finished = await waitPipeline(started.id);
      const jobs = await api('GET', base + '/pipelines/' + started.id + '/jobs');
      report.pipelines.push({id: started.id, sha: finished.sha, status: finished.status, jobs: jobs.map((job:any) => ({id: job.id, name: job.name, stage: job.stage, status: job.status, artifacts: job.artifacts.map((artifact:any) => ({file_type: artifact.file_type, filename: artifact.filename, size: artifact.size}))}))});
      return {finished, jobs};
    };
    const initial = await prepareGitlab(root, {checks: ['test'], reportPaths: ['reports/junit.xml']});
    assert.deepEqual(initial.requirements, []);
    const check = `import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';const failed=readFileSync('mode.txt','utf8').trim()==='fail';mkdirSync('reports',{recursive:true});writeFileSync('reports/junit.xml','<testsuite name="local" tests="1" failures="'+(failed?1:0)+'"><testcase name="snapshot">'+(failed?'<failure/>':'')+'</testcase></testsuite>');process.exit(failed?7:0);\n`;
    const actions = initial.assets.map(asset => ({action: 'create', file_path: asset.target, content: asset.content}));
    actions.push({action: 'create', file_path: '.rigup/scripts/check-snapshot.mjs', content: await readFile(resolve('templates/scripts/check-snapshot.mjs'), 'utf8')}, {action: 'create', file_path: '.rigup/checks.json', content: JSON.stringify({ci: [{executable: 'node', args: ['check.mjs'], cwd: '.', envRefs: []}], reportPaths: ['reports/junit.xml']})}, {action: 'create', file_path: 'check.mjs', content: check}, {action: 'create', file_path: 'mode.txt', content: 'pass\n'});
    await commit(actions);
    const rootCI = initial.assets.find(asset => asset.target === '.gitlab-ci.yml')!.content;
    report.lint = await api('POST', base + '/ci/lint', {content: rootCI, ref: 'main', dry_run: true, include_jobs: true});
    assert.equal(report.lint.valid, true, JSON.stringify(report.lint.errors));
    const success = await pipeline(); assert.equal(success.finished.status, 'success');
    const passedJob = success.jobs.find((job:any) => job.name === 'rigup:checks'); assert.ok(passedJob);
    const passed = JSON.parse(await api('GET', `${base}/jobs/${passedJob.id}/artifacts/rigup-reports/checks.json`, undefined, true));
    assert.equal(passed.exitCode, 0); assert.equal(passed.snapshots[0].commit, success.finished.sha); report.successReport = passed;
    await commit([{action: 'update', file_path: 'mode.txt', content: 'fail\n'}]);
    const failure = await pipeline(); assert.equal(failure.finished.status, 'failed');
    const failedJob = failure.jobs.find((job:any) => job.name === 'rigup:checks');
    const failed = JSON.parse(await api('GET', `${base}/jobs/${failedJob.id}/artifacts/rigup-reports/checks.json`, undefined, true));
    assert.equal(failed.exitCode, 7); assert.equal(failed.snapshots[0].commands[0].exitCode, 7); report.failureReport = failed;
    assert.match(await api('GET', `${base}/jobs/${failedJob.id}/artifacts/rigup-reports/${failure.finished.sha}/reports/junit.xml`, undefined, true), /failures="1"/);
    await writeFile(join(root, '.gitlab-ci.yml'), rootCI);
    const wiki = await prepareGitlab(root, {checks: ['test'], reportPaths: ['reports/junit.xml'], openwiki: {envRefs: ['RIGUP_MISSING_MODEL_TOKEN'], sourcePaths: ['src/**/*']}});
    await api('POST', base + '/variables', {key: 'RIGUP_WIKI_GENERATED', value: '1', protected: false});
    const guardedCommit = await commit([...wiki.assets.filter(asset => asset.target !== '.gitlab-ci.yml').map(asset => ({action: initial.assets.some(old => old.target === asset.target) ? 'update' : 'create', file_path: asset.target, content: asset.content})), {action: 'update', file_path: 'mode.txt', content: 'pass\n'}, {action: 'create', file_path: 'src/source.js', content: 'export const fixture = true;\n'}], false);
    const skipped = await pipeline(guardedCommit.id);
    assert.equal(skipped.finished.status, 'success'); assert.ok(!skipped.jobs.some((job:any) => job.name === 'rigup:openwiki'));
    await api('DELETE', base + '/variables/RIGUP_WIKI_GENERATED');
    const wikiCommit = await commit([{action: 'update', file_path: 'src/source.js', content: 'export const fixture = "updated";\n'}], false);
    const missing = await pipeline(wikiCommit.id); assert.equal(missing.finished.status, 'failed');
    const wikiJob = missing.jobs.find((job:any) => job.name === 'rigup:openwiki'); assert.equal(wikiJob?.status, 'failed');
    report.wikiMissing = JSON.parse(await api('GET', `${base}/jobs/${wikiJob.id}/artifacts/rigup-reports/openwiki.json`, undefined, true));
    assert.equal(report.wikiMissing.status, 'pending'); assert.equal(report.wikiMissing.exitCode, 3);
    report.status = 'passed';
  } catch (error) {
    report.reason = error instanceof Error ? error.message : 'Local GitLab test failed';
    report.privateControl = control;
    throw error;
  } finally {
    if (runner?.pid) {
      try { process.kill(-runner.pid, 'SIGQUIT'); } catch {}
      for (let attempt = 0; runner.exitCode === null && attempt < 30; attempt++) await pause(100);
      if (runner.exitCode === null) { try { process.kill(-runner.pid, 'SIGKILL'); } catch {} }
    }
    await runnerLog?.close();
    if (projectId !== undefined) {
      try { await api('DELETE', '/projects/' + projectId); report.projectCleanup = 'deleted own disposable project'; }
      catch { report.projectCleanup = 'failed; remove own disposable instance before reuse'; }
    }
    report.finishedAt = new Date().toISOString();
    const out = process.env.RIGUP_LIVE_EVIDENCE_DIR ?? join(control, 'evidence');
    await mkdir(out, {recursive: true}); await writeFile(join(out, 'gitlab-local-runner.json'), JSON.stringify(report, null, 2) + '\n');
    if (report.status === 'passed') await rm(control, {recursive: true, force: true});
  }
});
