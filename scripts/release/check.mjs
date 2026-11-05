import assert from 'node:assert/strict';
import {parse as parseToml} from 'smol-toml';
import {execFile, spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {access, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {delimiter, join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {sha256} from './build.mjs';
const exec = promisify(execFile);

export async function extractRelease(archive, workspace) {
  const listing = (await exec('tar', ['-tzf', archive], {timeout: 60_000, maxBuffer: 4_000_000})).stdout
    .trim()
    .split('\n');
  const top = listing[0].split('/')[0];
  if (!/^rigup-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?-(?:darwin|linux)-(?:arm64|x64)$/.test(top))
    throw Error('Invalid release archive root');
  for (const path of listing)
    if (
      path.startsWith('/') ||
      path.includes('\\') ||
      path.split('/').includes('..') ||
      path.split('/')[0] !== top
    )
      throw Error('Unsafe release archive path');
  await exec('tar', ['-xzf', archive, '-C', workspace], {timeout: 120_000});
  return join(workspace, top);
}
async function findCommand(name) {
  for (const base of (process.env.PATH ?? '').split(delimiter))
    try {
      const path = join(base, name);
      await access(path);
      return resolve(path);
    } catch {}
  throw Error('Release smoke requires ' + name);
}
export async function isolatedEnvironment(workspace) {
  const home = join(workspace, 'home'),
    helpers = join(workspace, 'helpers');
  await mkdir(home, {mode: 0o700});
  await mkdir(helpers);
  for (const name of ['git', 'ps', 'sh', 'dirname'])
    await symlink(await findCommand(name), join(helpers, name));
  return {
    PATH: helpers,
    HOME: home,
    CODEX_HOME: join(home, '.codex'),
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_STATE_HOME: join(home, 'state'),
    XDG_CACHE_HOME: join(home, 'cache'),
    TMPDIR: tmpdir(),
    LANG: 'C.UTF-8',
    NO_COLOR: '1',
    CODEX_THREAD_ID: 'portable-release-controlled-session',
  };
}
const pipe = (executable, args, options, input) =>
  new Promise((done, reject) => {
    const child = spawn(executable, args, {...options, stdio: ['pipe', 'pipe', 'pipe']});
    let stdout = '',
      stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(Error('Standalone consumer timeout'));
    }, 30_000);
    child.stdout.on('data', (s) => (stdout += s));
    child.stderr.on('data', (s) => (stderr += s));
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      code === 0 ? done(stdout) : reject(Error('Standalone runner exit ' + code + ': ' + stderr));
    });
    child.stdin.end(input);
  });
export async function checkRelease({archive}) {
  archive = resolve(archive);
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'rigup-portable-smoke-')));
  let complete = false;
  try {
    const extracted = await extractRelease(archive, workspace),
      relocated = join(workspace, "relocated with spaces and 'quotes'");
    await rename(extracted, relocated);
    const info = JSON.parse(await readFile(join(relocated, 'BUILD_INFO.json'), 'utf8'));
    assert.equal(info.target, process.platform + '-' + process.arch, 'release smoke must run natively');
    const node = join(relocated, 'lib/node/bin/node'),
      app = join(relocated, 'lib/app');
    assert.equal((await exec(node, ['--version'])).stdout.trim(), 'v' + info.runtime.version);
    assert.equal(sha256(await readFile(join(app, 'package-lock.json'))), info.sourceLockSha256);
    const project = join(workspace, 'consumer project');
    await mkdir(join(project, '.rigup'), {recursive: true});
    const skill = join(workspace, 'canary-skill');
    await mkdir(skill);
    await writeFile(
      join(skill, 'SKILL.md'),
      '---\nname: portable-canary\ndescription: Use for release verification.\n---\nPreserve human approval gates.\n',
    );
    const original = 'export const releaseCanary = 1;\n';
    await writeFile(join(project, 'business.js'), original);
    await writeFile(join(project, 'echo.mjs'), 'process.stdin.pipe(process.stdout);\n');
    await writeFile(
      join(project, '.rigup/config.yaml'),
      JSON.stringify({
        agents: ['codex'],
        backend: 'codex',
        customSkills: [{source: skill}],
        mcp: [
          {
            id: 'portable-echo',
            agents: ['codex'],
            command: {executable: 'node', args: ['echo.mjs'], cwd: '.', envRefs: []},
          },
        ],
      }),
    );
    const env = await isolatedEnvironment(workspace);
    const bin = join(workspace, 'bin');
    await mkdir(bin);
    await symlink(join(relocated, 'rigup'), join(bin, 'rigup'));
    env.PATH = bin + delimiter + env.PATH;
    const run = async (args, allowed = [0]) => {
      let r;
      try {
        r = await exec('rigup', args, {cwd: project, env, timeout: 90_000, maxBuffer: 4_000_000});
        r.code = 0;
      } catch (error) {
        if (!allowed.includes(error.code)) throw error;
        r = error;
      }
      assert.ok(allowed.includes(r.code));
      return r;
    };
    assert.match((await run(['--help'])).stdout, /rigup init/);
    assert.equal((await run(['--version'])).stdout.trim(), info.version);
    const preview = JSON.parse(
      (await run(['init', '--sdd', 'none', '--tools', 'none', '--dry-run', '--json'])).stdout,
    );
    assert.ok(preview.previewId);
    const handoff = JSON.parse((await run(['update', '--apply', preview.previewId, '--json'], [3])).stdout);
    assert.equal(handoff.exitCode, 3);
    const applied = JSON.parse(
      (await run(['update', '--apply', preview.previewId, '--sessions-ended', '--json'])).stdout,
    );
    assert.equal(applied.installStatus, 'complete');
    const noOp = JSON.parse((await run(['update', '--sessions-ended', '--json'])).stdout);
    assert.deepEqual(noOp.written, []);
    const doctor = JSON.parse((await run(['doctor', '--json'], [0, 3])).stdout);
    assert.ok(doctor.diagnostics.filter((d) => d.category === 'config').every((d) => d.state === 'configured'));
    assert.equal(await readFile(join(project, 'business.js'), 'utf8'), original);
    assert.match(
      await readFile(join(project, '.agents/skills/portable-canary/SKILL.md'), 'utf8'),
      /human approval/,
    );
    const config = await readFile(join(project, '.codex/config.toml'), 'utf8');
    assert.equal(parseToml(config).mcp_servers['portable-echo'].command, 'node');
    assert.ok(!config.includes(relocated));
    // Model-free standalone consumption, explicitly provisioning the host Node
    // after Rigup's entire application/dependency directory becomes unavailable.
    await rename(app, join(relocated, 'lib/app-unavailable'));
    const consumerBin = join(workspace, 'consumer-bin');
    await mkdir(consumerBin);
    await symlink(process.execPath, join(consumerBin, 'node'));
    const echo = await pipe(
      join(consumerBin, 'node'),
      [join(project, '.rigup/mcp/portable-echo.mjs')],
      {cwd: project, env: {...env, PATH: consumerBin + delimiter + env.PATH}},
      'standalone-portable-echo\n',
    );
    assert.equal(echo, 'standalone-portable-echo\n');
    const receipt = {
      status: 'passed',
      target: info.target,
      version: info.version,
      source: info.source,
      runtime: info.runtime,
      archiveSha256: sha256(await readFile(archive)),
      systemNodeOrNpmOnCliPath: false,
      relocated: true,
      throughPathSymlink: true,
      lifecycle: ['help', 'version', 'preview', 'session handoff', 'independent apply', 'no-op', 'doctor'],
      originalBusinessPreserved: true,
      standaloneRunnerWithoutRigupApplication: true,
      consumerNodeExplicitlyProvided: true,
      doctorExit: doctor.exitCode,
      modelCalls: 0,
    };
    complete = true;
    return receipt;
  } catch (error) {
    error.message += ' (retained release smoke fixture: ' + workspace + ')';
    throw error;
  } finally {
    if (complete) await rm(workspace, {recursive: true, force: true});
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw Error('Usage: node scripts/release/check.mjs archive.tar.gz');
    console.log(JSON.stringify(await checkRelease({archive: process.argv[2]})));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
