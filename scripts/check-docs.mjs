import {access, readFile, readdir} from 'node:fs/promises';
import {dirname, join, relative, resolve} from 'node:path';

const root = resolve(process.argv[2] ?? '.');
async function markdownFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const path = join(directory, entry.name);
    // Archived generated snippets keep links relative to their original consumer
    // project. Check their README indexes, without rewriting immutable evidence.
    if (entry.isDirectory()) result.push(...await markdownFiles(path));
    else if (relative(root, path).startsWith('docs/compatibility/evidence/') && entry.name !== 'README.md') continue;
    else if (entry.isFile() && entry.name.endsWith('.md')) result.push(path);
  }
  return result;
}
const files = [...(await readdir(root)).filter(name => name.endsWith('.md')).map(name => join(root, name)), ...await markdownFiles(join(root, 'docs'))];
const failures = [];
let links = 0;
for (const file of files) {
  const content = (await readFile(file, 'utf8')).replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\1\s*$/gm, '').replace(/`[^`\n]*`/g, '');
  const targets = [...content.matchAll(/\[[^\]\n]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+[^)]*)?\)/g)].map(match => match[1]);
  targets.push(...[...content.matchAll(/^\[[^\]\n]+\]:\s*(<[^>]+>|\S+)/gm)].map(match => match[1]));
  for (let target of targets) {
    target = target.replace(/^<|>$/g, '');
    if (!target || target.startsWith('#') || /^[a-z][a-z\d+.-]*:/i.test(target) || target.startsWith('//')) continue;
    const path = decodeURIComponent(target.split(/[?#]/)[0]);
    if (!path) continue;
    links++;
    try { await access(resolve(dirname(file), path)); }
    catch { failures.push(`${relative(root, file)} → ${target}`); }
  }
}
if (failures.length) {
  console.error(`Unresolved local documentation links:\n${failures.join('\n')}`);
  process.exitCode = 1;
} else console.log(`Documentation links passed: ${files.length} Markdown files, ${links} local targets.`);
