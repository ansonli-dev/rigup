import {createHash} from 'node:crypto';
import {access, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile} from 'node:fs/promises';
import {arch, platform, release} from 'node:os';
import {join} from 'node:path';
import {runLiveCommand} from '../live-process-support.ts';
import {baseEnvironment, claudeEnvironment, clarifyT6, hasEnvAuth, makeRedactor, probeClaude, runClaudeSession} from './claude.mjs';
import {applyCondition, ARMS, loadConditions} from './conditions.mjs';
import {writeFixture} from './fixture.mjs';
import {hiddenCaseIds, scoreFixture} from './score.mjs';
import {getTask} from './tasks.mjs';

export const DEFAULT_TASKS = ['T4', 'T5', 'T6'];
export const DEFAULT_TIMEOUT_MS = 180_000;

export function planHarness({
  tasks = DEFAULT_TASKS, arms = ARMS, repeats = 3, repeat, sddRoute = 'openspec',
} = {}) {
  const cells = [];
  for (const repetition of repeat === undefined ? Array.from({length: repeats}, (_, i) => i + 1) : [repeat]) {
    for (const taskId of tasks) {
      const task = getTask(taskId);
      for (const arm of arms) {
        cells.push({
          id: `${taskId}-${arm}-${repetition}`, taskId, arm, repeat: repetition, sessions: task.prompts.length,
          hiddenTotals: Object.fromEntries(task.checkpoints.map(checkpoint => [checkpoint, hiddenCaseIds(taskId, checkpoint).length])),
        });
      }
    }
  }
  return {schemaVersion: 1, sddRoute, cells};
}

function emptyResult(cell) {
  const checkpoints = Object.fromEntries(Object.entries(cell.hiddenTotals).map(([name, total]) => [name, {
    status: 'not-run', hidden: {passed: null, total, failedCaseIds: []}, visible: {status: 'not-run'},
  }]));
  return {...cell, checkpoints, status: 'not-run', sessionsPlanned: cell.sessions, sessions: [], taskCostUsd: null, taskWallMs: 0,
    ...(cell.taskId === 'T6' ? {clarification: {askedRelevant: null, codeUnchanged: null, preEdit: null, answered: false}} : {}),
  };
}

function json(value) {
  return JSON.stringify(value, null, 2) + '\n';
}

async function privateFile(path, content) {
  await writeFile(path, content, {mode: 0o600, flag: 'wx'});
}

async function privateDir(path) {
  await mkdir(path, {mode: 0o700});
  return path;
}

async function createBatchDirectory(out) {
  const parent = await realpath(out);
  const directory = await mkdtemp(join(parent, 'rigup-harness-'));
  try {
    const stat = await lstat(directory);
    if (process.platform === 'win32') {
      const {assertPrivateAccess} = await import('../../src/private-access.ts');
      await assertPrivateAccess(directory, stat, 'Evaluation output needs a private ACL');
    } else if (stat.mode & 0o077) throw new Error('Evaluation output is not private');
    return directory;
  } catch (error) {
    await rm(directory, {recursive: true, force: true});
    throw error;
  }
}

async function sessionDirectories(root) {
  const home = await privateDir(join(root, 'home'));
  const temp = await privateDir(join(root, 'tmp'));
  const plugins = await privateDir(join(root, 'plugins'));
  return {home, temp, plugins};
}

async function gitFixture(root, env) {
  for (const args of [
    ['init', '--quiet', '--template='],
    ['-c', 'core.autocrlf=false', 'add', '--all'],
    ['-c', 'user.name=Rigup Harness', '-c', 'user.email=rigup-harness@example.invalid',
      '-c', 'commit.gpgSign=false', 'commit', '--quiet', '-m', 'Disposable fixture baseline'],
  ]) {
    const command = await runLiveCommand('git', args, {cwd: root, env, timeoutMs: 15_000, maxBuffer: 32_000});
    if (command.code !== 0 || command.timedOut) throw new Error('Could not initialize disposable fixture Git baseline');
  }
}

async function codeDigest(root) {
  const hash = createHash('sha256');
  let bytes = 0, files = 0;
  async function visit(path) {
    const target = join(root, ...path.split('/'));
    let stat;
    try { stat = await lstat(target); }
    catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    if (stat.isDirectory()) {
      for (const name of (await readdir(target)).sort()) {
        if (await visit(path + '/' + name) === false) return false;
      }
    } else {
      if (!stat.isFile() || (bytes += stat.size) > 8_000_000 || ++files > 400) return false;
      const content = await readFile(target);
      hash.update(JSON.stringify([path, stat.mode & 0o111, content.byteLength])).update(content);
    }
    return true;
  }
  for (const path of ['package.json', 'src', 'test']) {
    if (await visit(path) === false) return null;
  }
  return hash.digest('hex');
}

async function recordSession(folder, phase, session, redact) {
  const {stdout, stderr, sessionId, metrics, code, status, reason} = session;
  const safeMetrics = {
    ...metrics,
    model: metrics.model && redact(metrics.model) === metrics.model ? metrics.model : null,
    servedModels: metrics.servedModels.filter(name => redact(name) === name),
    observedWorkflowEntries: metrics.observedWorkflowEntries.filter(name => redact(name) === name),
  };
  await Promise.all([
    privateFile(join(folder, `session-${phase}.jsonl`), redact(stdout)),
    privateFile(join(folder, `session-${phase}.stderr.log`), redact(stderr)),
    privateFile(join(folder, `session-${phase}.json`), json({phase, sessionId, code, status, reason, ...safeMetrics})),
  ]);
  return {phase, code, status, reason, ...safeMetrics};
}

async function recordScore(result, checkpoint, root, control, scoreTemp, redact) {
  const score = await scoreFixture(root, result.taskId, checkpoint, {tempDir: scoreTemp});
  await privateFile(join(control, `score-${checkpoint}.json`), redact(json(score)));
  const {status, hidden, visible} = score;
  result.checkpoints[checkpoint] = {
    status, hidden, visible: {
      status: visible.status, exitCode: visible.exitCode ?? null, tests: visible.tests ?? null,
    },
  };
  return status === 'scored';
}

function updateCost(result) {
  result.taskWallMs = result.sessions.reduce((sum, session) => sum + session.elapsedMs, 0);
  if (result.sessions.length === result.sessionsPlanned && result.sessions.every(session => session.costUsd !== null)) {
    result.taskCostUsd = result.sessions.reduce((sum, session) => sum + session.costUsd, 0);
  }
}

function classifyFailure(session) {
  if (session.status !== 'infrastructure-error' || session.reason === 'process-cleanup-failed') return session;
  const output = session.stderr + '\n' + session.stdout;
  if (/oauth token (?:has been )?revoked/i.test(output)) {
    return {...session, status: 'unsupported', reason: 'authentication-revoked'};
  }
  if (/invalid[ _-](?:api[ _-]key|token)|(?:not logged in|please run \/login)|401 (?:unauthorized|authentication)|authentication_error/i.test(output)) {
    return {...session, status: 'unsupported', reason: 'authentication-unavailable'};
  }
  if (/model (?:not found|unavailable)|model_not_found|does not have access to (?:the|this) model/i.test(output)) {
    return {...session, status: 'unsupported', reason: 'model-unavailable'};
  }
  return session;
}

async function runCell(cell, condition, context) {
  const result = emptyResult(cell);
  const {options, client, env, records, work, scoreTemp, redact, batchState} = context;
  const control = await privateDir(join(records, cell.id));
  if (condition.error) {
    await privateFile(join(control, 'setup-error.txt'), redact(condition.error.message));
    return {...result, status: 'infrastructure-error', reason: 'condition-unavailable'};
  }
  const started = performance.now();
  const working = await privateDir(join(work, cell.id));
  let safeToRemove = true;
  let phase = 'setup';
  try {
    const root = join(working, 'repo');
    const paths = await sessionDirectories(working);
    await writeFixture(root, cell.taskId);
    await applyCondition(root, condition);
    await gitFixture(root, baseEnvironment(paths.home, paths.temp, env));
    result.setupWallMs = Math.round(performance.now() - started);
    result.condition = condition.metadata;
    const task = getTask(cell.taskId);
    const sddRoute = condition.metadata.sddRoute;
    const sessionEnv = claudeEnvironment(paths.home, paths.temp, paths.plugins, env,
      options.useExistingLogin, sddRoute ? options.sddBin : undefined);
    const initialCode = task.id === 'T6' ? await codeDigest(root) : null;
    for (const [index, prompt] of task.prompts.entries()) {
      if (options.signal?.aborted) return {...result, status: 'interrupted', reason: 'interrupted'};
      phase = 'task';
      const session = classifyFailure(await runClaudeSession({
        client, model: options.model, cwd: root, env: sessionEnv, sddRoute, signal: options.signal, prompt,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        followUp: task.id === 'T6' ? async ({text, blocks}) => {
          const codeUnchanged = initialCode !== null && initialCode === await codeDigest(root);
          const clarification = clarifyT6({text, blocks, root, sddRoute, codeUnchanged});
          result.clarification = {...clarification, answered: false};
          return clarification.askedRelevant && clarification.preEdit ? task.clarification : null;
        } : undefined,
      }));
      if (task.id === 'T6') result.clarification.answered = session.followUpSent;
      if (session.reason === 'process-cleanup-failed') safeToRemove = false;
      const metrics = await recordSession(control, index + 1, session, redact);
      result.sessions.push(metrics);
      updateCost(result);
      if (session.status !== 'completed') return {...result, status: session.status, reason: session.reason};
      if (metrics.model) {
        if (batchState.model && batchState.model !== metrics.model) {
          return {...result, status: 'infrastructure-error', reason: 'claude-model-changed'};
        }
        batchState.model ??= metrics.model;
      }
      if (task.id === 'T5' && index === 0) {
        phase = 'validation';
        if (!await recordScore(result, 'step1', root, control, scoreTemp, redact)) {
          return {...result, status: 'infrastructure-error', reason: 'evaluator-unavailable'};
        }
      }
    }
    phase = 'validation';
    if (!await recordScore(result, 'final', root, control, scoreTemp, redact)) {
      return {...result, status: 'infrastructure-error', reason: 'evaluator-unavailable'};
    }
    const passed = Object.values(result.checkpoints).every(({hidden, visible}) => hidden.passed === hidden.total && visible.status === 'passed');
    return {...result, status: passed ? 'passed' : 'validation-failed', reason: null};
  } catch (error) {
    await privateFile(join(control, 'error.txt'), redact(error.message ?? String(error)));
    return {...result, status: 'infrastructure-error', reason: phase + '-unavailable'};
  } finally {
    if (safeToRemove) await rm(working, {recursive: true, force: true, maxRetries: 3});
  }
}

function aggregate(cells) {
  const groups = new Map();
  for (const cell of cells) {
    const key = cell.taskId + '/' + cell.arm;
    if (!groups.has(key)) groups.set(key, {
      taskId: cell.taskId, arm: cell.arm, planned: 0, statuses: {}, scored: 0,
      hiddenPassed: 0, hiddenScoredTotal: 0, hiddenPlannedTotal: 0,
      completeCostCells: 0, taskCostUsd: 0, taskWallMs: 0,
    });
    const group = groups.get(key);
    group.planned++;
    group.statuses[cell.status] = (group.statuses[cell.status] ?? 0) + 1;
    const {passed, total} = cell.checkpoints.final.hidden;
    group.hiddenPlannedTotal += total;
    if (cell.status === 'passed' || cell.status === 'validation-failed') {
      group.scored++;
      group.hiddenPassed += passed;
      group.hiddenScoredTotal += total;
    }
    if (cell.taskCostUsd !== null) {
      group.completeCostCells++;
      group.taskCostUsd += cell.taskCostUsd;
    }
    group.taskWallMs += cell.taskWallMs;
  }
  return [...groups.values()];
}

function systemMetadata(options, client) {
  return {
    schemaVersion: 1, platform: platform(), arch: arch(), osRelease: release(), node: process.version,
    client: client ? {version: client.version, sha256: client.sha256} : null,
    requestedModel: options.model, authMode: options.useExistingLogin ? 'existing-login' : 'isolated-env',
    sessionTimeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

async function prepareBatch(options, env) {
  const directory = await createBatchDirectory(options.out);
  const records = await privateDir(join(directory, 'private'));
  const work = await privateDir(join(directory, 'work'));
  const bootstrap = await privateDir(join(work, 'bootstrap'));
  const paths = await sessionDirectories(bootstrap);
  return {directory, records, work, paths, bootstrap, redact: makeRedactor(env)};
}

async function bootClient(options, state, env, claudePrefix) {
  const {home, temp} = state.paths;
  if (!options.useExistingLogin && !hasEnvAuth(env)) return {status: 'unsupported', reason: 'authentication-unavailable'};
  try {
    const client = await probeClaude(options, baseEnvironment(home, temp, env), state.bootstrap, claudePrefix);
    return {client};
  } catch (error) {
    await privateFile(join(state.records, 'preflight-error.txt'), state.redact(error.message ?? String(error)));
    return {status: 'infrastructure-error', reason: 'claude-preflight-unavailable'};
  }
}

export async function runHarness(options, {claudePrefix = [], env = process.env} = {}) {
  const plan = planHarness(options);
  const state = await prepareBatch(options, env);
  const {directory, records, work, redact} = state;
  const {client, ...bootFailure} = await bootClient(options, state, env, claudePrefix);
  const conditions = client ? await loadConditions(plan, options, redact) : new Map();
  const scoreTemp = await privateDir(join(work, 'scores'));
  const cells = [];
  const batchState = {};
  let halt = client ? null : bootFailure;
  if (options.sddBin) {
    try { await access(options.sddBin); }
    catch (error) {
      for (const [key, condition] of conditions) {
        if (condition.metadata?.sddRoute) conditions.set(key, {error});
      }
    }
  }
  for (const cell of plan.cells) {
    let result;
    if (options.signal?.aborted) result = {...emptyResult(cell), status: 'interrupted', reason: 'interrupted'};
    else if (halt) result = {...emptyResult(cell), ...halt};
    else result = await runCell(cell, conditions.get(cell.taskId + '/' + cell.arm), {
      ...state, options, client, env, scoreTemp, batchState,
    });
    cells.push(result);
    await privateFile(join(records, cell.id + '.json'), json(result));
    if (result.status === 'unsupported' || ['process-cleanup-failed', 'claude-model-changed', 'claude-executable-changed'].includes(result.reason)) {
      halt = {status: result.status, reason: result.reason};
    }
  }
  const summary = {
    ...systemMetadata(options, client), mode: 'matrix', sddRoute: plan.sddRoute,
    observedModel: batchState.model ?? null,
    conditions: [...conditions.entries()].map(([key, condition]) => ({key, ...condition.metadata})),
    cells, groups: aggregate(cells),
  };
  await privateFile(join(directory, 'summary.json'), json(summary));
  if (halt?.reason !== 'process-cleanup-failed') await rm(work, {recursive: true, force: true, maxRetries: 3});
  return {directory, summary};
}

const preflightReply = 'RIGUP_HARNESS_AUTH_OK';

export async function preflightHarness(options, {claudePrefix = [], env = process.env} = {}) {
  const state = await prepareBatch(options, env);
  const {directory, records, work, paths, redact} = state;
  const {client, ...bootFailure} = await bootClient(options, state, env, claudePrefix);
  let outcome = bootFailure;
  if (client) {
    const session = classifyFailure(await runClaudeSession({
      client, model: options.model, cwd: state.bootstrap, env: claudeEnvironment(paths.home, paths.temp, paths.plugins,
        env, options.useExistingLogin),
      signal: options.signal, timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      prompt: 'Reply with exactly ' + preflightReply + '.', toolFree: true,
    }));
    const metrics = await recordSession(records, 'preflight', session, redact);
    outcome = {
      status: session.status === 'completed' ? session.finalText?.trim() === preflightReply ? 'passed' : 'validation-failed' : session.status,
      reason: session.status === 'completed' && session.finalText?.trim() !== preflightReply ? 'unexpected-probe-reply' : session.reason,
      session: metrics,
    };
  }
  const summary = {...systemMetadata(options, client), mode: 'preflight', ...outcome};
  await privateFile(join(directory, 'summary.json'), json(summary));
  if (outcome.reason !== 'process-cleanup-failed') await rm(work, {recursive: true, force: true, maxRetries: 3});
  return {directory, summary};
}
