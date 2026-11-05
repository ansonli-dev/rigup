import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, mkdir, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {delimiter, dirname, join, resolve} from 'node:path';

const exec = promisify(execFile);
const source = resolve('.');
const workspace = await realpath(await mkdtemp(join(tmpdir(), 'rigup-distribution-')));
try {
  const packed = await exec('npm', ['pack', '--json', '--pack-destination', workspace], {cwd: source, timeout: 120_000, maxBuffer: 2_000_000});
  const [archive] = JSON.parse(packed.stdout);
  const paths = archive.files.map(file => file.path);
  for (const required of ['LICENSE', 'README.md', 'README.zh-CN.md', 'docs/guides/usage.md', 'docs/compatibility/status.md', 'docs/compatibility/upstream-lock.json', 'templates/scripts/check-snapshot.mjs', 'dist/cli.js']) {
    assert.ok(paths.includes(required), `distribution is missing ${required}`);
  }
  assert.ok(!paths.some(path => /(^|\/)(?:\.DS_Store|\.superpowers|node_modules|test)(?:\/|$)/.test(path) || path.startsWith('docs/compatibility/evidence/')), 'distribution contains private scratch or fixtures');
  const consumer = join(workspace, 'consumer');
  await mkdir(consumer);
  await exec('npm', ['install', '--prefix', consumer, join(workspace, archive.filename), '--prefer-offline', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--userconfig', join(workspace, 'npmrc'), '--globalconfig', join(workspace, 'global-npmrc')], {timeout: 120_000, maxBuffer: 1_000_000});
  await exec(process.execPath, [join(source, 'scripts/check-docs.mjs'), join(consumer, 'node_modules/rigup')], {timeout: 30_000});
  const cli = join(consumer, 'node_modules', '.bin', 'rigup');
  const home = join(workspace, 'home');
  const project = join(workspace, 'project');
  const skill = join(workspace, 'canary');
  for (const directory of [home, project, skill, join(project, '.rigup')]) await mkdir(directory, {recursive: true});
  await writeFile(join(skill, 'SKILL.md'), '---\nname: distribution-canary\ndescription: Use for the distribution smoke test.\n---\nRead the current task before making changes.\n');
  await writeFile(join(project, '.rigup', 'config.yaml'), JSON.stringify({agents: ['codex'], backend: 'codex', customSkills: [{source: skill}]}));
  // Make the handoff contract explicit on CI as well as inside a real agent.
  // This marker does not assert actual native discovery or start a model turn.
  const env = {...process.env, PATH: [dirname(cli), process.env.PATH].filter(Boolean).join(delimiter), HOME: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_CACHE_HOME: join(home, 'cache'), XDG_STATE_HOME: join(home, 'state'), CODEX_THREAD_ID: 'distribution-smoke-controlled-session', NO_COLOR: '1'};
  const run = async args => exec('rigup', args, {cwd: project, env, timeout: 60_000, maxBuffer: 1_000_000});
  assert.match((await run(['--help'])).stdout, /rigup init/);
  const version = JSON.parse(await readFile(join(source, 'package.json'), 'utf8')).version;
  assert.equal((await run(['--version'])).stdout.trim(), version);
  const preview = JSON.parse((await run(['init', '--sdd', 'none', '--tools', 'none', '--dry-run', '--json'])).stdout);
  assert.ok(preview.previewId, 'dry run must produce a reusable preview');
  await assert.rejects(run(['update', '--apply', preview.previewId, '--json']), error => error.code === 3 && JSON.parse(error.stdout).exitCode === 3, 'apply must require a session handoff');
  const installed = JSON.parse((await run(['update', '--apply', preview.previewId, '--sessions-ended', '--json'])).stdout);
  assert.equal(installed.installStatus, 'complete');
  assert.match(await readFile(join(project, '.agents/skills/distribution-canary/SKILL.md'), 'utf8'), /distribution-canary/);
  const unchanged = JSON.parse((await run(['update', '--sessions-ended', '--json'])).stdout);
  assert.equal(unchanged.installStatus, 'complete');
  assert.deepEqual(unchanged.written, []);
  let diagnosed;
  try { diagnosed = await run(['doctor', '--json']); }
  catch (error) { if (error.code !== 3) throw error; diagnosed = error; }
  const health = JSON.parse(diagnosed.stdout);
  assert.equal(health.status, 'complete');
  assert.ok(health.diagnostics.filter(item => item.category === 'config').every(item => item.state === 'configured'));
  assert.ok(health.diagnostics.some(item => item.category === 'host' && item.state === 'reload-required'));
  console.log(JSON.stringify({status: 'passed', package: archive.filename, integrity: archive.integrity, files: paths.length, lifecycle: ['PATH command', 'help', 'version', 'current-directory preview', 'session handoff', 'independent apply', 'no-op update', 'doctor'], doctorExit: health.exitCode, doctorHostState: 'reload-required', modelCalls: 0}));
} finally {
  await rm(workspace, {recursive: true, force: true});
}
