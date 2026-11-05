import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test, type TestContext} from 'node:test';

const version = '0.1.0';
const tag = `v${version}`;
const sourceCommit = 'a'.repeat(40);
const sourceLockSha256 = 'b'.repeat(64);
const repository = 'ansonli-dev/rigup';
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const lifecycle = ['help', 'version', 'preview', 'session handoff', 'independent apply', 'no-op', 'doctor'];

async function fixture(t: TestContext) {
  const artifactsDir = await mkdtemp(join(tmpdir(), 'rigup-release-fixture-'));
  t.after(() => rm(artifactsDir, {recursive: true, force: true}));
  const runtimeLock = JSON.parse(
    await readFile(new URL('../scripts/release/runtime-lock.json', import.meta.url), 'utf8'),
  );
  const options = {artifactsDir, tag, version, sourceCommit, sourceLockSha256, runtimeLock};
  const npmBytes = Buffer.from('compiled npm fixture');
  const npm = {
    name: `rigup-${version}.tgz`,
    sha256: sha256(npmBytes),
    integrity: `sha512-${createHash('sha512').update(npmBytes).digest('base64')}`,
  };
  for (const [target, lockedRuntime] of Object.entries(runtimeLock.targets)) {
    const dir = join(artifactsDir, `rigup-${target}`);
    await mkdir(dir);
    const archiveBytes = Buffer.from(`archive fixture ${target}`);
    const asset = {
      name: `rigup-${version}-${target}.tar.gz`,
      sha256: sha256(archiveBytes),
      size: archiveBytes.length,
    };
    const identity = {
      target,
      version,
      source: {commit: sourceCommit, dirty: false},
      runtime: {version: runtimeLock.version, ...(lockedRuntime as object)},
    };
    await writeFile(join(dir, asset.name), archiveBytes);
    await writeFile(
      join(dir, `${target}.json`),
      JSON.stringify({schemaVersion: 1, ...identity, npm, sourceLockSha256, asset}),
    );
    const smoke = {
      status: 'passed',
      ...identity,
      archiveSha256: asset.sha256,
      systemNodeOrNpmOnCliPath: false,
      lifecycle,
      relocated: true,
      throughPathSymlink: true,
      originalBusinessPreserved: true,
      standaloneRunnerWithoutRigupApplication: true,
      consumerNodeExplicitlyProvided: true,
      modelCalls: 0,
    };
    await writeFile(join(dir, `${target}-smoke.json`), JSON.stringify(smoke));
    if (target === 'darwin-arm64') {
      await writeFile(
        join(dir, `${target}-native.json`),
        JSON.stringify({
          status: 'passed',
          ...identity,
          archiveSha256: asset.sha256,
          systemNodeOrNpmOnCliPath: false,
          pinnedSoftwareInstalled: ['openwiki@0.7.3', 'codegraph@1.6.2'],
          codegraphInitialized: true,
          businessQuery: true,
          noOpReinitialized: false,
          openwikiScaffoldInitialization: false,
          openwikiHandoff: true,
          daemonCleanup: {outcome: 'no-daemon-record'},
          modelCalls: 0,
        }),
      );
    }
    if (target === 'linux-x64') await writeFile(join(dir, npm.name), npmBytes);
  }
  const edit = async (target: string, file: string, change: Record<string, unknown>) => {
    const path = join(artifactsDir, `rigup-${target}`, file);
    await writeFile(path, JSON.stringify({...JSON.parse(await readFile(path, 'utf8')), ...change}));
  };
  return {options, edit};
}

test('complete release is bound to four targets and a single verified npm package', async (t) => {
  const {validateReleaseAssets} = await import('../scripts/release/publish.mjs');
  const {options} = await fixture(t);
  const result = await validateReleaseAssets(options);
  assert.deepEqual(
    result.targets.map(({metadata}: any) => metadata.target),
    Object.keys(options.runtimeLock.targets),
  );
  assert.equal(result.files.length, 5);
  assert.equal(result.files.at(-1).name, 'rigup-0.1.0.tgz');
});

test('tag version mismatch and incomplete artifact sets fail before staging a release', async (t) => {
  const {validateReleaseAssets} = await import('../scripts/release/publish.mjs');
  const {options} = await fixture(t);
  await assert.rejects(validateReleaseAssets({...options, tag: 'v0.1.1'}), /tag.*version/i);
  await rm(join(options.artifactsDir, 'rigup-linux-arm64'), {recursive: true});
  await assert.rejects(validateReleaseAssets(options), /artifact.*set/i);
});

test('duplicate targets and dirty or mixed source commits are rejected', async (t) => {
  const {validateReleaseAssets} = await import('../scripts/release/publish.mjs');
  const {options, edit} = await fixture(t);
  await edit('linux-arm64', 'linux-arm64.json', {target: 'linux-x64'});
  await assert.rejects(validateReleaseAssets(options), /target/i);
  await edit('linux-arm64', 'linux-arm64.json', {
    target: 'linux-arm64',
    source: {commit: sourceCommit, dirty: true},
  });
  await assert.rejects(validateReleaseAssets(options), /source/i);
  await edit('linux-arm64', 'linux-arm64.json', {source: {commit: 'c'.repeat(40), dirty: false}});
  await assert.rejects(validateReleaseAssets(options), /source/i);
});

test('changed archives and mismatched production package bytes block publication', async (t) => {
  const {validateReleaseAssets} = await import('../scripts/release/publish.mjs');
  const {options} = await fixture(t);
  const archive = join(options.artifactsDir, 'rigup-linux-x64', `rigup-${version}-linux-x64.tar.gz`);
  const original = await readFile(archive);
  const corrupted = Buffer.from(original);
  corrupted[0] ^= 1;
  await writeFile(archive, corrupted);
  await assert.rejects(validateReleaseAssets(options), /archive.*digest/i);
  await writeFile(archive, original);
  await writeFile(
    join(options.artifactsDir, 'rigup-linux-x64', `rigup-${version}.tgz`),
    'unexpected npm bytes',
  );
  await assert.rejects(validateReleaseAssets(options), /npm.*digest/i);
});

test('portable and native receipts must verify these archive bytes', async (t) => {
  const {validateReleaseAssets} = await import('../scripts/release/publish.mjs');
  const {options, edit} = await fixture(t);
  const dir = join(options.artifactsDir, 'rigup-darwin-arm64');
  const native = join(dir, 'darwin-arm64-native.json');
  const original = await readFile(native);
  await rm(native);
  await assert.rejects(validateReleaseAssets(options), /artifact.*set/i);
  await writeFile(native, original);
  await edit('darwin-arm64', 'darwin-arm64-native.json', {archiveSha256: '0'.repeat(64)});
  await assert.rejects(validateReleaseAssets(options), /native.*archive/i);
  await writeFile(native, original);
  await edit('linux-x64', 'linux-x64-smoke.json', {standaloneRunnerWithoutRigupApplication: false});
  await assert.rejects(validateReleaseAssets(options), /smoke.*standalone/i);
});

function draftFixture() {
  const body = 'Verified preview\n';
  const assets = ['SHA256SUMS', `rigup-${version}-linux-x64.tar.gz`].map((name) => ({
    name,
    path: `/fixture/${name}`,
    size: 16,
    sha256: 'd'.repeat(64),
  }));
  const bundle = {
    tag,
    sourceCommit,
    title: 'Rigup v0.1.0 development preview',
    body,
    notesFile: '/fixture/NOTES.md',
    assets,
  };
  const remote = {
    id: 42,
    tag_name: tag,
    target_commitish: sourceCommit,
    body,
    draft: true,
    prerelease: true,
    html_url: `https://github.com/${repository}/releases/tag/${tag}`,
    assets: assets.map(({name, size, sha256}) => ({name, size, state: 'uploaded', digest: `sha256:${sha256}`})),
  };
  return {bundle, remote};
}

test('a matching draft resumes missing uploads and verifies every uploaded asset before publication', async () => {
  const {publishRelease} = await import('../scripts/release/publish.mjs');
  const {bundle, remote} = draftFixture();
  const [present, missing] = remote.assets;
  remote.assets = [present];
  const mutations: string[][] = [];
  const runGh = async (args: string[]) => {
    if (args.includes(`repos/${repository}/commits/${tag}`)) return JSON.stringify({sha: sourceCommit});
    if (args.includes(`repos/${repository}/releases?per_page=100`)) return JSON.stringify([[remote]]);
    if (args.includes(`repos/${repository}/releases/${remote.id}`)) return JSON.stringify(remote);
    mutations.push(args);
    if (args[1] === 'upload') {
      assert.equal(args.includes('--clobber'), false);
      assert.equal(args.includes(bundle.assets[0].path), false);
      assert.equal(args.includes(bundle.assets[1].path), true);
      remote.assets.push(missing);
    } else if (args[1] === 'edit') {
      assert.equal(remote.assets.length, bundle.assets.length);
      remote.draft = false;
    } else {
      assert.fail(`Unexpected GitHub mutation ${args[1]}`);
    }
    return '';
  };
  assert.equal((await publishRelease({repository, bundle, runGh})).status, 'published');
  assert.deepEqual(
    mutations.map((args) => args[1]),
    ['upload', 'edit'],
  );
  assert.equal((await publishRelease({repository, bundle, runGh})).status, 'already-published');
  assert.equal(mutations.length, 2);
});

test('unrelated or digest-mismatched drafts are preserved without GitHub mutations', async () => {
  const {publishRelease} = await import('../scripts/release/publish.mjs');
  const {bundle, remote} = draftFixture();
  const runGh = async (args: string[]) => {
    if (args.includes(`repos/${repository}/commits/${tag}`)) return JSON.stringify({sha: sourceCommit});
    if (args.includes(`repos/${repository}/releases?per_page=100`)) return JSON.stringify([[remote]]);
    if (args.includes(`repos/${repository}/releases/${remote.id}`)) return JSON.stringify(remote);
    assert.fail('A conflicting draft must not be mutated');
  };
  remote.body = 'Different release\n';
  await assert.rejects(publishRelease({repository, bundle, runGh}), /different.*release|release.*identity/i);
  remote.body = bundle.body;
  remote.assets[0].digest = `sha256:${'0'.repeat(64)}`;
  await assert.rejects(publishRelease({repository, bundle, runGh}), /uploaded.*digest/i);
});

test('publishing waits for a newly created draft to appear in the release listing', async () => {
  const {publishRelease} = await import('../scripts/release/publish.mjs');
  const {bundle, remote} = draftFixture();
  let created = false;
  let readsAfterCreation = 0;
  const mutations: string[] = [];
  const runGh = async (args: string[]) => {
    if (args.includes(`repos/${repository}/commits/${tag}`)) return JSON.stringify({sha: sourceCommit});
    if (args.includes(`repos/${repository}/releases?per_page=100`)) {
      const visible = created && ++readsAfterCreation > 1;
      return JSON.stringify([visible ? [remote] : []]);
    }
    if (args.includes(`repos/${repository}/releases/${remote.id}`)) return JSON.stringify(remote);
    mutations.push(args[1]);
    if (args[1] === 'create') {
      assert.ok(args.includes('--draft'));
      assert.ok(args.includes('--verify-tag'));
      created = true;
      remote.assets = [];
    } else if (args[1] === 'upload') {
      remote.assets = draftFixture().remote.assets;
    } else if (args[1] === 'edit') {
      remote.draft = false;
    } else {
      assert.fail(`Unexpected GitHub mutation ${args[1]}`);
    }
    return '';
  };
  assert.equal((await publishRelease({repository, bundle, runGh})).status, 'published');
  assert.deepEqual(mutations, ['create', 'upload', 'edit']);
  assert.equal(readsAfterCreation, 2);
});
