import {readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {parse} from 'yaml';
import type {SetupOptions} from './types.js';
import {isCheckSelector} from './integrations/tools/check-catalog.js';

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
  let value:unknown;try{value=parse(source);}catch{throw new Error('config: invalid YAML syntax');}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('config: expected mapping');
  return value as Record<string, unknown>;
}

export function normalizeDocumentLanguage(value: unknown): string {
  if (value === 'auto') return value;
  if (typeof value === 'string' && /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/i.test(value) && value.length <= 64) {
    try { return Intl.getCanonicalLocales(value)[0]; } catch { /* Report the field below. */ }
  }
  throw new Error('documentLanguage: use auto or a BCP 47 language tag such as zh-CN or en');
}

export function validateOptions(value: Record<string, unknown>): void {
  for (const key of Object.keys(value)) {
    if (!['agents','backend','documentLanguage','quality','customer','executionPolicy','profile','templates','mcp','readBudget','researchBudget','scope','model','sdd','tools','customSkills','projectConventions'].includes(key)) throw new Error(key + ': unknown field');
  }
  if (value.documentLanguage !== undefined) normalizeDocumentLanguage(value.documentLanguage);
  if(value.executionPolicy!==undefined){const p=value.executionPolicy as Record<string,unknown>;if(!p||typeof p!=='object'||Object.keys(p).some(k=>k!=='mode')||!['continuous','review'].includes(String(p.mode)))throw new Error('executionPolicy.mode: continuous or review required');}
  if(value.quality!==undefined){
   const q=value.quality as Record<string,unknown>;if(!q||typeof q!=='object'||Array.isArray(q))throw new Error('quality: expected object');
   for(const key of Object.keys(q))if(!['preCommit','prePush','maxPushCommits','gitlab'].includes(key))throw new Error('quality.'+key+': unknown field');
   for(const key of ['preCommit','prePush'])if(q[key]!==undefined&&(!Array.isArray(q[key])||(q[key] as unknown[]).some(k=>!isCheckSelector(k))))throw new Error('quality.'+key+': existing check kinds or {cwd, script} required');
   if(q.maxPushCommits!==undefined&&(!Number.isSafeInteger(q.maxPushCommits)||Number(q.maxPushCommits)<1))throw new Error('quality.maxPushCommits: positive integer required');
   if(q.gitlab!==undefined){const g=q.gitlab as Record<string,unknown>;if(!g||typeof g!=='object'||Array.isArray(g)||Object.keys(g).some(k=>!['checks','reportPaths','openwiki'].includes(k))||!Array.isArray(g.checks)||g.checks.some(k=>!isCheckSelector(k)))throw new Error('quality.gitlab: invalid selection');
    if(g.reportPaths!==undefined&&(!Array.isArray(g.reportPaths)||g.reportPaths.some(p=>typeof p!=='string'||p.startsWith('/')||p.split('/').includes('..')||p.includes('\\')||/[?*]/.test(p))))throw new Error('quality.gitlab.reportPaths: exact relative report paths required');
    if(g.openwiki!==undefined){const w=g.openwiki as Record<string,unknown>;if(!w||typeof w!=='object'||Object.keys(w).some(k=>!['envRefs','sourcePaths'].includes(k))||!Array.isArray(w.envRefs)||w.envRefs.some(v=>typeof v!=='string'||!/^[A-Z_][A-Z0-9_]*$/.test(v))||!Array.isArray(w.sourcePaths)||!w.sourcePaths.length||w.sourcePaths.some(p=>typeof p!=='string'||p.startsWith('/')||p.split('/').includes('..')||p.startsWith('openwiki/')||p==='**/*'))throw new Error('quality.gitlab.openwiki: explicit environment references and source-only paths required');}
   }
  }
  if(value.customer!==undefined){
   const c=value.customer as Record<string,unknown>;if(!c||typeof c!=='object'||Array.isArray(c)||Object.keys(c).some(k=>!['commands','envRefs','deployment'].includes(k)))throw new Error('customer: invalid configuration');
   if(c.envRefs!==undefined&&(!Array.isArray(c.envRefs)||c.envRefs.some(v=>typeof v!=='string'||!/^[A-Z_][A-Z0-9_]*$/.test(v))))throw new Error('customer.envRefs: reference names required');
   if(c.commands!==undefined){if(!c.commands||typeof c.commands!=='object'||Array.isArray(c.commands))throw new Error('customer.commands: expected map');for(const [name,command] of Object.entries(c.commands)){if(!['issue','mr','ci','deploy','rollback','feedback','environment'].includes(name))throw new Error('customer.commands: unsupported runtime capability');validateOptions({mcp:[{id:'customer-'+name,agents:['codex'],command}]});}}
   if(c.deployment!==undefined){const d=c.deployment as Record<string,unknown>;if(!d||typeof d!=='object'||Object.keys(d).some(k=>!['adapter','target','authorizationReference','recoveryRunbook'].includes(k))||['adapter','target','authorizationReference','recoveryRunbook'].some(k=>typeof d[k]!=='string'||!d[k]))throw new Error('customer.deployment: target, authorization and recovery reference required');}
  }
  if(value.researchBudget!==undefined){const b=value.researchBudget as Record<string,unknown>;if(!b||typeof b!=='object'||Object.keys(b).some(k=>!['maxCalls','maxTokens'].includes(k))||['maxCalls','maxTokens'].some(k=>!Number.isSafeInteger(b[k])||Number(b[k])<1))throw new Error('researchBudget: positive maxCalls/maxTokens required');}
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
  if(value.backend==='codex'&&value.model!==undefined)throw Error('model: Anthropic configuration conflicts with the Codex backend');
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
         if(!['http:','https:'].includes(url.protocol)||url.username||url.password||[...url.searchParams.keys()].some(k=>/token|password|secret|auth|key|cookies?/i.test(k))) throw new Error(field+'.url: credential values or unsupported transport');
        }
        if(v.command !== undefined) {
         const command=v.command as Record<string,unknown>;
         if(!command || typeof command !== 'object' || Array.isArray(command)) throw new Error(field+'.command: expected object');
         for(const name of Object.keys(command)) if(!['executable','args','cwd','envRefs'].includes(name)) throw new Error(field+'.command.'+name+': unknown field');
         if(typeof command.executable !== 'string' || !command.executable || typeof command.cwd !== 'string' || !Array.isArray(command.args) || command.args.some(a=>typeof a !== 'string')) throw new Error(field+'.command: executable/args/cwd required');
         for(const [argIndex,arg] of (command.args as string[]).entries()) {
          const credentialFlag=/^--?(?:(?:(?:access|private|job|refresh|auth)[-_]?)?token|password|passwd|secret|client[-_]?secret|api[-_]?key|authorization|auth|user|u|proxy-user|oauth2-bearer|cookies?|credentials?)(?:=|$)/i;
          const executableName=command.executable.split(/[\\/]/).at(-1)!.replace(/\.exe$/i,'').toLowerCase();
          const interpreterFlag=/^(?:python|pypy)(?:\d+(?:\.\d+)*)?$/.test(executableName)&&/^-[ub]$/.test(arg)&&(command.args as string[]).slice(0,argIndex).every(prior=>prior.startsWith('-')&&!['-c','-m','--'].includes(prior));
          const curlShort=executableName==='curl'?arg.match(/^-[ub](.*)$/):null;
          if(credentialFlag.test(arg)&&!interpreterFlag||curlShort) {
           const credential=curlShort?.[1] ? curlShort[1].replace(/^=/,'') : arg.includes('=') ? arg.slice(arg.indexOf('=')+1) : (command.args as string[])[argIndex+1];
           if(typeof credential !== 'string' || !/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(credential)) throw new Error(field+'.command.args: credential values forbidden; use declared environment references');
          }
          const header=arg.match(/(?:authorization|proxy-authorization|cookies?|set[-_]?cookie|(?:[A-Za-z0-9_-]*[-_])?(?:api[-_]?key|token))\s*[:=]\s*(?:Bearer\s+|Basic\s+)?(.+)$/i);
          if(header&&!/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(header[1]))throw new Error(field+'.command.args: literal header credential forbidden; use an environment reference');
          for(const ref of arg.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g))if(![...(Array.isArray(command.envRefs)?command.envRefs:[]),...(Array.isArray(v.envRefs)?v.envRefs:[])].includes(ref[1]))throw new Error(field+'.command.args: undeclared environment reference');
          if(/^https?:\/\//i.test(arg)) {const url=new URL(arg);if(url.username||url.password||[...url.searchParams.keys()].some(k=>/token|password|secret|auth|key|cookies?/i.test(k))) throw new Error(field+'.command.args: credential URL forbidden');}
         }
         if(!Array.isArray(command.envRefs) || command.envRefs.some(r=>typeof r !== 'string'||!/^[A-Za-z_][A-Za-z0-9_]*$/.test(r))) throw new Error(field+'.command.envRefs: invalid');
        }
        if(v.envRefs !== undefined && (!Array.isArray(v.envRefs) || v.envRefs.some(r=>typeof r !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(r)))) throw new Error(field+'.envRefs: invalid');
      }
    }
  }
  if (value.agents !== undefined && (!Array.isArray(value.agents) ||
    value.agents.some(a => !['claude','codex','opencode','omp'].includes(a)))) throw new Error('agents: expected supported agent list');
  if (value.backend !== undefined && !['codex','native','host'].includes(String(value.backend))) throw new Error('backend: expected codex, native or host');
  if (value.profile !== undefined && typeof value.profile !== 'string') throw new Error('profile: expected path');
}

export async function loadOptions(root: string, overrides: Partial<SetupOptions>, approvedOptions?: SetupOptions): Promise<SetupOptions> {
  const project = approvedOptions ? {...approvedOptions} : await readConfig(join(root,'.rigup','config.yaml'));
  validateOptions(project); validateOptions(overrides);
  const profilePath = approvedOptions ? undefined : overrides.profile ?? project.profile;
  const profile = typeof profilePath === 'string' ? await readConfig(resolve(root,profilePath), true) : {};
  validateOptions(profile);
  const options={...{agents: ['codex'], backend:'codex'}, ...profile, ...project, ...overrides} as SetupOptions;
  if (options.documentLanguage !== undefined) options.documentLanguage = normalizeDocumentLanguage(options.documentLanguage);
  const layers=[profile,project,overrides];const backendLayer=layers.findLastIndex(layer=>layer.backend!==undefined),modelLayer=layers.findLastIndex(layer=>layer.model!==undefined);
  if(options.model&&modelLayer>backendLayer)options.backend='native';
  else if(options.backend==='codex'&&options.model)delete options.model;
  validateOptions(options as unknown as Record<string,unknown>);
  return options;
}

export async function configurationCandidate(root:string,options:SetupOptions):Promise<import('./integrations/registry.js').PreparedAsset>{
 const {parseDocument}=await import('yaml');let source='';try{source=await readFile(join(root,'.rigup/config.yaml'),'utf8');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 const doc=parseDocument(source);if(doc.errors.length)throw new Error('config: invalid YAML syntax');const previous=doc.toJS()??{};
 for(const key of Object.keys(previous))if(!(key in options))doc.delete(key);
 for(const [key,value] of Object.entries(options))if(value!==undefined&&JSON.stringify(previous[key])!==JSON.stringify(value))doc.set(key,value);
 return {logicalId:'rigup:configuration',target:'.rigup/config.yaml',content:doc.toString(),ownership:{kind:'file'},source:{kind:'configuration',ref:'1'}};
}
