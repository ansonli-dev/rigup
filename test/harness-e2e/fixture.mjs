import {copyFile, cp, mkdir, readdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {catalog} from './fixtures/store-expansion/catalog.mjs';
import {inventory} from './fixtures/store-expansion/inventory.mjs';
import {pricing} from './fixtures/store-expansion/pricing.mjs';
import {getTask} from './tasks.mjs';

async function expandStoreFixture(root) {
  await Promise.all(Object.entries({catalog, inventory, pricing}).map(async ([module, operations]) => {
    const imports = ["import assert from 'node:assert/strict';", "import test from 'node:test';"];
    const tests = [];
    const writes = [];
    for (const [file, [operation, source, assertions]] of Object.entries(operations)) {
      writes.push(writeFile(join(root, 'src', module, `${file}.js`), source.trimStart()));
      imports.push(`import {${operation}} from '../src/${module}/${file}.js';`);
      tests.push(`test('${operation}', () => {${assertions}});`);
    }
    const testSource = imports.join('\n') + '\n\n' + tests.join('\n\n') + '\n';
    writes.push(writeFile(join(root, 'test', `${module}-operations.test.js`), testSource));
    await Promise.all(writes);
  }));
}

export async function writeFixture(root, taskId) {
  const task = getTask(taskId);
  await mkdir(root, {recursive: true});
  if ((await readdir(root)).length) throw new Error(`Harness workspace must be empty: ${root}`);
  await cp(fileURLToPath(new URL(`./fixtures/${task.fixture}/`, import.meta.url)), root, {recursive: true});
  if (task.fixture === 'store-service') await expandStoreFixture(root);
  if (task.id === 'T4') {
    const adrDir = join(root, 'docs', 'adr');
    await mkdir(adrDir, {recursive: true});
    const name = '0007-outbound-event-envelope.md';
    await copyFile(new URL(`./fixtures/warehouse/${name}`, import.meta.url), join(adrDir, name));
  }
}
