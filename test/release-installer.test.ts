import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, readFile, readdir, readlink, realpath, rm, writeFile, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile, spawnSync} from 'node:child_process';
import {promisify} from 'node:util';
const exec = promisify(execFile),
  target = process.platform + '-' + process.arch;
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
type UnsafeArchive = boolean | 'link' | 'dot-link' | 'slash-link';

function archive(version: string, unsafe: UnsafeArchive = false) {
  const top = 'rigup-' + version + '-' + target;
  const files: {name: string; content: string; mode: number; link?: string}[] = [
    {name: top + '/rigup', content: '#!/bin/sh\nprintf "%s\\n" "' + version + '"\n', mode: 0o755},
    {name: top + '/lib/node/bin/node', content: '#!/bin/sh\nprintf "v24.22.2\\n"\n', mode: 0o755},
    {name: top + '/lib/app/dist/cli.js', content: '// immutable fixture\n', mode: 0o644},
    {name: top + '/BUILD_INFO.json', content: JSON.stringify({schemaVersion: 1, version, target}), mode: 0o644},
  ];
  if (unsafe === true) files.push({name: top + '/../../escaped', content: 'must not escape', mode: 0o644});
  if (unsafe === 'link')
    files.push({name: top + '/lib/app/outside', content: '', mode: 0o755, link: '../../../../../escaped'});
  if (unsafe === 'dot-link')
    files.push({name: top + '/lib/app/./outside', content: '', mode: 0o755, link: '../../../escaped'});
  if (unsafe === 'slash-link')
    files.push({name: top + '/lib/app/outside/', content: '', mode: 0o755, link: '../../../escaped'});
  const blocks: Buffer[] = [];
  for (const f of files) {
    const body = Buffer.from(f.content),
      header = Buffer.alloc(512);
    header.write(f.name, 0, 100);
    header.write(f.mode.toString(8).padStart(7, '0') + '\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(body.length.toString(8).padStart(11, '0') + '\0', 124);
    header.write('00000000000\0', 136);
    header.fill(32, 148, 156);
    header[156] = f.link ? 50 : 48;
    if (f.link) header.write(f.link, 157, 100);
    header.write('ustar\0', 257);
    header.write('00', 263);
    const sum = header.reduce((a, b) => a + b, 0);
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}
async function fixture(run: (f: any) => Promise<void>) {
  const {renderInstaller} = await import('../scripts/release/installer.mjs');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rigup-installer-'))),
    home = join(root, 'home');
  await mkdir(home);
  const files = new Map<string, Buffer>();
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    const data = files.get(req.url!);
    if (!data) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.end(data);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address() as import('node:net').AddressInfo;
  const env = {
    ...process.env,
    HOME: home,
    RIGUP_INSTALL_DIR: join(root, 'installation with spaces'),
    RIGUP_BIN_DIR: join(root, 'bin'),
    RIGUP_DOWNLOAD_BASE_URL: 'http://127.0.0.1:' + address.port,
  };
  const add = (
    version: string,
    {badHash = false, unsafe = false}: {badHash?: boolean; unsafe?: UnsafeArchive} = {},
  ) => {
    const name = 'rigup-' + version + '-' + target + '.tar.gz',
      bytes = archive(version, unsafe);
    files.set('/v' + version + '/' + name, bytes);
    files.set(
      '/v' + version + '/SHA256SUMS',
      Buffer.from((badHash ? '0'.repeat(64) : digest(bytes)) + '  ' + name + '\n'),
    );
  };
  const install = async (version = '0.1.0', overrides = {}) => {
    const script = join(root, 'install-' + version + '.sh');
    await writeFile(script, await renderInstaller({version}));
    let result: any;
    try {
      result = await exec('/bin/sh', [script], {
        cwd: root,
        env: {...env, ...overrides},
        timeout: 30_000,
        maxBuffer: 1_000_000,
      });
      result.code = 0;
    } catch (error) {
      result = error;
    }
    return result;
  };
  try {
    await run({root, home, env, add, install, requests: () => requests});
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    await rm(root, {recursive: true, force: true});
  }
}

test('installer verifies then installs repeats and upgrades without deleting the old version', () =>
  fixture(async (f) => {
    f.add('0.1.0');
    f.add('0.1.1');
    assert.equal((await f.install()).code, 0);
    const bin = join(f.env.RIGUP_BIN_DIR, 'rigup');
    assert.equal((await exec(bin, ['--version'])).stdout.trim(), '0.1.0');
    assert.equal((await f.install()).code, 0);
    assert.equal((await f.install('0.1.1')).code, 0);
    assert.equal((await exec(bin, ['--version'])).stdout.trim(), '0.1.1');
    assert.equal(await readlink(bin), join(f.env.RIGUP_INSTALL_DIR, 'versions/v0.1.1/rigup'));
    assert.equal((await stat(join(f.env.RIGUP_INSTALL_DIR, 'versions/v0.1.0/rigup'))).isFile(), true);
    assert.equal((await f.install()).code, 0);
    assert.equal((await exec(bin, ['--version'])).stdout.trim(), '0.1.0');
  }));
test('checksum failure preserves the installed command and never promotes the new version', () =>
  fixture(async (f) => {
    f.add('0.1.0');
    assert.equal((await f.install()).code, 0);
    f.add('0.1.1', {badHash: true});
    const failed = await f.install('0.1.1');
    assert.notEqual(failed.code, 0);
    assert.match(failed.stderr, /checksum/i);
    assert.equal(
      await readlink(join(f.env.RIGUP_BIN_DIR, 'rigup')),
      join(f.env.RIGUP_INSTALL_DIR, 'versions/v0.1.0/rigup'),
    );
    await assert.rejects(stat(join(f.env.RIGUP_INSTALL_DIR, 'versions/v0.1.1')));
  }));
test('an unrelated rigup command is never replaced or executed', () =>
  fixture(async (f) => {
    await mkdir(f.env.RIGUP_BIN_DIR);
    const path = join(f.env.RIGUP_BIN_DIR, 'rigup');
    await writeFile(path, 'unrelated command\n');
    f.add('0.1.0');
    const result = await f.install();
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /unrelated|refus|owned/i);
    assert.equal(await readFile(path, 'utf8'), 'unrelated command\n');
    assert.equal(f.requests(), 0);
  }));
test('unsafe archive members never escape staging or install a command', () =>
  fixture(async (f) => {
    f.add('0.1.0', {unsafe: true});
    const result = await f.install();
    assert.notEqual(result.code, 0);
    await assert.rejects(stat(join(f.env.RIGUP_BIN_DIR, 'rigup')));
    await assert.rejects(stat(join(f.root, 'escaped')));
  }));
test('invalid version overrides stop before downloading or changing directories', () =>
  fixture(async (f) => {
    f.add('0.1.0');
    const result = await f.install('0.1.0', {RIGUP_VERSION: 'v0.1.0/../../escape'});
    assert.notEqual(result.code, 0);
    assert.equal(f.requests(), 0);
    await assert.rejects(stat(f.env.RIGUP_INSTALL_DIR));
  }));
test('installer preserves an occupied install lock and never steals it', () =>
  fixture(async (f) => {
    f.add('0.1.0');
    assert.equal((await f.install()).code, 0);
    const lock = join(f.env.RIGUP_INSTALL_DIR, '.install-lock');
    await mkdir(lock);
    await writeFile(join(lock, 'owner'), 'unconfirmed test owner\n');
    const result = await f.install();
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /lock|occupied/i);
    assert.equal(await readFile(join(lock, 'owner'), 'utf8'), 'unconfirmed test owner\n');
  }));
test('modified owned version directories are retained for manual reconciliation', () =>
  fixture(async (f) => {
    f.add('0.1.0');
    assert.equal((await f.install()).code, 0);
    const file = join(f.env.RIGUP_INSTALL_DIR, 'versions/v0.1.0/lib/app/dist/cli.js');
    await writeFile(file, 'user modification\n');
    const result = await f.install();
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /modified|reconcil|refus/i);
    assert.equal(await readFile(file, 'utf8'), 'user modification\n');
  }));

test('archive links that leave the version directory are refused before installation', () =>
  fixture(async (f) => {
    f.add('0.1.0', {unsafe: 'link'});
    const result = await f.install();
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /unsafe|archive|link/i);
    await assert.rejects(stat(join(f.env.RIGUP_BIN_DIR, 'rigup')));
  }));

test('an installed command replaced by a directory cannot receive the next version link', () =>
  fixture(async (f) => {
    f.add('0.1.0');
    assert.equal((await f.install()).code, 0);
    const prior = join(f.env.RIGUP_INSTALL_DIR, 'versions/v0.1.0/rigup');
    await rm(prior);
    await mkdir(prior);
    f.add('0.1.1');
    const before = f.requests();
    const result = await f.install('0.1.1');
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /unrelated|refus/i);
    assert.equal(f.requests(), before);
    await assert.rejects(stat(join(prior, 'rigup')));
  }));

test('dot segments cannot hide an archive symlink that escapes its version directory', () =>
  fixture(async (f) => {
    f.add('0.1.0', {unsafe: 'dot-link'});
    const result = await f.install();
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /unsafe|archive|link/i);
    await assert.rejects(stat(join(f.env.RIGUP_BIN_DIR, 'rigup')));
  }));

test('trailing slashes cannot hide an archive symlink that escapes its version directory', () =>
  fixture(async (f) => {
    f.add('0.1.0', {unsafe: 'slash-link'});
    const result = await f.install();
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /unsafe|archive|link/i);
    await assert.rejects(stat(join(f.env.RIGUP_BIN_DIR, 'rigup')));
  }));

test('first installation preserves a command created after the ownership check', () =>
  fixture(async (f) => {
    f.add('0.1.0');
    const tools = join(f.root, 'simulated-race');
    const other = join(f.root, 'unrelated-command');
    const command = join(f.env.RIGUP_BIN_DIR, 'rigup');
    await mkdir(tools);
    await writeFile(other, 'unrelated command\n');
    const inject = `#!/bin/sh
for argument; do last=$argument; done
if [ "$last" = "$RIGUP_BIN_DIR/rigup" ]; then
  /bin/ln -s "$RIGUP_RACE_OTHER" "$last" || exit 1
fi
exec "/bin/\${0##*/}" "$@"
`;
    for (const tool of ['ln', 'mv']) await writeFile(join(tools, tool), inject, {mode: 0o755});
    const result = await f.install('0.1.0', {
      PATH: `${tools}:${f.env.PATH}`,
      RIGUP_RACE_OTHER: other,
    });
    assert.notEqual(result.code, 0);
    assert.equal(await readlink(command), other);
  }));

test('the one-line installer runs the release script only after a complete download', async () => {
  const bootstrap = await readFile(new URL('../install.sh', import.meta.url), 'utf8');
  const root = await mkdtemp(join(tmpdir(), 'rigup-bootstrap-'));
  try {
    const tools = join(root, 'tools');
    const scratch = join(root, 'downloads');
    const selected = join(root, 'installation with spaces');
    const requestedUrl = join(root, 'requested-url');
    await mkdir(tools);
    await mkdir(scratch);
    await writeFile(join(tools, 'curl'), `#!/bin/sh
set -eu
while [ "$1" != --output ]; do shift; done
printf '%s\n' "$3" > "$RIGUP_TEST_REQUESTED_URL"
cat > "$2" <<'INSTALLER'
printf 'release installer ran for %s\\n' "$RIGUP_INSTALL_DIR"
INSTALLER
exit "$RIGUP_TEST_DOWNLOAD_STATUS"
`, {mode: 0o755});
    const run = (status: string) => spawnSync('/bin/sh', [], {
      input: bootstrap,
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        PATH: `${tools}:${process.env.PATH}`,
        TMPDIR: scratch,
        RIGUP_INSTALL_DIR: selected,
        RIGUP_TEST_REQUESTED_URL: requestedUrl,
        RIGUP_TEST_DOWNLOAD_STATUS: status,
      },
    });

    const failed = run('18');
    assert.equal(failed.status, 18, failed.stderr);
    assert.equal(failed.stdout, '');
    assert.deepEqual(await readdir(scratch), []);

    const installed = run('0');
    assert.equal(installed.status, 0, installed.stderr);
    assert.equal(installed.stdout.trim(), `release installer ran for ${selected}`);
    assert.match(await readFile(requestedUrl, 'utf8'), /^https:\/\/github\.com\/ansonli-dev\/rigup\/releases\/download\/v[\w.-]+\/install\.sh\n$/);
    assert.deepEqual(await readdir(scratch), []);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
