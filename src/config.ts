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

export function validateOptions(value: Record<string, unknown>): void {
  for (const key of Object.keys(value)) {
    if (!['agents','backend','profile','templates','mcp','readBudget','scope','model','sdd','tools','customSkills','projectConventions'].includes(key)) throw new Error(key + ': unknown field');
  }
  if(value.sdd !== undefined && !['superpowers','openspec','spec-kit'].includes(String(value.sdd))) throw new Error('sdd: unsupported selection');
  if(value.tools !== undefined) {
   if(!Array.isArray(value.tools)) throw new Error('tools: expected list');
   for(const [i,tool] of value.tools.entries()) {
    if(!tool || typeof tool !== 'object' || !['openwiki','codegraph'].includes(tool.id)) throw new Error('tools.'+i+'.id: unsupported');
    if(typeof tool.install !== 'boolean' || typeof tool.initialize !== 'boolean') throw new Error('tools.'+i+': explicit install/initialize booleans required');
    if(!Array.isArray(tool.agents) || tool.agents.some((a:unknown)=>!['claude','codex','opencode','omp'].includes(String(a)))) throw new Error('tools.'+i+'.agents: invalid');
   }
  }
  if(value.customSkills !== undefined) {
   if(!Array.isArray(value.customSkills)) throw new Error('customSkills: expected list');
   for(const [i,skill] of value.customSkills.entries()) {
    if(!skill || typeof skill.source !== 'string' || !skill.source) throw new Error('customSkills.'+i+'.source: required');
    if(skill.position !== undefined && !['prepare','deliver','release'].includes(skill.position)) throw new Error('customSkills.'+i+'.position: invalid');
   }
  }
  if(value.projectConventions !== undefined) {
   const c=value.projectConventions;
   if(!c || typeof c !== 'object' || Array.isArray(c)) throw new Error('projectConventions: expected object');
   for(const key of Object.keys(c)) if(!['tracker','documentRoutes','labelMapping'].includes(key)) throw new Error('projectConventions.'+key+': unknown field');
   const record=c as Record<string,unknown>;
   if(record.tracker !== undefined) {
    const tracker=record.tracker as Record<string,unknown>;
    if(!tracker || typeof tracker !== 'object' || !['gitlab','github','local','other'].includes(String(tracker.system))) throw new Error('projectConventions.tracker.system: invalid');
    for(const key of Object.keys(tracker)) if(!['system','reference','description'].includes(key) || typeof tracker[key] !== 'string') throw new Error('projectConventions.tracker.'+key+': invalid');
   }
   for(const key of ['documentRoutes','labelMapping']) if(record[key] !== undefined && (!record[key] || typeof record[key] !== 'object' || Array.isArray(record[key]) || Object.values(record[key]).some(v=>typeof v !== 'string'))) throw new Error('projectConventions.'+key+': expected string mapping');
  }
  if(value.model !== undefined) {
   if(!value.model || typeof value.model !== 'object' || Array.isArray(value.model)) throw new Error('model: expected object');
   const model=value.model as Record<string,unknown>;
   for(const field of Object.keys(model)) if(!['provider','model','apiKeyEnv'].includes(field)) throw new Error('model.'+field+': unknown field');
   if(model.provider !== 'anthropic') throw new Error('model.provider: expected anthropic');
   if(typeof model.model !== 'string' || !model.model.trim()) throw new Error('model.model: required');
   if(typeof model.apiKeyEnv !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(model.apiKeyEnv)) throw new Error('model.apiKeyEnv: environment reference required');
  }
  if(value.scope !== undefined && (!Array.isArray(value.scope) || value.scope.some(s=>typeof s !== 'string' || s.startsWith('/') || s.split('/').includes('..')))) throw new Error('scope: expected relative paths');
  if(value.readBudget !== undefined) {
   if(!value.readBudget || typeof value.readBudget !== 'object' || Array.isArray(value.readBudget)) throw new Error('readBudget: expected object');
   for(const field of ['maxFiles','maxBytes']) {
    const n=(value.readBudget as Record<string,unknown>)[field];
    if(typeof n !== 'number' || !Number.isSafeInteger(n) || n<1) throw new Error('readBudget.'+field+': expected positive integer');
   }
  }
  for(const key of ['templates','mcp']) {
    if(value[key] === undefined) continue;
    if(!Array.isArray(value[key])) throw new Error(key+': expected list');
    for(const [index,item] of (value[key] as unknown[]).entries()) {
      const field=key+'.'+index;
      if(!item || typeof item !== 'object') throw new Error(field+': expected object');
      const v=item as Record<string,unknown>;
      const allowed=key === 'templates' ? ['source','target','values'] : ['id','agents','url','command','envRefs'];
      for(const name of Object.keys(v)) if(!allowed.includes(name)) throw new Error(field+'.'+name+': unknown field');
      if(key === 'templates' && v.values !== undefined) {
       if(!v.values || typeof v.values !== 'object' || Array.isArray(v.values)) throw new Error(field+'.values: scalar mapping required');
       for(const [name,entry] of Object.entries(v.values)) {
        if(!['string','number','boolean'].includes(typeof entry) || typeof entry === 'number' && !Number.isFinite(entry)) throw new Error(field+'.values.'+name+': scalar required');
        if(/token|password|secret|authorization|api[-_]?key/i.test(name) && !(typeof entry === 'string' && /^\$\{[A-Z_][A-Z0-9_]*\}$/.test(entry))) throw new Error(field+'.values.'+name+': credential value forbidden; use an environment reference');
       }
      }
      const required=key === 'templates'  ? ['source','target'] : ['id'];
      for(const name of required) if(typeof v[name] !== 'string' || !v[name]) throw new Error(field+'.'+name+': required');
      if(key === 'mcp') {
        if(!Array.isArray(v.agents) || !v.agents.length || v.agents.some(a=>!['claude','codex','opencode','omp'].includes(a))) throw new Error(field+'.agents: required');
        if((v.url === undefined) === (v.command === undefined)) throw new Error(field+': choose url or command');
        if(v.url !== undefined) {
         let url:URL;try {url=new URL(String(v.url));} catch {throw new Error(field+'.url: invalid');}
         if(!['http:','https:'].includes(url.protocol)||url.username||url.password||[...url.searchParams.keys()].some(k=>/token|password|secret|auth|key/i.test(k))) throw new Error(field+'.url: credential values or unsupported transport');
        }
        if(v.command !== undefined) {
         const command=v.command as Record<string,unknown>;
         if(!command || typeof command !== 'object' || Array.isArray(command)) throw new Error(field+'.command: expected object');
         for(const name of Object.keys(command)) if(!['executable','args','cwd','envRefs'].includes(name)) throw new Error(field+'.command.'+name+': unknown field');
         if(typeof command.executable !== 'string' || !command.executable || typeof command.cwd !== 'string' || !Array.isArray(command.args) || command.args.some(a=>typeof a !== 'string')) throw new Error(field+'.command: executable/args/cwd required');
         for(const [argIndex,arg] of (command.args as string[]).entries()) {
          const credentialFlag=/^--?(?:token|password|secret|api[-_]?key|authorization)(?:=|$)/i;
          if(credentialFlag.test(arg)) {
           const credential=arg.includes('=') ? arg.slice(arg.indexOf('=')+1) : (command.args as string[])[argIndex+1];
           if(typeof credential !== 'string' || !/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(credential)) throw new Error(field+'.command.args: credential values forbidden; use declared environment references');
          }
          if(/^https?:\/\//i.test(arg)) {const url=new URL(arg);if(url.username||url.password||[...url.searchParams.keys()].some(k=>/token|password|secret|auth|key/i.test(k))) throw new Error(field+'.command.args: credential URL forbidden');}
         }
         if(!Array.isArray(command.envRefs) || command.envRefs.some(r=>typeof r !== 'string'||!/^[A-Za-z_][A-Za-z0-9_]*$/.test(r))) throw new Error(field+'.command.envRefs: invalid');
        }
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
  validateOptions(project); validateOptions(overrides);
  const profilePath = overrides.profile ?? project.profile;
  const profile = typeof profilePath === 'string' ? await readConfig(join(root,profilePath), true) : {};
  validateOptions(profile);
  return {...{agents: [], backend:'native'}, ...profile, ...project, ...overrides} as SetupOptions;
}
