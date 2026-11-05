import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {promisify} from 'node:util';

const exec = promisify(execFile);
const packageName = '@ansonli.dev/rigup';
const registry = 'https://registry.npmjs.org/';

async function runNpmPublish(args) {
  const {stdout, stderr} = await exec('npm', args, {timeout: 300_000});
  process.stdout.write(stdout);
  process.stderr.write(stderr);
}

export async function publishNpmArchive({archive, version, expectedIntegrity, request = fetch, runNpm = runNpmPublish}) {
  assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'Invalid package version');
  const integrity = `sha512-${createHash('sha512').update(await readFile(archive)).digest('base64')}`;
  assert.equal(integrity, expectedIntegrity, 'npm archive integrity differs from the verified release');
  const {stdout} = await exec('tar', ['-xOzf', archive, 'package/package.json'], {timeout: 15_000});
  const manifest = JSON.parse(stdout);
  assert.equal(manifest.name, packageName, 'Unexpected npm package name');
  assert.equal(manifest.version, version, 'npm package version differs from the release');

  const spec = `${packageName}@${version}`;
  const response = await request(`${registry}${encodeURIComponent(packageName)}/${version}`, {
    headers: {'Cache-Control': 'no-cache'},
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status !== 404) {
    assert.ok(response.ok, `npm registry lookup for ${spec} returned HTTP ${response.status}`);
    const published = await response.json();
    assert.equal(published.name, packageName, 'Unexpected package name from npm');
    assert.equal(published.version, version, 'Unexpected version from npm');
    assert.equal(published.dist?.integrity, integrity, `Published version ${spec} has different integrity`);
    return {status: 'already-published', package: spec, integrity};
  }

  const args = ['publish', archive, '--ignore-scripts', '--registry', registry, '--access', 'public'];
  // npm's implicit latest tag also rejects an older stable version.
  if (version.includes('-')) args.push('--tag', 'next');
  await runNpm(args);
  return {status: 'published', package: spec, integrity};
}

async function main() {
  const [directory, expectedIntegrity] = process.argv.slice(2);
  assert.ok(directory && expectedIntegrity && process.argv.length === 4,
    'Usage: node scripts/release/publish-npm.mjs <archive-directory> <verified-integrity>');
  assert.equal(process.env.GITHUB_REPOSITORY, 'ansonli-dev/rigup', 'Publishing is restricted to the Rigup repository');
  assert.equal(process.env.GITHUB_EVENT_NAME, 'push', 'Publishing requires a tag push');
  assert.equal(process.env.GITHUB_REF_TYPE, 'tag', 'Publishing requires a tag push');
  const {version} = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(process.env.GITHUB_REF_NAME, `v${version}`, 'Release tag must match the package version');
  const archive = resolve(directory, `rigup-${version}.tgz`);
  console.log(JSON.stringify(await publishNpmArchive({archive, version, expectedIntegrity})));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    console.error(error.message, error.stderr ?? '');
    process.exitCode = 1;
  }
}
