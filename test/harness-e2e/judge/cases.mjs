import {orderCases} from './order-cases.mjs';
import {storeCases} from './store-cases.mjs';

const cases = {...orderCases, ...storeCases};

export function casesFor(taskId, checkpoint) {
  if (!Object.hasOwn(cases, taskId) || !Object.hasOwn(cases[taskId], checkpoint)) {
    throw new Error(`Unknown harness checkpoint ${taskId}/${checkpoint}`);
  }
  return cases[taskId][checkpoint];
}
