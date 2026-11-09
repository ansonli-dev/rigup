import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {casesFor} from './cases.mjs';

const [taskId, checkpoint] = process.argv.slice(2);
const load = path => import(pathToFileURL(join(process.cwd(), 'src', path)).href);
const failedCaseIds = [];

for (const [id, check] of Object.entries(casesFor(taskId, checkpoint))) {
  try {
    await check(load);
  } catch {
    // Broken or missing candidate modules fail the checks that exercise them.
    failedCaseIds.push(id);
  }
}

process.stdout.write(`\nRIGUP_HIDDEN_RESULT ${JSON.stringify(failedCaseIds)}\n`);
