import {basename, isAbsolute, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {DEFAULT_TASKS, DEFAULT_TIMEOUT_MS, planHarness, preflightHarness, runHarness} from './batch.mjs';
import {makeRedactor} from './claude.mjs';
import {ARMS, SDD_ROUTES} from './conditions.mjs';
import {TASKS} from './tasks.mjs';

const help = `Rigup harness evaluation

node test/harness-e2e/run.mjs --plan [selection]
node test/harness-e2e/run.mjs --preflight --model ID --out DIRECTORY [client]
node test/harness-e2e/run.mjs --run --model ID --out DIRECTORY [selection] [client]

Selection
  --tasks T4,T5,T6            Comma-separated task IDs, including T1–T7
  --arms A,R,S,B              Bare, rules, SDD, both
  --repeats 3                 Total repeats in the matrix
  --repeat N                  Run a single repeat
  --prepared-dir DIRECTORY    Prepared Rigup overlays for R, S, and B
  --sdd-route openspec        openspec, spec-kit, or superpowers
  --sdd-bin ABSOLUTE-PATH     Put the supplied OpenSpec launcher on S/B PATH

Client
  --claude ABSOLUTE-PATH      Defaults to Claude found on PATH
  --expect-claude-version N   Require the selected Claude Code version
  --use-existing-login       Use the host login with settings isolated
  --timeout-ms 180000         Wall-clock limit per distinct session

See test/harness-e2e/README.md for preparation and evidence details.
`;

function choices(value, fallback, permitted, flag) {
  const selection = value === undefined ? fallback : value.split(',').map(entry => entry.trim());
  if (new Set(selection).size !== selection.length || selection.some(entry => !permitted.includes(entry))) {
    throw new Error(`Invalid ${flag} selection`);
  }
  return selection;
}

function integer(value, fallback, min, max, flag) {
  if (value === undefined) return fallback;
  const parsed = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error(`Invalid ${flag} value`);
  return parsed;
}

export function parseOptions(args) {
  const {values} = parseArgs({args, options: {
    help: {type: 'boolean', short: 'h'},
    plan: {type: 'boolean'}, run: {type: 'boolean'}, preflight: {type: 'boolean'},
    claude: {type: 'string'}, model: {type: 'string'}, out: {type: 'string'},
    tasks: {type: 'string'}, arms: {type: 'string'}, repeats: {type: 'string'}, repeat: {type: 'string'},
    'prepared-dir': {type: 'string'}, 'sdd-route': {type: 'string'}, 'sdd-bin': {type: 'string'},
    'expect-claude-version': {type: 'string'}, 'timeout-ms': {type: 'string'}, 'use-existing-login': {type: 'boolean'},
  }});
  if (values.help) return {help: true};
  const modes = ['plan', 'run', 'preflight'].filter(name => values[name]);
  if (modes.length !== 1) throw new Error('Choose exactly one of --plan, --preflight, or --run');
  const [mode] = modes;
  const model = values.model;
  if (mode !== 'plan' && (!model || !/^[a-z0-9][a-z0-9._:+-]{0,119}$/i.test(model) || !values.out)) {
    throw new Error('Live commands require --model with a model ID and --out with an existing absolute directory');
  }
  for (const option of ['claude', 'out', 'prepared-dir', 'sdd-bin']) {
    if (values[option] !== undefined && !isAbsolute(values[option])) throw new Error(`--${option} requires an absolute path`);
  }
  const sddRoute = values['sdd-route'] ?? 'openspec';
  if (!SDD_ROUTES.includes(sddRoute)) throw new Error('Invalid --sdd-route');
  const sddBin = values['sdd-bin'];
  if (sddBin && (sddRoute !== 'openspec' || !/^openspec(?:\.cmd|\.exe)?$/i.test(basename(sddBin)))) {
    throw new Error('--sdd-bin requires an OpenSpec launcher path');
  }
  const repeats = integer(values.repeats, 3, 1, 100, '--repeats');
  return {
    mode, model, claude: values.claude, out: values.out,
    tasks: choices(values.tasks, DEFAULT_TASKS, TASKS.map(({id}) => id), '--tasks'),
    arms: choices(values.arms, ARMS, ARMS, '--arms'),
    repeats, repeat: integer(values.repeat, undefined, 1, repeats, '--repeat'),
    preparedDir: values['prepared-dir'], sddRoute, sddBin,
    expectClaudeVersion: values['expect-claude-version'], useExistingLogin: values['use-existing-login'] ?? false,
    timeoutMs: integer(values['timeout-ms'], DEFAULT_TIMEOUT_MS, 100, 3_600_000, '--timeout-ms'),
  };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) { process.stdout.write(help); return; }
  if (options.mode === 'plan') {
    process.stdout.write(JSON.stringify(planHarness(options), null, 2) + '\n');
    return;
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    const execute = options.mode === 'preflight' ? preflightHarness : runHarness;
    const {directory, summary} = await execute({...options, signal: controller.signal});
    process.stdout.write(JSON.stringify({...summary, summaryPath: resolve(directory, 'summary.json')}, null, 2) + '\n');
    const statuses = summary.cells?.map(cell => cell.status) ?? [summary.status];
    process.exitCode = controller.signal.aborted ? 130
      : statuses.every(status => status === 'passed') ? 0
      : statuses.every(status => status === 'passed' || status === 'validation-failed') ? 1 : 2;
  } finally {
    process.off('SIGINT', abort);
    process.off('SIGTERM', abort);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    process.stderr.write(makeRedactor(process.env)(error.message ?? String(error)) + '\n');
    process.exitCode = 2;
  });
}
