import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile} from 'node:fs/promises';
import {homedir, tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const stub = fileURLToPath(new URL('./stub-claude.mjs', import.meta.url));

async function options(t, overrides = {}) {
  const parent = process.platform === 'win32' ? homedir() : tmpdir();
  const out = await realpath(await mkdtemp(join(parent, 'rigup-runner-smoke-')));
  t.after(() => rm(out, {recursive: true, force: true}));
  return {
    out,
    claude: process.execPath,
    model: 'claude-fixture-model',
    tasks: ['T6'],
    arms: ['A'],
    repeats: 1,
    sddRoute: 'openspec',
    timeoutMs: process.platform === 'win32' ? 15_000 : 3000,
    ...overrides,
  };
}

function harnessEnvironment(mode = 'complete') {
  return {
    claudePrefix: [stub, mode],
    env: {...process.env, ANTHROPIC_API_KEY: 'fixture-credential-4921', UNRELATED_SECRET: 'omit-me'},
  };
}

test('the default plan schedules 36 cells without discovering a client', async () => {
  const {parseOptions} = await import('./run.mjs');
  const {planHarness} = await import('./batch.mjs');
  const plan = planHarness(parseOptions(['--plan', '--claude', '/missing/claude']));
  assert.equal(plan.cells.length, 36);
  assert.equal(plan.cells.filter(({taskId}) => taskId === 'T5').length, 12);
  assert.equal(plan.cells.find(({taskId}) => taskId === 'T5').sessions, 3);
  assert.deepEqual(plan.cells.find(({taskId}) => taskId === 'T5').hiddenTotals, {step1: 5, final: 13});
  assert.deepEqual([...new Set(plan.cells.map(({arm}) => arm))], ['A', 'R', 'S', 'B']);
});

test('T5 uses three fresh sessions in the same fixture and keeps the step-one score', async (t) => {
  const {runHarness} = await import('./batch.mjs');
  const result = await runHarness(await options(t, {tasks: ['T5']}), harnessEnvironment());
  const [cell] = result.summary.cells;
  assert.equal(cell.status, 'validation-failed', JSON.stringify(cell));
  assert.deepEqual(cell.checkpoints.step1.hidden, {passed: 5, total: 5, failedCaseIds: []});
  assert.equal(cell.checkpoints.final.hidden.passed, 5);
  assert.equal(cell.checkpoints.final.hidden.total, 13);
  assert.equal(cell.sessions.length, 3);
  assert.ok(Math.abs(cell.taskCostUsd - 0.6) < 1e-8);
  const streamPaths = [1, 2, 3].map(phase => join(result.directory, 'private', 'T5-A-1', `session-${phase}.jsonl`));
  const streams = await Promise.all(streamPaths.map(path => readFile(path, 'utf8')));
  const starts = streams.map(stream => JSON.parse(stream.split('\n')[0]));
  assert.equal(new Set(starts.map(({session_id}) => session_id)).size, 3);
  assert.equal(new Set(starts.map(({cwd}) => cwd)).size, 1);
});

test('T6 answers one relevant pre-edit question and uses the last cumulative cost', async (t) => {
  const {runHarness} = await import('./batch.mjs');
  const result = await runHarness(await options(t), harnessEnvironment());
  const [cell] = result.summary.cells;
  assert.equal(cell.status, 'passed', JSON.stringify(cell));
  assert.equal(cell.clarification.askedRelevant, true);
  assert.equal(cell.clarification.preEdit, true);
  assert.equal(cell.clarification.answered, true);
  assert.deepEqual(cell.checkpoints.final.hidden, {passed: 7, total: 7, failedCaseIds: []});
  assert.equal(cell.sessions.length, 1);
  assert.equal(cell.sessions[0].turns.length, 2);
  assert.equal(cell.taskCostUsd, 0.19);
  const log = await readFile(join(result.directory, 'private', 'T6-A-1', 'session-1.jsonl'), 'utf8');
  assert.ok(!log.includes('fixture-credential-4921'));
  assert.ok(log.includes('[redacted]'));
  assert.ok(!JSON.stringify(result.summary).includes('Should partial refunds'));
});

test('T6 withholds the clarification after an implementation edit attempt', async (t) => {
  const {runHarness} = await import('./batch.mjs');
  const result = await runHarness(await options(t), harnessEnvironment('reverted-edit'));
  const [cell] = result.summary.cells;
  assert.equal(cell.status, 'validation-failed');
  assert.equal(cell.clarification.askedRelevant, true);
  assert.equal(cell.clarification.codeUnchanged, true);
  assert.equal(cell.clarification.preEdit, false);
  assert.equal(cell.clarification.answered, false);
  assert.equal(cell.sessions[0].turns.length, 1);
  assert.equal(cell.taskCostUsd, 0.04);
});

test('T6 does not answer a question unrelated to the missing refund policy', async (t) => {
  const {runHarness} = await import('./batch.mjs');
  const result = await runHarness(await options(t), harnessEnvironment('irrelevant-question'));
  const [cell] = result.summary.cells;
  assert.equal(cell.status, 'validation-failed');
  assert.equal(cell.clarification.preEdit, true);
  assert.equal(cell.clarification.askedRelevant, false);
  assert.equal(cell.clarification.answered, false);
});

test('the tool-free auth probe keeps its cost separate and reports a revoked login', async (t) => {
  const {preflightHarness} = await import('./batch.mjs');
  const config = await options(t);
  const ready = await preflightHarness(config, harnessEnvironment());
  assert.equal(ready.summary.status, 'passed', JSON.stringify(ready.summary));
  assert.equal(ready.summary.session.costUsd, 0.012);
  assert.equal(ready.summary.session.builtinPluginCount, 3);
  assert.equal(ready.summary.cells, undefined);

  const rejected = await preflightHarness({...config, useExistingLogin: true}, harnessEnvironment('revoked'));
  assert.equal(rejected.summary.status, 'unsupported', JSON.stringify(rejected.summary));
  assert.equal(rejected.summary.reason, 'authentication-revoked');
  assert.equal(rejected.summary.session.costUsd, 0);
});

test('the auth probe rejects a nonbundled plugin in the startup inventory', async (t) => {
  const {preflightHarness} = await import('./batch.mjs');
  const result = await preflightHarness(await options(t), harnessEnvironment('external-plugin'));
  assert.equal(result.summary.status, 'infrastructure-error');
  assert.equal(result.summary.reason, 'unexpected-claude-customization');
});

test('a task timeout stays separate from validation with a fixed denominator', async (t) => {
  const {runHarness} = await import('./batch.mjs');
  const result = await runHarness(await options(t, {timeoutMs: 400}), harnessEnvironment('timeout'));
  const [cell] = result.summary.cells;
  assert.equal(cell.status, 'timeout', JSON.stringify(cell));
  assert.equal(cell.taskCostUsd, null);
  assert.deepEqual(cell.checkpoints.final.hidden, {passed: null, total: 7, failedCaseIds: []});
});

test('a symlinked overlay fails setup without opening a model session', {skip: process.platform === 'win32'}, async (t) => {
  const {runHarness} = await import('./batch.mjs');
  const config = await options(t, {arms: ['R']});
  config.preparedDir = join(config.out, 'prepared');
  const arm = join(config.preparedDir, 'T6', 'R');
  await mkdir(arm, {recursive: true, mode: 0o700});
  await symlink(stub, join(arm, 'CLAUDE.md'));
  await writeFile(join(config.preparedDir, 'T6', 'R.json'), JSON.stringify({
    rigupVersion: '0.2.5', sddRoute: null, nativeVersion: null, generationCostUsd: 0.2,
  }));
  const result = await runHarness(config, harnessEnvironment());
  const [cell] = result.summary.cells;
  assert.equal(cell.status, 'infrastructure-error');
  assert.equal(cell.reason, 'condition-unavailable');
  assert.deepEqual(cell.sessions, []);
});

async function treatment(config, arm, changedNative = false) {
  const directory = join(config.preparedDir, 'T6', arm);
  const sdd = arm === 'S' || arm === 'B';
  const rules = arm === 'R' || arm === 'B';
  const files = {
    'CLAUDE.md': rules ? '# Fixture treatment\n\nSee docs/rigup/development-rules.md.\n' : '# Fixture treatment\n',
    ...(rules ? {'docs/rigup/development-rules.md': '# Generated rule canary\n'} : {}),
    ...(sdd ? {
      'openspec/config.yaml': changedNative ? 'schema: alternate\n' : 'schema: spec-driven\n',
      '.claude/skills/openspec-propose/SKILL.md': '# Propose\n',
      '.claude/skills/openspec-apply-change/SKILL.md': '# Apply\n',
      '.claude/skills/openspec-archive-change/SKILL.md': '# Archive\n',
      '.claude/skills/change-prepare/SKILL.md': '# Change prepare\n',
      '.claude/skills/change-deliver/SKILL.md': '# Change deliver\n',
    } : {}),
  };
  for (const [path, value] of Object.entries(files)) {
    const parts = path.split('/');
    const name = parts.pop();
    const parent = join(directory, ...parts);
    await mkdir(parent, {recursive: true, mode: 0o700});
    await writeFile(join(parent, name), value);
  }
  await writeFile(join(config.preparedDir, 'T6', arm + '.json'), JSON.stringify({
    rigupVersion: '0.2.5', sddRoute: sdd ? 'openspec' : null, nativeVersion: sdd ? '1.16.0' : null,
    generationCostUsd: rules ? 0.7 : 0,
  }));
}

test('paired SDD conditions share native files, with setup cost outside the cell cost', async (t) => {
  const {runHarness} = await import('./batch.mjs');
  const config = await options(t, {arms: ['A', 'R', 'S', 'B']});
  config.preparedDir = join(config.out, 'prepared');
  for (const arm of ['R', 'S', 'B']) await treatment(config, arm);
  const result = await runHarness(config, harnessEnvironment());
  assert.deepEqual(result.summary.cells.map(cell => cell.status), ['passed', 'passed', 'passed', 'passed'],
    JSON.stringify(result.summary.cells.map(({id, status, reason}) => ({id, status, reason}))));
  const [, rules, sdd, both] = result.summary.cells;
  assert.equal(sdd.condition.nativeDigest, both.condition.nativeDigest);
  assert.equal(rules.condition.rulesDigest, both.condition.rulesDigest);
  assert.equal(both.condition.generationCostUsd, 0.7);
  assert.equal(both.taskCostUsd, 0.19);
  assert.deepEqual(sdd.sessions[0].observedWorkflowEntries, both.sessions[0].observedWorkflowEntries);

  await treatment(config, 'B', true);
  const mismatch = await runHarness({...config, arms: ['S', 'B']}, harnessEnvironment());
  assert.deepEqual(mismatch.summary.cells.map(cell => cell.reason), ['condition-unavailable', 'condition-unavailable']);
  assert.ok(mismatch.summary.cells.every(cell => cell.sessions.length === 0));
});
