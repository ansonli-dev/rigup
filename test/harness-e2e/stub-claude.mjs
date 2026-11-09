import assert from 'node:assert/strict';
import {access, appendFile, readFile, readdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
import {getTask} from './tasks.mjs';

const [mode, ...args] = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('9.9.0 (Claude Code)\n');
  process.exit(0);
}

for (const flag of ['--restricted', '--no-session-persistence', '--strict-mcp-config']) assert.ok(args.includes(flag));
assert.ok(!args.includes('--resume'));
assert.equal(process.env.UNRELATED_SECRET, undefined);
assert.equal(process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
const sessionId = args[args.indexOf('--session-id') + 1];
const emit = event => process.stdout.write(JSON.stringify({...event, session_id: sessionId}) + '\n');
const skills = await readdir(join('.claude', 'skills')).catch(error => {
  if (error.code === 'ENOENT') return [];
  throw error;
});
const plugins = ['cc-plugin-agents-md', 'cc-plugin-privacy', 'cc-plugin-plugin-authoring']
  .map(name => ({name, path: 'builtin', source: name + '@builtin'}));
if (mode === 'external-plugin') plugins.push({name: 'custom', path: '/external/custom', source: 'custom@marketplace'});
const tools = args[args.indexOf('--tools') + 1].split(',').filter(Boolean);
emit({type: 'system', subtype: 'init', model: 'claude-fixture-model', cwd: process.cwd(), mcp_servers: [], plugins, skills, tools});

const finish = (result, total_cost_usd) => emit({
  type: 'result', subtype: 'success', is_error: false, result, total_cost_usd,
  duration_ms: 100, duration_api_ms: 80, num_turns: 1,
  usage: {input_tokens: 120, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 40},
});

let step = 0;
for await (const line of createInterface({input: process.stdin})) {
  const input = JSON.parse(line);
  const prompt = input.message.content;
  assert.equal(input.type, 'user');
  assert.equal(input.session_id, sessionId);
  step++;
  if (prompt === 'Reply with exactly RIGUP_HARNESS_AUTH_OK.') {
    assert.equal(step, 1);
    assert.equal(args[args.indexOf('--tools') + 1], '');
    assert.ok(args.includes('--safe-mode'));
    if (mode === 'revoked') {
      assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
      emit({type: 'result', subtype: 'success', is_error: true, result: 'OAuth token revoked', total_cost_usd: 0});
      process.exitCode = 1;
    } else finish('RIGUP_HARNESS_AUTH_OK', 0.012);
    continue;
  }
  if (mode === 'timeout') {
    await new Promise(() => setInterval(() => {}, 1000));
  }
  if (prompt === getTask('T5').prompts[0]) {
    const ship = join('src', 'orders', 'ship.js');
    const original = await readFile(ship, 'utf8');
    await writeFile(ship, original
      .replace('shipOrder(order)', 'shipOrder(order, now = new Date())')
      .replace("status: 'shipped'", "status: 'shipped', shippedAt: now.toISOString()"));
    await writeFile(join('src', 'orders', 'return-window.js'), `
export const RETURN_WINDOW_DAYS = 14;
export function returnWindowOpen(order, now = new Date()) {
  const elapsed = now.getTime() - Date.parse(order.shippedAt);
  return elapsed >= 0 && elapsed <= RETURN_WINDOW_DAYS * 86400000;
}
`);
    finish('Step 1 complete', 0.1);
  } else if (prompt === getTask('T5').prompts[1]) {
    await access(join('src', 'orders', 'return-window.js'));
    await writeFile('return-notes.md', 'Step 2 took place in the same repository.\n');
    finish('Step 2 complete', 0.2);
  } else if (prompt === getTask('T5').prompts[2]) {
    await access('return-notes.md');
    finish('Step 3 complete', 0.3);
  } else if (prompt === getTask('T6').prompts[0]) {
    assert.equal(step, 1);
    if (mode === 'reverted-edit') {
      const file = join('src', 'orders', 'ship.js');
      const original = await readFile(file, 'utf8');
      await appendFile(file, '// work in progress\n');
      await writeFile(file, original);
      emit({type: 'assistant', message: {content: [{type: 'tool_use', name: 'Edit', input: {file_path: file}}]}});
    }
    process.stderr.write('redaction canary ' + (process.env.ANTHROPIC_API_KEY ?? '') + '\n');
    emit({type: 'system', subtype: 'test-redaction', detail: process.env.ANTHROPIC_API_KEY});
    finish(mode === 'irrelevant-question' ? 'Should I add tests for partial refunds?'
      : 'Should partial refunds keep the order status shipped until the full amount has been refunded?', 0.04);
  } else {
    assert.equal(mode, 'complete');
    assert.equal(step, 2);
    assert.equal(prompt, getTask('T6').clarification);
    await writeFile(join('src', 'orders', 'refund.js'), `
import {recordEvent} from '../audit/log.js';
import {DomainError} from '../error.js';
import {orderTotalCents} from './total.js';

export function refundOrder(order, amountCents) {
  if (order.status !== 'shipped') throw new DomainError('NOT_SHIPPED', 'Order must be shipped');
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw new DomainError('INVALID_AMOUNT', 'Use positive integer cents');
  const total = orderTotalCents(order);
  const refundedCents = (order.refundedCents ?? 0) + amountCents;
  if (refundedCents > total) throw new DomainError('REFUND_EXCEEDS_REMAINING', 'Amount exceeds remaining cents');
  recordEvent('order.refunded', {orderId: order.id, amountCents});
  return {...order, refundedCents, status: refundedCents === total ? 'refunded' : 'shipped'};
}
`);
    finish('Refund behavior is implemented', 0.19);
  }
}
