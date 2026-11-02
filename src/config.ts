import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {parse} from 'yaml';
import type {SetupOptions} from './types.js';

async function readConfig(path: string, required = false): Promise<Record<string, unknown>> {
  let source: string;
  try { source = await readFile(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      if (required) throw new Error('profile: file not found');
      return {};
    }
    throw error;
  }
  const value: unknown = parse(source);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('config: expected mapping');
  return value as Record<string, unknown>;
}

function validate(value: Record<string, unknown>): void {
  for (const key of Object.keys(value)) {
    if (!['agents','backend','profile','templates','mcp'].includes(key)) throw new Error(key + ': unknown field');
  }
  for(const key of ['templates','mcp']) {
    if(value[key] === undefined) continue;
    if(!Array.isArray(value[key])) throw new Error(key+': expected list');
    for(const [index,item] of (value[key] as unknown[]).entries()) {
      const field=key+'.'+index;
      if(!item || typeof item !== 'object') throw new Error(field+': expected object');
      const v=item as Record<string,unknown>;
      const required=key === 'templates' ? ['source','target'] : ['id'];
      for(const name of required) if(typeof v[name] !== 'string' || !v[name]) throw new Error(field+'.'+name+': required');
      if(key === 'mcp') {
        if(!Array.isArray(v.agents) || !v.agents.length || v.agents.some(a=>!['claude','codex','opencode','omp'].includes(a))) throw new Error(field+'.agents: required');
        if((v.url === undefined) === (v.command === undefined)) throw new Error(field+': choose url or command');
        if(v.url !== undefined) {try {new URL(String(v.url));} catch {throw new Error(field+'.url: invalid');}}
        if(v.envRefs !== undefined && (!Array.isArray(v.envRefs) || v.envRefs.some(r=>typeof r !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(r)))) throw new Error(field+'.envRefs: invalid');
      }
    }
  }
  if (value.agents !== undefined && (!Array.isArray(value.agents) ||
    value.agents.some(a => !['claude','codex','opencode','omp'].includes(a)))) throw new Error('agents: expected supported agent list');
  if (value.backend !== undefined && !['native','host'].includes(String(value.backend))) throw new Error('backend: expected native or host');
  if (value.profile !== undefined && typeof value.profile !== 'string') throw new Error('profile: expected path');
}

export async function loadOptions(root: string, overrides: Partial<SetupOptions>): Promise<SetupOptions> {
  const project = await readConfig(join(root,'.rigup','config.yaml'));
  validate(project); validate(overrides);
  const profilePath = overrides.profile ?? project.profile;
  const profile = typeof profilePath === 'string' ? await readConfig(join(root,profilePath), true) : {};
  validate(profile);
  return {...{agents: [], backend:'native'}, ...profile, ...project, ...overrides} as SetupOptions;
}
