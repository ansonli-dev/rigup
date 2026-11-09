import ignore from 'ignore';
import {lstat,readFile} from 'node:fs/promises';
import {agents} from '../integrations/agents/index.js';
import {openspec} from '../integrations/sdd/openspec.js';
import {specKit} from '../integrations/sdd/spec-kit.js';
import {digest,safePath} from './evidence.js';

const maxIgnoreBytes=64_000;
const controlFile='.rigupignore';
const generated=ignore({ignorecase:process.platform==='win32'}).add([
 '/'+openspec.artifacts[1]+'/',
 ...['scripts','templates','extensions','presets'].map(name=>'/'+specKit.artifacts[0]+'/'+name+'/'),
 '/.claude/commands/opsx/',
]);
const skillDirectories=Object.values(agents).map(agent=>agent.skillDirectory);
const workflowPrefix=/^(?:openspec-|speckit[.-])/;

export async function loadResearchIgnore(root:string){
 const rules=ignore({ignorecase:process.platform==='win32'});
 let fingerprint:string|undefined;
 try{
  const path=await safePath(root,controlFile);
  const info=await lstat(path);
  if(!info.isFile()||info.size>maxIgnoreBytes)throw Error('.rigupignore must be a regular file under 64 KB');
  const bytes=await readFile(path);
  if(bytes.length>maxIgnoreBytes||bytes.includes(0))throw Error('.rigupignore must be a text file under 64 KB');
  rules.add(bytes.toString('utf8'));
  fingerprint=digest(bytes);
 }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 return {
  fingerprint,
  excludes(path:string,directory:boolean){return path===controlFile||rules.ignores(path+(directory?'/':''));}
 };
}

export function workflowEvidenceKind(path:string,directory:boolean):'entry'|'generated'|undefined{
 if(generated.ignores(path+(directory?'/':'')))return 'generated';
 for(const parent of skillDirectories){
  if(!path.startsWith(parent+'/'))continue;
  const [name,...inside]=path.slice(parent.length+1).split('/');
  if(!workflowPrefix.test(name)||!inside.length)continue;
  return !directory&&inside.length===1&&inside[0]==='SKILL.md'?'entry':'generated';
 }
 if(!directory&&/^(?:\.claude|\.opencode|\.omp)\/commands\/(?:openspec-|speckit[.-])[^/]+\.md$/.test(path))return 'entry';
}
