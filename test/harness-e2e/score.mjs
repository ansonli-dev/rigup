import {execFile} from 'node:child_process';
import {cp, lstat, mkdir, mkdtemp, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {isAbsolute, join, relative, sep} from 'node:path';
import {promisify} from 'node:util';
import {casesFor} from './judge/cases.mjs';

const execFileAsync = promisify(execFile);

export function hiddenCaseIds(taskId, checkpoint = 'final') {
  return Object.keys(casesFor(taskId, checkpoint));
}

async function plainFileOrDirectory(path) {
  try {
    const stat = await lstat(path);
    return stat.isFile() || stat.isDirectory();
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function copyCandidate(root, project) {
  await mkdir(project);
  for (const entry of ['package.json', 'src', 'test']) {
    const path = join(root, entry);
    if (await plainFileOrDirectory(path)) {
      await cp(path, join(project, entry), {recursive: true, filter: plainFileOrDirectory});
    }
  }
}

async function runNode(args, cwd, timeout) {
  try {
    const {stdout, stderr} = await execFileAsync(process.execPath, args, {
      cwd,
      env: {TZ: 'UTC'},
      timeout,
      killSignal: 'SIGKILL',
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    return {exitCode: 0, stdout, stderr};
  } catch (error) {
    if (typeof error.code !== 'number') throw error;
    return {exitCode: error.code, stdout: error.stdout, stderr: error.stderr};
  }
}

async function scoreHidden(project, judge, taskId, checkpoint, ids, timeoutMs) {
  const {exitCode, stdout, stderr} = await runNode(
    ['--permission', `--allow-fs-read=${project}`, `--allow-fs-read=${judge}`,
      join(judge, 'run.mjs'), taskId, checkpoint],
    project,
    timeoutMs,
  );
  if (exitCode !== 0) throw new Error(`Judge exited with code ${exitCode}\n${stderr.trim().slice(-2000)}`);
  const prefix = 'RIGUP_HIDDEN_RESULT ';
  const reports = stdout.split('\n').filter(line => line.startsWith(prefix));
  if (reports.length !== 1) throw new Error('Judge returned no unique result');
  const failed = JSON.parse(reports[0].slice(prefix.length));
  if (!Array.isArray(failed) || new Set(failed).size !== failed.length || !failed.every(id => ids.includes(id))) {
    throw new Error('Judge returned invalid case IDs');
  }
  return {passed: ids.length - failed.length, total: ids.length, failedCaseIds: failed};
}

async function runVisible(project, timeoutMs) {
  const {exitCode, stdout, stderr} = await runNode(
    ['--permission', `--allow-fs-read=${project}`, '--test', process.versions.node.startsWith('22.')?'--experimental-test-isolation=none':'--test-isolation=none', '--test-reporter=tap'],
    project,
    timeoutMs,
  );
  const tests = Number([...stdout.matchAll(/^# tests (\d+)\s*$/gm)].at(-1)?.[1] ?? 0);
  if (exitCode === 0 && tests > 0) return {status: 'passed', exitCode, tests};
  return {status: 'failed', exitCode, tests, output: (stdout + stderr).trim().slice(-4000)};
}

function infrastructureError(error) {
  return {status: 'infrastructure-error', error: error.message ?? String(error)};
}

export async function scoreFixture(root, taskId, checkpoint = 'final', {
  timeoutMs = 15_000,
  tempDir = tmpdir(),
} = {}) {
  const ids = hiddenCaseIds(taskId, checkpoint);
  const unscored = {passed: null, total: ids.length, failedCaseIds: []};
  let scratch;
  try {
    const workspace = await realpath(root);
    const tempRoot = await realpath(tempDir);
    const position = relative(workspace, tempRoot);
    if (!isAbsolute(position) && position !== '..' && !position.startsWith(`..${sep}`)) {
      throw new Error('Scoring temp directory must be outside the model workspace');
    }
    scratch = await mkdtemp(join(tempRoot, 'rigup-harness-score-'));
    const project = join(scratch, 'project');
    const judge = join(scratch, 'judge');
    await copyCandidate(workspace, project);
    await cp(new URL('./judge/', import.meta.url), judge, {recursive: true});

    const [hidden, visible] = await Promise.allSettled([
      scoreHidden(project, judge, taskId, checkpoint, ids, timeoutMs),
      runVisible(project, timeoutMs),
    ]);
    const result = {
      hidden: hidden.status === 'fulfilled' ? hidden.value : unscored,
      visible: visible.status === 'fulfilled' ? visible.value : infrastructureError(visible.reason),
    };
    const errors = [];
    if (hidden.status === 'rejected') errors.push(`Hidden evaluator: ${infrastructureError(hidden.reason).error}`);
    if (visible.status === 'rejected') errors.push(`Visible suite: ${result.visible.error}`);
    return errors.length
      ? {status: 'infrastructure-error', ...result, error: errors.join('\n')}
      : {status: 'scored', ...result};
  } catch (error) {
    const failure = infrastructureError(error);
    return {...failure, hidden: unscored, visible: failure};
  } finally {
    if (scratch) await rm(scratch, {recursive: true, force: true});
  }
}
