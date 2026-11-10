import ignore from 'ignore';
import {lstat,readFile} from 'node:fs/promises';
import {agents} from '../integrations/agents/index.js';
import {openspec} from '../integrations/sdd/openspec.js';
import {specKit} from '../integrations/sdd/spec-kit.js';
import {digest,safePath} from './evidence.js';

const maxIgnoreBytes=64_000;
const controlFile='.rigupignore';
const ignoreOptions={ignorecase:process.platform==='win32'};
const specKitRoot='/'+specKit.artifacts[0]+'/';
const specKitSnapshotPaths=['scripts/','templates/','extensions/','presets/'].map(path=>specKitRoot+path);
const specKitResearchPaths=[
 'workflows/',
 'integrations/*.manifest.json','integrations/packages/','integrations/packages.json',
 '.gitignore','feature.json','init-options.json','integration.json','bundle-records.json',
 'memory/.constitution-template.json',
].map(path=>specKitRoot+path);
const snapshotPaths=[
 '/'+openspec.artifacts[1]+'/',
 ...specKitSnapshotPaths,
 '/.claude/commands/opsx/',
];
const generated={
 all:ignore(ignoreOptions).add([...snapshotPaths,...specKitResearchPaths]),
 'spec-kit':ignore(ignoreOptions).add([...specKitSnapshotPaths,...specKitResearchPaths]),
 installation:ignore(ignoreOptions).add(snapshotPaths),
};
const skillDirectories=Object.values(agents).map(agent=>agent.skillDirectory);
const workflowPrefix=/^(?:openspec-|speckit[.-])/;
const specKitPrefix=/^speckit[.-]/;

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

export function workflowEvidenceKind(path:string,directory:boolean,scope:keyof typeof generated):'entry'|'generated'|undefined{
 if(generated[scope].ignores(path+(directory?'/':'')))return 'generated';
 const prefix=scope==='spec-kit'?specKitPrefix:workflowPrefix;
 for(const parent of skillDirectories){
  if(!path.startsWith(parent+'/'))continue;
  const [name,...inside]=path.slice(parent.length+1).split('/');
  if(!prefix.test(name)||!inside.length)continue;
  return !directory&&inside.length===1&&inside[0]==='SKILL.md'?'entry':'generated';
 }
 if(!directory){
  const command=/^(?:\.claude|\.opencode|\.omp)\/commands\/([^/]+)\.md$/.exec(path)?.[1];
  const match=command&&prefix.exec(command);
  if(match&&command.length>match[0].length)return 'entry';
 }
}
