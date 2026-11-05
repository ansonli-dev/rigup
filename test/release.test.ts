import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
  link,
  copyFile,
  rename,
  symlink,
  rm,
} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';

const run = (file: string, args: string[], options: {cwd: string; env: NodeJS.ProcessEnv}, input?: string) =>
  new Promise<{code: number | null; stdout: string; stderr: string}>((done, reject) => {
    const child = spawn(file, args, {...options, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']});
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.once('error', reject);
    child.once('close', (code) => done({code, stdout, stderr}));
    child.stdin?.once('error', reject);
    child.stdin?.end(input);
  });

test('portable launcher uses its own runtime and resources through relocation and a symlink', async () => {
  const {compileLauncher} = await import('../scripts/release/build.mjs');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rigup-release-test-')));
  try {
    let portable = join(root, "release with 'quotes' and spaces");
    const project = join(root, 'consumer project');
    await mkdir(project);
    await mkdir(join(portable, 'lib/node/bin'), {recursive: true});
    await mkdir(join(portable, 'lib/app/dist'), {recursive: true});
    try {
      await link(process.execPath, join(portable, 'lib/node/bin/node'));
    } catch {
      await copyFile(process.execPath, join(portable, 'lib/node/bin/node'));
    }
    await writeFile(
      join(portable, 'lib/app/dist/cli.js'),
      "console.log(JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd(),executable:process.execPath,path:process.env.PATH,stdin:require('node:fs').readFileSync(0,'utf8')}));\n",
    );
    await compileLauncher({outDir: portable});
    const moved = join(root, 'relocated release');
    await rename(portable, moved);
    portable = moved;
    const bin = join(root, 'bin');
    await mkdir(bin);
    await symlink(join(portable, 'rigup'), join(bin, 'rigup'));
    const args = ['init', '.', '--agents', 'claude,codex', '--literal', "space 'quote' $(not-a-shell) 中文"];
    const result = await run(
      join(bin, 'rigup'),
      args,
      {cwd: project, env: {...process.env, PATH: '/no-system-node', RIGUP_RELEASE_ROOT: '/not-authority'}},
      'stdin preserved\n',
    );
    assert.equal(result.code, 0, result.stderr);
    const actual = JSON.parse(result.stdout);
    assert.deepEqual(actual.argv, args);
    assert.equal(actual.cwd, project);
    assert.equal(actual.executable, join(portable, 'lib/node/bin/node'));
    assert.equal(actual.stdin, 'stdin preserved\n');
    assert.equal(actual.path, join(portable, 'lib/node/bin') + ':/no-system-node');
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('an incomplete portable directory never falls back to system Node or another checkout', async () => {
  const {compileLauncher} = await import('../scripts/release/build.mjs');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rigup-incomplete-release-')));
  try {
    await compileLauncher({outDir: root});
    const result = await run(join(root, 'rigup'), ['--version'], {cwd: resolve('.'), env: process.env});
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /incomplete|missing/i);
    assert.equal(result.stdout, '');
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
