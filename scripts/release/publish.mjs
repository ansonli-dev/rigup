import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstat, mkdir, readdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
import {promisify} from 'node:util';
import {sha256, sourceRoot} from './build.mjs';
import {renderInstaller} from './installer.mjs';

const exec = promisify(execFile);
const targets = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'];
const repository = 'ansonli-dev/rigup';
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));

async function requireArtifactSet(directory, names, type) {
  assert.ok((await lstat(directory)).isDirectory(), `Invalid artifact directory ${directory}`);
  const entries = await readdir(directory, {withFileTypes: true});
  assert.deepEqual(
    entries.map((entry) => entry.name).sort(),
    [...names].sort(),
    `Incomplete or unexpected artifact set in ${directory}`,
  );
  for (const entry of entries) {
    assert.ok(
      type === 'directory' ? entry.isDirectory() : entry.isFile(),
      `Invalid artifact type for ${entry.name}`,
    );
  }
}

function verifyReceipt(receipt, metadata, label, expected) {
  const {target, version, source, runtime, asset} = metadata;
  for (const [key, value] of Object.entries({
    status: 'passed',
    target,
    version,
    source,
    runtime,
    archiveSha256: asset.sha256,
    systemNodeOrNpmOnCliPath: false,
    modelCalls: 0,
    ...expected,
  })) {
    assert.deepEqual(receipt[key], value, `${target} ${label} receipt mismatch for ${key}`);
  }
}

export async function validateReleaseAssets({
  artifactsDir,
  tag,
  version,
  sourceCommit,
  runtimeLock,
  sourceLockSha256,
}) {
  assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'Invalid package version');
  assert.equal(tag, `v${version}`, 'Release tag must match the package version');
  assert.match(sourceCommit, /^[0-9a-f]{40}$/, 'Release source must be a full Git commit');
  await requireArtifactSet(
    artifactsDir,
    targets.map((target) => `rigup-${target}`),
    'directory',
  );

  const verifiedTargets = [];
  const files = [];
  const packageName = `rigup-${version}.tgz`;
  for (const target of targets) {
    const directory = join(artifactsDir, `rigup-${target}`);
    const name = `rigup-${version}-${target}.tar.gz`;
    const metadataName = `${target}.json`;
    const smokeName = `${target}-smoke.json`;
    const nativeName = `${target}-native.json`;
    const expected = [name, metadataName, smokeName];
    if (target === 'linux-x64') expected.push(packageName);
    if (target === 'darwin-arm64') expected.push(nativeName);
    await requireArtifactSet(directory, expected, 'file');

    const metadata = await readJson(join(directory, metadataName));
    assert.equal(metadata.schemaVersion, 1, `${target} metadata schema`);
    assert.equal(metadata.target, target, `${target} metadata target`);
    assert.equal(metadata.version, version, `${target} metadata version`);
    assert.deepEqual(
      metadata.source,
      {commit: sourceCommit, dirty: false},
      `${target} source must match the clean release commit`,
    );
    assert.deepEqual(
      metadata.runtime,
      {version: runtimeLock.version, ...runtimeLock.targets[target]},
      `${target} runtime pin mismatch`,
    );
    assert.equal(metadata.sourceLockSha256, sourceLockSha256, `${target} source lock digest mismatch`);
    const path = join(directory, name);
    const bytes = await readFile(path);
    const asset = {name, sha256: sha256(bytes), size: bytes.length};
    assert.deepEqual(metadata.asset, asset, `${target} archive name, digest or size mismatch`);

    const smoke = await readJson(join(directory, smokeName));
    verifyReceipt(smoke, metadata, 'smoke', {
      lifecycle: ['help', 'version', 'preview', 'session handoff', 'independent apply', 'no-op', 'doctor'],
      relocated: true,
      throughPathSymlink: true,
      originalBusinessPreserved: true,
      standaloneRunnerWithoutRigupApplication: true,
      consumerNodeExplicitlyProvided: true,
    });
    const verified = {metadata, smoke};
    if (target === 'darwin-arm64') {
      verified.native = await readJson(join(directory, nativeName));
      verifyReceipt(verified.native, metadata, 'native', {
        pinnedSoftwareInstalled: ['openwiki@0.7.3', 'codegraph@1.6.2'],
        codegraphInitialized: true,
        businessQuery: true,
        noOpReinitialized: false,
        openwikiScaffoldInitialization: false,
        openwikiHandoff: true,
      });
      const outcome = verified.native.daemonCleanup?.outcome;
      assert.ok(
        typeof outcome === 'string' && !['unverified', 'still-running'].includes(outcome),
        'Native daemon cleanup must be verified',
      );
    }
    verifiedTargets.push(verified);
    files.push({...asset, path});
  }

  const packagePath = join(artifactsDir, 'rigup-linux-x64', packageName);
  const packageBytes = await readFile(packagePath);
  const npm = {
    name: packageName,
    sha256: sha256(packageBytes),
    integrity: `sha512-${createHash('sha512').update(packageBytes).digest('base64')}`,
  };
  for (const {metadata} of verifiedTargets) {
    assert.deepEqual(metadata.npm, npm, `${metadata.target} npm package digest mismatch`);
  }
  files.push({name: npm.name, sha256: npm.sha256, size: packageBytes.length, path: packagePath});
  return {targets: verifiedTargets, files};
}

export async function prepareRelease({outDir, ...options}) {
  const {files, targets: verifiedTargets} = await validateReleaseAssets(options);
  const {tag, version, sourceCommit, sourceLockSha256} = options;
  await mkdir(dirname(outDir), {recursive: true});
  await mkdir(outDir);
  const writeAsset = async (name, content) => {
    const path = join(outDir, name);
    await writeFile(path, content, {flag: 'wx'});
    const asset = {name, sha256: sha256(content), size: Buffer.byteLength(content), path};
    files.push(asset);
    return asset;
  };
  await writeAsset('install.sh', await renderInstaller({version}));
  const manifest = await writeAsset(
    'release-manifest.json',
    JSON.stringify(
      {
        schemaVersion: 1,
        tag,
        version,
        source: {commit: sourceCommit, dirty: false},
        sourceLockSha256,
        assets: files.map(({name, sha256, size}) => ({name, sha256, size})),
        targets: verifiedTargets,
      },
      null,
      2,
    ) + '\n',
  );
  await writeAsset('SHA256SUMS', files.map((asset) => `${asset.sha256}  ${asset.name}\n`).join(''));

  const title = `Rigup ${tag} development preview`;
  const body = [
    'Run `rigup init` from your project root. The four portable archives include the `rigup` executable and its Node.js runtime for macOS and Linux (ARM64 and x64).',
    '',
    'Download `install.sh` and run `sh install.sh` for a user-local installation, or check your archive against `SHA256SUMS` before extracting it. Keep the complete extracted directory.',
    '',
    'Linux requires glibc 2.35 or newer. Windows users can use a supported Linux environment inside WSL2. Installed MCP runners and hooks use the consuming environment’s Node runtime.',
    '',
    `See the [installation guide](https://github.com/${repository}/blob/${sourceCommit}/docs/guides/releases.md) and [changelog](https://github.com/${repository}/blob/${sourceCommit}/CHANGELOG.md).`,
    '',
    `Source commit \`${sourceCommit}\`. Platform smoke and pinned native tool receipts accompany the release in \`release-manifest.json\`.`,
    '',
    `<!-- Rigup release manifest SHA-256 ${manifest.sha256} -->`,
    '',
  ].join('\n');
  const notesFile = join(outDir, 'NOTES.md');
  await writeFile(notesFile, body, {flag: 'wx'});
  return {tag, sourceCommit, title, body, notesFile, assets: files};
}

async function runGh(args) {
  return (await exec('gh', args, {timeout: 360_000, maxBuffer: 10_000_000})).stdout;
}

function missingReleaseAssets(release, assets) {
  const missing = new Map(assets.map((asset) => [asset.name, asset]));
  for (const remote of release.assets) {
    const local = missing.get(remote.name);
    assert.ok(local, `Unexpected or duplicate release asset ${remote.name}`);
    assert.equal(remote.state, 'uploaded', `Asset ${remote.name} has an incomplete upload`);
    assert.equal(remote.size, local.size, `Uploaded size mismatch for ${remote.name}`);
    assert.equal(remote.digest, `sha256:${local.sha256}`, `Uploaded digest mismatch for ${remote.name}`);
    missing.delete(remote.name);
  }
  return [...missing.values()];
}

export async function publishRelease({repository, bundle, runGh: gh = runGh}) {
  const {tag, sourceCommit, title, body, notesFile, assets} = bundle;
  const api = async (...args) => JSON.parse(await gh(['api', ...args]));
  const verifyTag = async () => {
    const commit = await api(`repos/${repository}/commits/${tag}`);
    assert.equal(commit.sha, sourceCommit, 'Remote release tag points to a different source commit');
  };
  const findRelease = async () => {
    const pages = await api('--paginate', '--slurp', `repos/${repository}/releases?per_page=100`);
    const matches = pages.flat().filter((release) => release.tag_name === tag);
    assert.ok(matches.length <= 1, 'Multiple releases already use this tag');
    return matches[0];
  };
  const verifyIdentity = (release) => {
    assert.ok(
      release &&
        release.tag_name === tag &&
        release.prerelease === true &&
        release.body?.trim() === body.trim(),
      'Existing release has a different release identity',
    );
  };
  await verifyTag();
  let release = await findRelease();
  if (!release) {
    await gh([
      'release',
      'create',
      tag,
      '--repo',
      repository,
      '--verify-tag',
      '--draft',
      '--prerelease',
      '--latest=false',
      '--title',
      title,
      '--notes-file',
      notesFile,
    ]);
    release = await findRelease();
    // GitHub can acknowledge draft creation before the list endpoint shows it.
    for (let retry = 0; !release && retry < 5; retry++) {
      await delay(1000);
      release = await findRelease();
    }
    assert.ok(release, 'New draft is not visible yet. Rerun the publisher with the original build artifacts.');
  }
  verifyIdentity(release);
  const missing = missingReleaseAssets(release, assets);
  if (!release.draft) {
    assert.equal(missing.length, 0, 'Published release is missing expected assets');
    return {status: 'already-published', url: release.html_url, tag, sourceCommit, assets: assets.length};
  }
  if (missing.length > 0) {
    await gh(['release', 'upload', tag, '--repo', repository, ...missing.map((asset) => asset.path)]);
  }
  const endpoint = `repos/${repository}/releases/${release.id}`;
  release = await api(endpoint);
  verifyIdentity(release);
  assert.equal(release.draft, true, 'Release changed while uploading');
  assert.equal(missingReleaseAssets(release, assets).length, 0, 'Release still has missing uploads');
  await verifyTag();
  await gh(['release', 'edit', tag, '--repo', repository, '--verify-tag', '--draft=false', '--latest=false']);
  release = await api(endpoint);
  verifyIdentity(release);
  assert.equal(release.draft, false, 'Release is still a draft');
  assert.equal(missingReleaseAssets(release, assets).length, 0, 'Published release is missing expected assets');
  return {status: 'published', url: release.html_url, tag, sourceCommit, assets: assets.length};
}

async function main() {
  const [mode, artifacts, output] = process.argv.slice(2);
  if (!['prepare', 'publish'].includes(mode) || !artifacts || !output || process.argv.length !== 5) {
    throw Error(
      'Usage: node scripts/release/publish.mjs <prepare|publish> <artifacts-directory> <output-directory>',
    );
  }
  const git = async (...args) => (await exec('git', args, {cwd: sourceRoot, timeout: 15_000})).stdout.trim();
  const sourceCommit = await git('rev-parse', 'HEAD');
  assert.equal(await git('status', '--porcelain'), '', 'Release validation requires a clean source checkout');
  const {version} = await readJson(join(sourceRoot, 'package.json'));
  const tag = mode === 'publish' ? process.env.GITHUB_REF_NAME : `v${version}`;
  if (mode === 'publish') {
    assert.equal(process.env.GITHUB_EVENT_NAME, 'push', 'Publishing requires a tag push');
    assert.equal(process.env.GITHUB_REF_TYPE, 'tag', 'Publishing requires a tag push');
    assert.equal(process.env.GITHUB_REPOSITORY, repository, 'Publishing is restricted to the Rigup repository');
    assert.equal(
      await git('rev-parse', `${process.env.GITHUB_SHA}^{commit}`),
      sourceCommit,
      'Release source differs from the tag event',
    );
  }
  const bundle = await prepareRelease({
    artifactsDir: resolve(artifacts),
    outDir: resolve(output),
    tag,
    version,
    sourceCommit,
    runtimeLock: await readJson(new URL('./runtime-lock.json', import.meta.url)),
    sourceLockSha256: sha256(await readFile(join(sourceRoot, 'package-lock.json'))),
  });
  const result =
    mode === 'publish'
      ? await publishRelease({repository, bundle})
      : {
          status: 'verified',
          tag,
          sourceCommit,
          assets: bundle.assets.map(({path, ...asset}) => asset),
        };
  console.log(JSON.stringify(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    console.error(error.message, error.stderr ?? '');
    process.exitCode = 1;
  }
}
