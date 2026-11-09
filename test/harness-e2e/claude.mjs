import {createHash, randomUUID} from 'node:crypto';
import {constants, createReadStream} from 'node:fs';
import {access, lstat, realpath} from 'node:fs/promises';
import {homedir} from 'node:os';
import {delimiter, dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {createInterface} from 'node:readline';
import {LiveProcessCleanupError, runLiveCommand, startLiveSession} from '../live-process-support.ts';

const credentialNames = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'];
const connectionNames = ['ANTHROPIC_BASE_URL', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR'];
const maxCaptureBytes = 8_000_000;
const safeId = /^[a-z0-9][a-z0-9.+_:-]{0,119}$/i;
const tools = 'Read,Glob,Grep,Edit,Write,MultiEdit,Bash,Skill,TodoWrite,AskUserQuestion';
const readCommands = ['pwd', 'ls', 'git status', 'git diff', 'git log', 'npm test', 'node --test'];
const openSpecReadCommands = ['openspec list', 'openspec show', 'openspec status', 'openspec instructions', 'openspec validate'];
const openSpecCommands = [...openSpecReadCommands, 'openspec new change', 'openspec archive'];
const isolation = 'Work in the current disposable repository. Keep file access and commands within it. Do not install dependencies, access external services from tools, or inspect credentials.';

function select(env, keys) {
  return Object.fromEntries(keys.flatMap(key => {
    const found = process.platform === 'win32'
      ? Object.keys(env).find(name => name.toLowerCase() === key.toLowerCase())
      : key;
    return env[found] ? [[key, env[found]]] : [];
  }));
}

export function baseEnvironment(home, temp, hostEnv) {
  const env = select(hostEnv, ['PATH', 'SystemRoot', 'SystemDrive', 'WINDIR', 'ComSpec', 'PATHEXT', 'ProgramFiles', 'ProgramFiles(x86)']);
  env.PATH = [dirname(process.execPath), ...(env.PATH ?? '').split(delimiter).filter(isAbsolute)].join(delimiter);
  return {
    ...env, HOME: home, USERPROFILE: home, TMPDIR: temp, TEMP: temp, TMP: temp,
    XDG_CONFIG_HOME: join(home, 'config'), XDG_CACHE_HOME: join(home, 'cache'),
    XDG_DATA_HOME: join(home, 'data'), XDG_STATE_HOME: join(home, 'state'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1', TZ: 'UTC',
    ...(process.platform === 'win32' ? {} : {SHELL: '/bin/bash', ZDOTDIR: home}),
  };
}

export function hasEnvAuth(hostEnv) {
  return credentialNames.some(name => !!hostEnv[name]);
}

export function makeRedactor(hostEnv) {
  const sensitive = [...new Set([...credentialNames, 'ANTHROPIC_BASE_URL', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY']
    .flatMap(name => hostEnv[name] && hostEnv[name].length >= 4 ? [hostEnv[name]] : []))]
    .sort((a, b) => b.length - a.length);
  return text => {
    let result = text;
    for (const value of sensitive) {
      result = result.replaceAll(value, '[redacted]').replaceAll(JSON.stringify(value).slice(1, -1), '[redacted]');
    }
    return result.replace(/\b(?:sk-ant-|sk-proj-)[a-z0-9_-]{12,}/gi, '[redacted]');
  };
}

export function claudeEnvironment(home, temp, plugins, hostEnv, useExistingLogin, sddBin) {
  const env = baseEnvironment(home, temp, hostEnv);
  const loginHome = hostEnv.HOME || hostEnv.USERPROFILE || homedir();
  if (useExistingLogin) {
    env.HOME = loginHome;
    env.USERPROFILE = hostEnv.USERPROFILE || loginHome;
  }
  if (sddBin) env.PATH = [dirname(sddBin), env.PATH].join(delimiter);
  return {
    ...env,
    ...select(hostEnv, connectionNames),
    ...(useExistingLogin ? {} : select(hostEnv, credentialNames)),
    CLAUDE_CONFIG_DIR: useExistingLogin ? hostEnv.CLAUDE_CONFIG_DIR || join(loginHome, '.claude') : join(home, '.claude'),
    CLAUDE_CODE_PLUGIN_CACHE_DIR: plugins,
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
    CLAUDE_CODE_DISABLE_AGENT_VIEW: '1',
    CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    OPENSPEC_TELEMETRY: '0',
  };
}

function fingerprint(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
}

async function discoverClaude(claude, env) {
  if (claude && !isAbsolute(claude)) throw new Error('--claude needs an absolute executable path');
  const name = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const candidates = claude ? [claude] : env.PATH.split(delimiter).map(folder => join(folder, name));
  for (const path of candidates) {
    try {
      const executable = await realpath(path);
      if (process.platform === 'win32' && !/\.exe$/i.test(executable)) continue;
      if (!(await lstat(executable)).isFile()) continue;
      await access(executable, constants.X_OK);
      return executable;
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'EACCES') throw error;
    }
  }
  throw new Error('Claude executable unavailable. Install the latest release or supply --claude.');
}

export async function probeClaude(options, env, cwd, prefix) {
  const executable = await discoverClaude(options.claude, env);
  const stat = fingerprint(await lstat(executable));
  const result = await runLiveCommand(executable, [...prefix, '--version'], {cwd, env, timeoutMs: 15_000, maxBuffer: 8192});
  const match = /^(\d+)\.(\d+)\.(\d+)\s+\(Claude Code\)\s*$/.exec(result.stdout.trim());
  if (result.timedOut || result.code !== 0 || !match) throw new Error('Could not verify the Claude Code version');
  const [major, minor, patch] = match.slice(1).map(Number);
  if (major < 2 || (major === 2 && (minor < 1 || (minor === 1 && patch < 259)))) {
    throw new Error('Claude Code 2.1.259 or newer is required');
  }
  const version = match.slice(1).join('.');
  if (options.expectClaudeVersion && options.expectClaudeVersion !== version) throw new Error('Claude version differs from the pinned version');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(executable)) hash.update(chunk);
  if (fingerprint(await lstat(executable)) !== stat) throw new Error('Claude executable changed during preflight');
  return {executable, prefix, version, sha256: hash.digest('hex'), stat};
}

function guidanceExcludes(cwd, config) {
  const excluded = [join(config, 'CLAUDE.md'), join(config, 'rules', '**')];
  for (let parent = dirname(cwd); ; parent = dirname(parent)) {
    excluded.push(...['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', '.claude/CLAUDE.md', '.claude/AGENTS.md', '.claude/rules/**']
      .map(path => join(parent, ...path.split('/'))));
    if (parent === dirname(parent)) break;
  }
  return excluded.map(path => path.split(sep).join('/'));
}

function sessionArgs({model, sessionId, sddRoute, toolFree, cwd, env}) {
  const commands = ['Bash(npm test)', 'Bash(node --test)', 'Bash(git status *)', 'Bash(git diff *)'];
  if (sddRoute === 'openspec') commands.push(...openSpecCommands.map(command => `Bash(${command} *)`));
  return [
    '--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--restricted', '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
    '--tools', toolFree ? '' : tools,
    ...(toolFree ? ['--safe-mode'] : ['--allowedTools', 'Read', 'Glob', 'Grep', 'Edit', 'Write', 'MultiEdit', 'Skill', 'TodoWrite', 'AskUserQuestion', ...commands]),
    '--setting-sources', 'project', '--settings', JSON.stringify({
      disableAllHooks: true, disableClaudeAiConnectors: true, enableArtifact: false,
      permissions: {blockReadsOutsideWorkingDirectories: true},
      claudeMdExcludes: guidanceExcludes(cwd, env.CLAUDE_CONFIG_DIR),
    }),
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-chrome', '--no-session-persistence',
    '--model', model, '--session-id', sessionId, '--append-system-prompt', isolation,
  ];
}

function codePath(root, path) {
  if (typeof path !== 'string') return true;
  const local = relative(root, resolve(root, path)).split(sep).join('/');
  return !local || local === '..' || local.startsWith('../') || isAbsolute(local)
    || /^(?:src|test)(?:\/|$)|^package\.json$|\.(?:[cm]?[jt]sx?|py|sh|ps1)$/i.test(local);
}

function maybeImplementationEdit(block, root, sddRoute) {
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(block.name)) {
    return codePath(root, block.input?.file_path ?? block.input?.notebook_path);
  }
  if (block.name === 'Bash' || block.name === 'PowerShell') {
    const command = block.input?.command?.trim();
    const allowed = sddRoute === 'openspec' ? [...readCommands, ...openSpecCommands] : readCommands;
    return !command || /[;&|<>\x60$()\r\n]/.test(command)
      || !allowed.some(prefix => command === prefix || command.startsWith(prefix + ' '));
  }
  return ['Agent', 'Task', 'REPL'].includes(block.name);
}

function relevantQuestion(text) {
  if (typeof text !== 'string') return false;
  const questions = text.match(/[^?!.\n]+\?/g) ?? [];
  return questions.some(question =>
    /\b(?:should|would|could|can|do|does|is|are|what|when|how|which|whether)\b/i.test(question)
    && /\brefund\w*\b/i.test(question)
    && (/\b(?:status|shipped|multiple|cumulativ\w*|accumulat\w*|remain\w*|exceed\w*|audit|event)\b/i.test(question)
      || /\b(?:full|partial)\b.*\b(?:allow\w*|support\w*|keep|mark\w*|become\w*)\b/i.test(question)));
}

export function clarifyT6({text, blocks, root, sddRoute, codeUnchanged}) {
  const askedRelevant = relevantQuestion(text) || blocks.some(block =>
    block.name === 'AskUserQuestion' && Array.isArray(block.input?.questions)
    && block.input.questions.some(item => relevantQuestion(item?.question)));
  const preEdit = codeUnchanged && !blocks.some(block => maybeImplementationEdit(block, root, sddRoute));
  return {askedRelevant, codeUnchanged, preEdit};
}

function validNumber(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function usage(result) {
  return Object.fromEntries(['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']
    .map(key => [key, validNumber(result.usage?.[key])]));
}

function observedNames(init) {
  const names = [...(Array.isArray(init.skills) ? init.skills : []), ...(Array.isArray(init.slash_commands) ? init.slash_commands : [])]
    .map(value => typeof value === 'string' ? value : value?.name);
  return [...new Set(names.filter(name => typeof name === 'string' && safeId.test(name)
    && /(?:change-(?:prepare|deliver)|openspec-|opsx[:.-]|speckit[.-]|superpowers:)/i.test(name)))].sort();
}

function isBundledPlugin(plugin) {
  return plugin?.path === 'builtin' && typeof plugin.name === 'string'
    && safeId.test(plugin.name) && plugin.source === plugin.name + '@builtin';
}

class SessionError extends Error {
  constructor(reason, status = 'infrastructure-error') {
    super(reason);
    this.status = status;
    this.reason = reason;
  }
}

export async function runClaudeSession({client, model, cwd, env, sddRoute, timeoutMs, signal, prompt, followUp, toolFree = false}) {
  const started = performance.now();
  const sessionId = randomUUID();
  const metrics = {turns: [], model: null, servedModels: [], observedWorkflowEntries: [], builtinPluginCount: null, elapsedMs: null};
  const blocks = [];
  const models = new Set();
  let stdout = '', stderr = '', stdoutBytes = 0, stderrBytes = 0;
  let child, code = null, timer, stopWaiting, problem;
  let awaitingResult = true, finalText = null, followUpSent = false;
  const cancel = () => stopWaiting?.(new SessionError('interrupted', 'interrupted'));
  try {
    if (signal?.aborted) throw new SessionError('interrupted', 'interrupted');
    if (fingerprint(await lstat(client.executable)) !== client.stat) throw new SessionError('claude-executable-changed');
    child = await startLiveSession(client.executable,
      [...client.prefix, ...sessionArgs({model, sessionId, sddRoute, toolFree, cwd, env})], {cwd, env});
    const stopped = new Promise((_, reject) => { stopWaiting = reject; });
    timer = setTimeout(() => stopWaiting(new SessionError('session-timeout', 'timeout')), timeoutMs);
    signal?.addEventListener('abort', cancel, {once: true});
    if (signal?.aborted) cancel();
    child.stdin.on('error', () => stopWaiting(new SessionError('claude-stdin-error')));
    child.stdout.setEncoding('utf8').on('data', chunk => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > maxCaptureBytes) stopWaiting(new SessionError('claude-output-limit'));
      else stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', chunk => {
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes > maxCaptureBytes) stopWaiting(new SessionError('claude-output-limit'));
      else stderr += chunk;
    });
    const send = text => child.stdin.write(JSON.stringify({
      type: 'user', session_id: sessionId, parent_tool_use_id: null, message: {role: 'user', content: text},
    }) + '\n');
    let initialized = false;
    let reportedError = false;
    let turnStarted = performance.now();
    const lines = createInterface({input: child.stdout});
    const read = (async () => {
      for await (const line of lines) {
        if (!line.trim()) continue;
        let event;
        try { event = JSON.parse(line); } catch { throw new SessionError('claude-invalid-stream'); }
        if (event.type === 'system' && event.subtype === 'init') {
          if (initialized || event.session_id !== sessionId) throw new SessionError('unexpected-claude-session');
          initialized = true;
          const plugins = Array.isArray(event.plugins) ? event.plugins : [];
          if (plugins.some(plugin => !isBundledPlugin(plugin)) || event.mcp_servers?.length) {
            throw new SessionError('unexpected-claude-customization');
          }
          metrics.builtinPluginCount = plugins.length;
          if (toolFree && (!Array.isArray(event.tools) || event.tools.length)) throw new SessionError('preflight-tools-enabled');
          metrics.model = typeof event.model === 'string' && safeId.test(event.model) ? event.model : null;
          metrics.observedWorkflowEntries = observedNames(event);
          if (!sddRoute && metrics.observedWorkflowEntries.length) throw new SessionError('unexpected-sdd-discovery');
          if (sddRoute && (Array.isArray(event.skills) || Array.isArray(event.slash_commands))
            && !['change-prepare', 'change-deliver'].every(name => metrics.observedWorkflowEntries.some(entry => entry.endsWith(name)))) {
            throw new SessionError('sdd-discovery-missing');
          }
        } else if (event.type === 'assistant') {
          for (const block of event.message?.content ?? []) if (block.type === 'tool_use') blocks.push(block);
          const served = event.message?.model;
          if (typeof served === 'string' && safeId.test(served)) models.add(served);
        } else if (event.type === 'result') {
          if (!initialized || !awaitingResult || event.session_id !== sessionId) throw new SessionError('unexpected-claude-session');
          awaitingResult = false;
          finalText = typeof event.result === 'string' ? event.result : null;
          for (const served of Object.keys(event.modelUsage ?? {})) if (safeId.test(served)) models.add(served);
          metrics.turns.push({
            elapsedMs: Math.round(performance.now() - turnStarted), totalCostUsd: validNumber(event.total_cost_usd),
            usage: usage(event), durationApiMs: validNumber(event.duration_api_ms), numTurns: validNumber(event.num_turns),
          });
          if (event.subtype !== 'success' || event.is_error) {
            reportedError = true;
            child.stdin.end();
            continue;
          }
          const answer = metrics.turns.length === 1 && followUp ? await followUp({text: finalText, blocks}) : null;
          if (answer && !signal?.aborted) {
            awaitingResult = true;
            turnStarted = performance.now();
            send(answer);
            followUpSent = true;
          } else child.stdin.end();
        }
      }
    })();
    send(prompt);
    [code] = await Promise.race([Promise.all([child.completed, read]), stopped]);
    if (reportedError) throw new SessionError('claude-reported-error');
    if (code !== 0) throw new SessionError('claude-exit');
    if (awaitingResult || !metrics.turns.length) throw new SessionError('claude-result-missing');
  } catch (error) {
    problem = error instanceof SessionError ? error
      : new SessionError(error instanceof LiveProcessCleanupError ? 'process-cleanup-failed' : 'claude-transport');
    if (child) {
      try { await child.stop('SIGKILL'); }
      catch (cleanupError) {
        if (cleanupError instanceof LiveProcessCleanupError) problem = new SessionError('process-cleanup-failed');
      }
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
  metrics.elapsedMs = Math.round(performance.now() - started);
  metrics.servedModels = [...models].sort();
  metrics.costUsd = awaitingResult ? null : metrics.turns.at(-1)?.totalCostUsd ?? null;
  return {status: problem?.status ?? 'completed', reason: problem?.reason ?? null,
    code, sessionId, metrics, stdout, stderr, finalText, followUpSent};
}
