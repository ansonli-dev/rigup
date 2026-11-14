import assert from 'node:assert/strict';
import {execFile, execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {copyFile, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {delimiter, dirname, join} from 'node:path';
import {test, type TestContext} from 'node:test';
import {promisify} from 'node:util';

const name = '@ansonli.dev/rigup';
const registry = 'https://registry.npmjs.org/';
const exec = promisify(execFile);

async function fixture(t: TestContext, version = '0.1.2', manifest = {name, version}) {
  const directory = await mkdtemp(join(tmpdir(), 'rigup-npm-release-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  await mkdir(join(directory, 'package'));
  await writeFile(join(directory, 'package/package.json'), JSON.stringify(manifest));
  const archive = join(directory, `rigup ${version} 发布.tgz`);
  await writeFile(archive, execFileSync('tar', ['-czf', '-', '-C', directory, 'package']));
  const expectedIntegrity = `sha512-${createHash('sha512').update(await readFile(archive)).digest('base64')}`;
  return {archive, version, expectedIntegrity};
}

async function isolatedPublisher(t: TestContext, options: {archive: string; version: string; expectedIntegrity: string}, check: string, env = process.env) {
  const cwd = await mkdtemp(join(tmpdir(), 'rigup-npm-caller-'));
  t.after(() => rm(cwd, {recursive: true, force: true}));
  const module = new URL('../scripts/release/publish-npm.mjs', import.meta.url).href;
  const script = `import assert from 'node:assert/strict';
import {relative,isAbsolute} from 'node:path';
import {publishNpmArchive} from ${JSON.stringify(module)};
const options=${JSON.stringify(options)};
const request=async()=>new Response(null,{status:404});
const runNpm=async args=>assert.equal(args[1],options.archive);
${check}`;
  await exec(process.execPath, ['--input-type=module', '-e', script], {cwd, env, timeout: 30_000});
}

test('npm archive verification keeps caller tool search when the archive directory contains tar', async (t) => {
  const options = await fixture(t);
  await copyFile(process.execPath, join(dirname(options.archive), process.platform === 'win32' ? 'tar.exe' : 'tar'));
  await isolatedPublisher(t, options,
    "assert.equal((await publishNpmArchive({...options,request,runNpm})).status,'published');",
    {...process.env, PATH: ['.', process.env.PATH].filter(Boolean).join(delimiter)});
});

test('npm archive verification accepts a relative archive and completes after input EOF', async (t) => {
  const options = await fixture(t);
  await isolatedPublisher(t, options, `options.archive=relative(process.cwd(),options.archive);
assert.equal(isAbsolute(options.archive),false);
assert.equal((await publishNpmArchive({...options,request,runNpm})).status,'published');`);
});

test('npm archive verification reports missing tar and an early tar exit without an unhandled pipe error', async (t) => {
  const options = await fixture(t);
  await isolatedPublisher(t, options,
    "await assert.rejects(publishNpmArchive({...options,request,runNpm}),error=>error.code==='ENOENT');",
    {...process.env, PATH: ''});
  const bin = await mkdtemp(join(tmpdir(), 'rigup-npm-early-exit-'));
  t.after(() => rm(bin, {recursive: true, force: true}));
  if (process.platform === 'win32') await copyFile(process.execPath, join(bin, 'tar.exe'));
  else await writeFile(join(bin, 'tar'), `#!${process.execPath}\nprocess.stdin.destroy();process.exit(23);\n`, {mode: 0o755});
  const bytes = Buffer.alloc(2_000_000);
  await writeFile(options.archive, bytes);
  options.expectedIntegrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  await isolatedPublisher(t, options,
    `await assert.rejects(publishNpmArchive({...options,request,runNpm}),error=>error.code===${process.platform === 'win32' ? 9 : 23});`,
    {...process.env, PATH: bin});
});

test('npm publishes the verified tarball with latest by default and next for prereleases', async (t) => {
  const {publishNpmArchive} = await import('../scripts/release/publish-npm.mjs');
  for (const [version, tags] of [['0.1.2', []], ['0.2.0-rc.1', ['--tag', 'next']]] as const) {
    const options = await fixture(t, version);
    const commands: string[][] = [];
    const result = await publishNpmArchive({
      ...options,
      request: async (url) => {
        assert.equal(url, `${registry}%40ansonli.dev%2Frigup/${version}`);
        return new Response(null, {status: 404});
      },
      runNpm: async (args: string[]) => { commands.push(args); },
    });
    assert.equal(result.status, 'published');
    assert.deepEqual(commands, [[
      'publish', options.archive, '--ignore-scripts', '--registry', registry, '--access', 'public', ...tags,
    ]]);
  }
});

test('an npm retry skips identical bytes and refuses a conflicting published version', async (t) => {
  const {publishNpmArchive} = await import('../scripts/release/publish-npm.mjs');
  const options = await fixture(t);
  const published = {name, version: options.version, dist: {integrity: options.expectedIntegrity}};
  const retry = () => publishNpmArchive({
    ...options,
    request: async () => Response.json(published),
    runNpm: async () => assert.fail('An existing version must not be republished'),
  });
  assert.equal((await retry()).status, 'already-published');
  published.dist.integrity = 'sha512-different';
  await assert.rejects(retry(), /published version.*different integrity/i);
});

test('the npm job rejects changed bytes or a different package identity before registry access', async (t) => {
  const {publishNpmArchive} = await import('../scripts/release/publish-npm.mjs');
  const refuse = {
    request: async () => assert.fail('Unverified archives must not reach the registry'),
    runNpm: async () => assert.fail('Unverified archives must not be published'),
  };
  const options = await fixture(t);
  await assert.rejects(publishNpmArchive({...options, ...refuse, expectedIntegrity: ''}), /archive integrity/i);
  const wrongName = await fixture(t, '0.1.2', {name: 'rigup', version: '0.1.2'});
  await assert.rejects(publishNpmArchive({...wrongName, ...refuse}), /package name/i);
  const wrongVersion = await fixture(t, '0.1.2', {name, version: '0.1.0'});
  await assert.rejects(publishNpmArchive({...wrongVersion, ...refuse}), /package version/i);
});

test('npm lookup and publish failures fail the job', async (t) => {
  const {publishNpmArchive} = await import('../scripts/release/publish-npm.mjs');
  const options = await fixture(t);
  await assert.rejects(publishNpmArchive({
    ...options,
    request: async () => new Response(null, {status: 503}),
    runNpm: async () => assert.fail('A registry error must not be treated as an absent version'),
  }), /registry.*503/i);
  await assert.rejects(publishNpmArchive({
    ...options,
    request: async () => new Response(null, {status: 404}),
    runNpm: async () => { throw Error('Trusted publisher rejected'); },
  }), /trusted publisher rejected/i);
});
