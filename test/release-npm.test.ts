import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test, type TestContext} from 'node:test';

const name = '@ansonli.dev/rigup';
const registry = 'https://registry.npmjs.org/';

async function fixture(t: TestContext, version = '0.1.2', manifest = {name, version}) {
  const directory = await mkdtemp(join(tmpdir(), 'rigup-npm-release-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  await mkdir(join(directory, 'package'));
  await writeFile(join(directory, 'package/package.json'), JSON.stringify(manifest));
  const archive = join(directory, `rigup-${version}.tgz`);
  execFileSync('tar', ['-czf', archive, '-C', directory, 'package']);
  const expectedIntegrity = `sha512-${createHash('sha512').update(await readFile(archive)).digest('base64')}`;
  return {archive, version, expectedIntegrity};
}

test('npm publishes the verified tarball with latest by default and next for prereleases', async (t) => {
  const {publishNpmArchive} = await import('../scripts/release/publish-npm.mjs');
  for (const [version, tags] of [['0.1.2', []], ['0.2.0-rc.1', ['--tag', 'next']]] as const) {
    const options = await fixture(t, version);
    const commands: string[][] = [];
    const result = await publishNpmArchive({
      ...options,
      request: async (url: string) => {
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
