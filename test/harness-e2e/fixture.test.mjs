import assert from 'node:assert/strict';
import {appendFile, mkdtemp, readFile, readdir, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {writeFixture} from './fixture.mjs';
import {scoreFixture} from './score.mjs';

async function workspace(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rigup-harness-smoke-')));
  t.after(() => rm(root, {recursive: true, force: true}));
  return root;
}

test('each baseline has a passing visible suite and a fixed hidden denominator', async (t) => {
  const cases = [
    ['T1', 'final', 4],
    ['T2', 'final', 5],
    ['T3', 'final', 8],
    ['T4', 'final', 5],
    ['T5', 'step1', 5],
    ['T5', 'final', 13],
    ['T6', 'final', 7],
    ['T7', 'final', 7],
  ];

  for (const [taskId, checkpoint, total] of cases) {
    await t.test(`${taskId} ${checkpoint}`, async (t) => {
      const root = await workspace(t);
      await writeFixture(root, taskId);
      const result = await scoreFixture(root, taskId, checkpoint);
      assert.equal(result.status, 'scored', JSON.stringify(result));
      assert.equal(result.visible.status, 'passed', JSON.stringify(result.visible));
      assert.equal(result.hidden.total, total);
      assert.equal(result.hidden.failedCaseIds.length, total - result.hidden.passed);
      assert.ok(result.hidden.passed < total);
    });
  }
});

test('the store fixture has an exercised source surface in each module', async (t) => {
  const root = await workspace(t);
  await writeFixture(root, 'T7');
  for (const module of ['catalog', 'inventory', 'pricing']) {
    assert.equal((await readdir(join(root, 'src', module))).length, 18, module);
  }
  const {visible} = await scoreFixture(root, 'T7');
  assert.equal(visible.status, 'passed', JSON.stringify(visible));
  assert.equal(visible.tests, 51);
});

test('scores the implementation on a separate copy and reports visible failures independently', async (t) => {
  const root = await workspace(t);
  await writeFixture(root, 'T1');
  const entries = await readdir(root);
  assert.deepEqual(entries.sort(), ['README.md', 'package.json', 'src', 'test']);

  const source = join(root, 'src', 'orders', 'cancel.js');
  const original = await readFile(source, 'utf8');
  await writeFile(source, original.replace(
    /export function cancelOrder\(order\) \{/,
    `export function cancelOrder(order) {
  if (process.cwd() === ${JSON.stringify(root)}) throw new Error('Scored in model workspace');
  if (order.status === 'cancelled') throw new DomainError('ALREADY_CANCELLED', 'Order was cancelled');`,
  ));
  await writeFile(join(root, 'test', 'intentionally-failing.test.js'), 'throw new Error("Visible suite failed");\n');

  const result = await scoreFixture(root, 'T1');
  assert.equal(result.status, 'scored', JSON.stringify(result));
  assert.deepEqual(result.hidden, {passed: 4, total: 4, failedCaseIds: []});
  assert.equal(result.visible.status, 'failed');
  assert.deepEqual((await readdir(root)).sort(), entries);
});

test('candidate syntax errors count against the denominator', async (t) => {
  const root = await workspace(t);
  await writeFixture(root, 'T1');
  await appendFile(join(root, 'src', 'orders', 'cancel.js'), '\nexport const = 0;\n');

  const result = await scoreFixture(root, 'T1');
  assert.equal(result.status, 'scored', JSON.stringify(result));
  assert.equal(result.visible.status, 'failed');
  assert.deepEqual(result.hidden, {
    passed: 0,
    total: 4,
    failedCaseIds: ['cancel.already-cancelled', 'cancel.open', 'cancel.shipped', 'cancel.audit'],
  });
});

test('an invalid evaluator location yields no score and keeps the denominator', async (t) => {
  const root = await workspace(t);
  await writeFixture(root, 'T1');
  const result = await scoreFixture(root, 'T1', 'final', {tempDir: root});

  assert.equal(result.status, 'infrastructure-error');
  assert.deepEqual(result.hidden, {passed: null, total: 4, failedCaseIds: []});
  assert.equal(result.visible.status, 'infrastructure-error');
  assert.match(result.error, /outside the model workspace/);
});
