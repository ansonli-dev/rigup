import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {homedir, release} from 'node:os';
import {delimiter, join, resolve} from 'node:path';
import {createRequire} from 'node:module';
import {npmCommand} from '../src/npm-command.mjs';
import {smokeNativeHosts} from './native-host-smoke-cases.mjs';

const cliVersion = '2.1.273';
const ompVersion = '18.1.13';
const windows = process.platform === 'win32';
const assets = {
  'win32-x64': ['omp-windows-x64.exe', '5d75a584acd1d8775d2ea6a14c3ea0dbdf8eb71a54bdab6ae7f38ab971aef877'],
  'linux-x64': ['omp-linux-x64', '3be5a308cc91e6f6bba148175fbe651d3583ff6d32ae221cb931dc08a64e1f39'],
  'darwin-x64': ['omp-darwin-x64', '224ee40faaff907359504749942d0df47860b96ba8098ca5127384554707f48a'],
  'darwin-arm64': ['omp-darwin-arm64', 'a4c5c9cc5b8222184d0d7429b0bb6ac2a92bbe45dd11bf68e4b1360050791909'],
};
const version = /(^|[^\d])18\.1\.13([^\d]|$)/;
const currentPath = Object.entries(process.env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(PATH|HOME|USERPROFILE|LOCALAPPDATA|APPDATA|TEMP|TMP|TMPDIR|SYSTEMROOT|WINDIR|COMSPEC|PROGRAMFILES|LANG|LC_ALL)$/i.test(key)
));
const evidence = resolve(process.argv[2]);
const stage = await realpath(await mkdtemp(join(homedir(), 'rigup native host ')));
const terminal = await mkdtemp(join(homedir(), 'rigup-native-terminal-'));
await mkdir(evidence, {recursive: true});
const result = {platform: process.platform, arch: process.arch, kernel: release(), node: process.version, sha: process.env.GITHUB_SHA};
try {
  const [asset, digest] = assets[process.platform + '-' + process.arch] ?? [];
  assert.ok(asset, 'This gate needs a supported native runner');
  const claude = join(stage, 'Claude tools');
  const home = join(stage, 'clean home');
  const binaries = join(stage, 'OMP tools');
  const tmp = join(stage, 'clean temp');
  await Promise.all([claude, home, binaries, tmp].map(path => mkdir(path, {mode: 0o700})));
  const toolEnv = {...env, HOME: home, ...(windows ? {USERPROFILE: home, TMP: tmp, TEMP: tmp} : {TMPDIR: tmp})};
  const npm = (args, cwd=terminal) => {
    const command = npmCommand(args);
    return execFileSync(command.executable, command.args, {stdio: 'inherit', timeout: 180_000, env: {...env, HOME: terminal, ...(windows ? {USERPROFILE: terminal} : {})}, cwd});
  };
  console.log('Provisioning the terminal driver');
  npm(['install', '--prefix', terminal, '--no-save', '--no-audit', '--no-fund', 'node-pty@1.1.0']);
  if(process.platform==='darwin'){
    for(const relative of ['prebuilds/darwin-'+process.arch+'/spawn-helper','build/Release/spawn-helper'])
      await chmod(join(terminal,'node_modules','node-pty',relative),0o755).catch(error=>{if(error.code!=='ENOENT')throw error;});
  }
  console.log('Provisioning pinned Claude Code');
  npm(['install', '--global', '--prefix', claude, '--no-audit', '--no-fund', '@anthropic-ai/claude-code@' + cliVersion]);
  console.log('Provisioning the pinned OMP release binary');
  const response = await fetch('https://github.com/can1357/oh-my-pi/releases/download/v' + ompVersion + '/' + asset, {signal: AbortSignal.timeout(120_000)});
  assert.equal(response.status, 200, 'Pinned OMP binary must be available');
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(createHash('sha256').update(bytes).digest('hex'), digest);
  const omp = join(binaries, windows ? 'omp.exe' : 'omp');
  await writeFile(omp, bytes, {flag: 'wx', mode: 0o700});
  if (!windows) await chmod(omp, 0o700);
  const claudeExe = windows
    ? join(claude, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
    : join(claude, 'bin', 'claude');
  const pathKey = Object.keys(toolEnv).find(key => key.toUpperCase() === 'PATH') ?? 'PATH';
  toolEnv[pathKey] = [windows ? claude : join(claude, 'bin'), binaries, currentPath].join(delimiter);
  const nativeVersion = path => execFileSync(path, ['--version'], {encoding: 'utf8', env: toolEnv, cwd: home, timeout: 20_000}).trim();
  result.git = nativeVersion('git');
  result.claude = nativeVersion(claudeExe);
  result.omp = nativeVersion(omp);
  assert.match(result.claude, /2\.1\.273/);
  assert.match(result.omp, version);
  const require = createRequire(join(terminal, 'package.json'));
  const pty = require('node-pty');
  result.terminal = await new Promise((resolve, reject) => {
    const child = pty.spawn(process.execPath, ['-e', "if(process.stdin.isTTY!==true||process.stdout.isTTY!==true)process.exit(4);console.log('RIGUP_TTY_OK')"], {cols: 120, rows: 40, cwd: home, env: toolEnv, useConpty: true});
    let tty = false;
    let out = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Terminal driver timed out')); }, 20_000);
    child.onData(chunk => { out = (out + chunk).slice(-8192); tty ||= out.includes('RIGUP_TTY_OK'); });
    child.onExit(({exitCode}) => {
      clearTimeout(timer);
      if (tty && exitCode === 0) resolve(windows ? 'ConPTY' : 'PTY');
      else reject(new Error('Terminal probe failed: ' + exitCode));
    });
  });
  if(windows)result.powershell=execFileSync('pwsh.exe',['-NoProfile','-Command','$PSVersionTable.PSVersion.ToString()'],{encoding:'utf8',env:toolEnv,cwd:home,timeout:20_000}).trim();
  if(!process.argv.includes('--preflight-only')){
    console.log('Verifying the packaged Rigup CLI in a native terminal');
    const cwd=process.cwd(),prefix=join(stage,'packaged Rigup');
    const pkg=JSON.parse(await readFile(join(cwd,'package.json'),'utf8'));
    const archive=join(stage,'ansonli.dev-rigup-'+pkg.version+'.tgz');
    npm(['pack','--pack-destination',stage],cwd);
    npm(['install','--prefix',prefix,'--no-save','--no-audit','--no-fund',archive]);
    await smokeNativeHosts({pty,stage,toolEnv,entry:join(prefix,'node_modules','@ansonli.dev','rigup','dist','cli.js'),result});
    result.rigup=pkg.version;
  }
  console.log(JSON.stringify(result));
} catch (error) {
  result.error = error.message;
  throw error;
} finally {
  await writeFile(join(evidence, 'native-hosts.json'), JSON.stringify(result, null, 2) + '\n');
  await rm(terminal, {recursive: true, force: true, maxRetries: 4});
  await rm(stage, {recursive: true, force: true, maxRetries: 4});
}
