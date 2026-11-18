import {claude} from './claude.js';
import {codex} from './codex.js';
import {opencode} from './opencode.js';
import {omp} from './omp.js';
export const agents={claude,codex,opencode,omp};
export const entryOwnership={kind:'block' as const,start:'<!-- rigup:start -->',end:'<!-- rigup:end -->'};

export const projectCommandRoots={claude:['.claude/commands'],codex:[],opencode:['.opencode/command','.opencode/commands'],omp:['.omp/commands']} as const;
