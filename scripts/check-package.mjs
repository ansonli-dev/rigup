import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {access, mkdtemp, mkdir, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {delimiter, dirname, join, resolve} from 'node:path';

const exec = promisify(execFile);
const windows = process.platform === 'win32';
const npmCli = process.env.npm_execpath || (windows ? join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js') : undefined);
const npm = (args, options) => npmCli ? exec(process.execPath, [npmCli, ...args], options) : exec('npm', args, options);
const source = resolve('.');
const workspace = await realpath(await mkdtemp(join(tmpdir(), 'rigup-distribution-')));
try {
  const packed = await npm(['pack', '--json', '--pack-destination', workspace], {cwd: source, timeout: 120_000, maxBuffer: 2_000_000});
  const [archive] = JSON.parse(packed.stdout);
  const paths = archive.files.map(file => file.path);
  for (const required of ['LICENSE', 'README.md', 'README.zh-CN.md', 'docs/guides/usage.md', 'docs/compatibility/status.md', 'docs/compatibility/upstream-lock.json', 'dist/integrations/tools/project-check.mjs', 'dist/cli.js']) {
    assert.ok(paths.includes(required), `distribution is missing ${required}`);
  }
  assert.ok(!paths.some(path => /(^|\/)(?:\.DS_Store|\.superpowers|node_modules|test)(?:\/|$)/.test(path) || path.startsWith('docs/compatibility/evidence/')), 'distribution contains private scratch or fixtures');
  const consumer = join(workspace, 'consumer');
  await mkdir(consumer);
  await npm(['install', '--prefix', consumer, join(workspace, archive.filename), '--cache', join(workspace, 'npm-cache'), '--registry', 'https://registry.npmjs.org/', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--userconfig', join(workspace, 'npmrc'), '--globalconfig', join(workspace, 'global-npmrc')], {timeout: 120_000, maxBuffer: 1_000_000});
  await exec(process.execPath, [join(source, 'scripts/check-docs.mjs'), join(consumer, 'node_modules', archive.name)], {timeout: 30_000});
  const bin = join(consumer, 'node_modules', '.bin');
  await access(join(bin, windows ? 'rigup.cmd' : 'rigup'));
  const home = join(workspace, 'home');
  const project = join(workspace, 'project');
  const skill = join(workspace, 'canary');
  for (const directory of [home, project, skill, join(project, '.rigup')]) await mkdir(directory, {recursive: true});
  await writeFile(join(skill, 'SKILL.md'), '---\nname: distribution-canary\ndescription: Use for the distribution smoke test.\n---\nRead the current task before making changes.\n');
  await writeFile(join(project, '.rigup', 'config.yaml'), JSON.stringify({agents: ['codex'], backend: 'codex', customSkills: [{source: skill}]}));
  // Make the handoff contract explicit on CI as well as inside a real agent.
  // This marker does not assert actual native discovery or start a model turn.
  const env = {...process.env, PATH: [bin, process.env.PATH].filter(Boolean).join(delimiter), HOME: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_CACHE_HOME: join(home, 'cache'), XDG_STATE_HOME: join(home, 'state'), CODEX_THREAD_ID: 'distribution-smoke-controlled-session', NO_COLOR: '1'};
  if (windows) env.USERPROFILE = home;
  const options = {cwd: project, env, timeout: 60_000, maxBuffer: 1_000_000};
  const run = async (args, cwd=project) => {
    const launchOptions={...options,cwd};
    if (!windows) return exec('rigup', args, launchOptions);
    // cmd.exe parses the npm shim. Pass only simple tokens, including the preview ID.
    assert.ok(args.every(arg => arg && !/[^a-z0-9-]/i.test(arg)), 'Windows shim requires simple argument tokens');
    return exec(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'rigup.cmd', ...args], launchOptions);
  };
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
  const researchRoot = join(workspace, '项目 path');
  const subdirectory = join(researchRoot, 'nested');
  await mkdir(subdirectory,{recursive:true});
  const foundation = await run(['init','--agents','claude','--sdd','none','--defer-research','--review','--json'],researchRoot).then(
    ()=>{throw Error('Research foundation must await review');},error=>{assert.equal(error.code,3,error.stderr);return JSON.parse(error.stdout);},
  );
  assert.equal(foundation.projectRules,'pending');
  await run(['update','--apply',foundation.previewId,'--sessions-ended','--json'],researchRoot);
  const {mcpServers:{rigup}}=JSON.parse(await readFile(join(researchRoot,'.mcp.json'),'utf8'));
  const mcp=exec(rigup.command,rigup.args,{...options,cwd:subdirectory});
  mcp.child.stdin.end([
    {jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25'}},
    {jsonrpc:'2.0',method:'notifications/initialized'},
    {jsonrpc:'2.0',id:2,method:'tools/list'},
    {jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'rigup_begin',arguments:{root:researchRoot,mode:'init'}}},
  ].map(value=>JSON.stringify(value)).join('\n')+'\n');
  const [initialize,tools,begin]=(await mcp).stdout.trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(initialize.result.serverInfo.version,version);
  assert.equal(tools.result.tools.length,5);
  assert.equal(begin.result.structuredContent.job.stage,'analysis');
  console.log(JSON.stringify({status: 'passed', package: archive.filename, integrity: archive.integrity, files: paths.length, lifecycle: ['PATH command', 'help', 'version', 'current-directory preview', 'session handoff', 'independent apply', 'no-op update', 'doctor', 'stdio MCP from a nested Unicode path'], doctorExit: health.exitCode, doctorHostState: 'reload-required', modelCalls: 0}));
} finally {
  await rm(workspace, {recursive: true, force: true});
}
