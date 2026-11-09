import {createHash} from 'node:crypto';
import {lstat, mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';

export const ARMS = ['A', 'R', 'S', 'B'];
export const SDD_ROUTES = ['openspec', 'spec-kit', 'superpowers'];

const rulesPath = path => path === 'docs/rigup/development-rules.md'
  || path.startsWith('docs/rigup/development-rules/') || path.startsWith('.claude/rules/');
const workflowPath = path => /^\.claude\/skills\/change-(?:prepare|deliver)\//.test(path);
const nativePath = {
  openspec: path => path.startsWith('openspec/') || /^\.claude\/(?:skills|commands)\/(?:openspec[-/]|opsx[-/])/.test(path),
  'spec-kit': path => path.startsWith('.specify/') || /^\.claude\/(?:skills|commands)\/speckit[-.]/.test(path),
  superpowers: path => /^\.claude\/skills\/(?:superpowers[-/]|brainstorming\/|writing-plans\/|executing-plans\/|verification-before-completion\/)/.test(path),
};
const nativeEntries = {
  openspec: ['propose', 'apply-change', 'archive-change'],
  'spec-kit': ['constitution', 'specify', 'plan', 'tasks', 'implement', 'converge'],
  superpowers: ['brainstorming', 'writing-plans', 'executing-plans', 'verification-before-completion'],
};
const slug = /^[a-z0-9][a-z0-9.+_-]{0,79}$/i;

export function usesSdd(arm) {
  return arm === 'S' || arm === 'B';
}

function usesRules(arm) {
  return arm === 'R' || arm === 'B';
}

async function directory(path) {
  if (!(await lstat(path)).isDirectory()) throw new Error('Prepared path is not a regular directory');
}

async function readMetadata(path, route, redact) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size > 8_192) throw new Error('Prepared metadata must be a small regular file');
  const raw = await readFile(path, 'utf8');
  if (redact(raw) !== raw) throw new Error('Prepared metadata contains a credential');
  const {rigupVersion, rigupCommit, sddRoute, nativeVersion, generationCostUsd} = JSON.parse(raw);
  if (typeof rigupVersion !== 'string' || !slug.test(rigupVersion)
    || (rigupCommit !== undefined && (typeof rigupCommit !== 'string' || !/^[a-f0-9]{40}$/.test(rigupCommit)))
    || sddRoute !== route
    || (route === null ? nativeVersion !== null : typeof nativeVersion !== 'string' || !slug.test(nativeVersion))
    || (generationCostUsd !== null && (!Number.isFinite(generationCostUsd) || generationCostUsd < 0))) {
    throw new Error('Prepared metadata is missing the expected versions, route, or generation cost');
  }
  return {rigupVersion, ...(rigupCommit ? {rigupCommit} : {}), sddRoute, nativeVersion, generationCostUsd};
}

async function readOverlay(root, arm, route, redact) {
  await directory(root);
  const files = [];
  let bytes = 0;
  async function visit(folder, prefix) {
    for (const name of (await readdir(folder)).sort()) {
      const path = prefix + name;
      if (/^(?:\.env(?:\.|$)|node_modules$|\.git$|.*(?:credentials|secrets).*|.*\.local\.)/i.test(name)
        || !/^[a-z0-9._-]+$/i.test(name)) throw new Error('Prepared overlay contains a disallowed path');
      const fullPath = join(folder, name);
      const stat = await lstat(fullPath);
      if (stat.isDirectory()) {
        await visit(fullPath, path + '/');
        continue;
      }
      if (!stat.isFile()) throw new Error('Prepared overlay contains a link or special file');
      if (path.startsWith('openspec/changes/') || path.startsWith('openspec/specs/')) {
        throw new Error('Prepared OpenSpec overlay must precede task authoring');
      }
      const allowed = path === 'CLAUDE.md'
        || (usesRules(arm) && rulesPath(path))
        || (route && (workflowPath(path) || nativePath[route](path)));
      if (!allowed || !/\.(?:md|mdc|ya?ml|json|sh|ps1|js|mjs|py|toml|txt)$/.test(path)) {
        throw new Error('Prepared overlay contains a file outside the selected treatment');
      }
      bytes += stat.size;
      if (stat.size > 512_000 || bytes > 8_000_000 || files.length >= 400) throw new Error('Prepared overlay is too large');
      const contents = await readFile(fullPath, 'utf8');
      if (contents.includes('\u0000') || redact(contents) !== contents) throw new Error('Prepared overlay contains a binary file or credential');
      files.push({path, contents, executable: !!(stat.mode & 0o111)});
    }
  }
  await visit(root, '');
  return files;
}

function digestFiles(files) {
  return createHash('sha256').update(JSON.stringify(files)).digest('hex');
}

function validateOverlay(files, arm, route) {
  const entry = files.find(file => file.path === 'CLAUDE.md');
  const has = path => files.some(file => file.path === path);
  if (!entry?.contents.trim()) throw new Error('Prepared overlay must have CLAUDE.md');
  if (usesRules(arm) && (!has('docs/rigup/development-rules.md') || !entry.contents.includes('docs/rigup/development-rules.md'))) {
    throw new Error('Rules arm needs the installed rule index and its CLAUDE.md link');
  }
  if (route) {
    if (!has('.claude/skills/change-prepare/SKILL.md') || !has('.claude/skills/change-deliver/SKILL.md')) {
      throw new Error('SDD arm needs the installed Rigup workflow skills');
    }
    const native = files.filter(file => nativePath[route](file.path));
    const missing = nativeEntries[route].some(entry => !native.some(({path}) => {
      const matches = route === 'openspec'
        ? ['openspec-' + entry, 'opsx-' + entry.replace('-change', '')]
        : route === 'spec-kit' ? ['speckit-' + entry, 'speckit.' + entry] : [entry, 'superpowers-' + entry];
      return matches.some(name => path.includes('/' + name + '/') || path.endsWith('/' + name + '.md'))
        || (route === 'openspec' && path.endsWith('/opsx/' + entry.replace('-change', '') + '.md'));
    }));
    if (missing || (route === 'openspec' && !has('openspec/config.yaml'))) {
      throw new Error('SDD arm lacks the expected native workflow entries');
    }
  }
}

export async function loadConditions(plan, options, redact) {
  const conditions = new Map();
  for (const {taskId, arm} of plan.cells) {
    const key = taskId + '/' + arm;
    if (conditions.has(key)) continue;
    if (arm === 'A') {
      conditions.set(key, {files: [], metadata: {sddRoute: null, generationCostUsd: 0}});
      continue;
    }
    try {
      if (!options.preparedDir) throw new Error('Supply --prepared-dir for prepared conditions');
      await directory(options.preparedDir);
      const taskDir = join(options.preparedDir, taskId);
      await directory(taskDir);
      const route = usesSdd(arm) ? options.sddRoute : null;
      const metadata = await readMetadata(join(taskDir, arm + '.json'), route, redact);
      const files = await readOverlay(join(taskDir, arm), arm, route, redact);
      validateOverlay(files, arm, route);
      conditions.set(key, {
        files,
        metadata: {
          ...metadata,
          assetsDigest: digestFiles(files),
          ...(usesRules(arm) ? {rulesDigest: digestFiles(files.filter(file => rulesPath(file.path)))} : {}),
          ...(route ? {nativeDigest: digestFiles(files.filter(file => nativePath[route](file.path)))} : {}),
        },
      });
    } catch (error) {
      conditions.set(key, {error});
    }
  }
  for (const taskId of new Set(plan.cells.map(cell => cell.taskId))) {
    const sdd = conditions.get(taskId + '/S');
    const both = conditions.get(taskId + '/B');
    if (sdd?.metadata && both?.metadata && (
      sdd.metadata.nativeVersion !== both.metadata.nativeVersion || sdd.metadata.nativeDigest !== both.metadata.nativeDigest
    )) {
      const error = new Error('S and B use different native SDD assets or versions');
      conditions.set(taskId + '/S', {error});
      conditions.set(taskId + '/B', {error});
    }
    const rules = conditions.get(taskId + '/R');
    if (rules?.metadata && both?.metadata && rules.metadata.rulesDigest !== both.metadata.rulesDigest) {
      const error = new Error('R and B use different generated rules');
      conditions.set(taskId + '/R', {error});
      conditions.set(taskId + '/B', {error});
    }
  }
  return conditions;
}

export async function applyCondition(root, condition) {
  for (const {path, contents, executable} of condition.files) {
    const target = join(root, ...path.split('/'));
    await mkdir(dirname(target), {recursive: true});
    await writeFile(target, contents, {flag: 'wx', mode: executable ? 0o700 : 0o600});
  }
}
