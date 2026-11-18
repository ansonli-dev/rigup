import {isDeepStrictEqual} from 'node:util';
import {parse as parseToml} from 'smol-toml';
import type {Agent} from '../types.js';
import {isRecord} from '../private-record.js';
import {agents,entryOwnership} from '../integrations/agents/index.js';
import {prepareRigupResearchMcp,rigupLauncherTarget,rigupLauncherTemplate} from '../integrations/agents/rigup-config.js';
import {localIgnoreOwnership} from '../integrations/sdd/openspec-project.js';
import {readFileState} from './file-state.js';
import {equalOwnedContent,ownedContent} from './ownership.js';

export type ProjectSetupInspection=
 | {kind:'uninitialized'}
 | {kind:'ambiguous';paths:string[]}
 | {kind:'incomplete';agents:Agent[];paths:string[]}
 | {kind:'claimable';agents:Agent[];launcherVersion:string};

const normalize=(text:string)=>text.replaceAll('\r\n','\n');

async function inspectLauncher(text:string|undefined):Promise<string|undefined>{
 if(text===undefined)return;
 const normalized=normalize(text);
 const found=/^const requiredVersion='(\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?)';$/m.exec(normalized);
 if(found&&normalized.replace(found[0],"const requiredVersion='__RIGUP_VERSION__';")===normalize(await rigupLauncherTemplate()))return found[1];
}

async function targetText(root:string,target:string){
 try{return {text:(await readFileState(root,target)).bytes?.toString('utf8')};}
 catch{return {unsafe:true as const};}
}

function codexService(text:string){
 const {mcp_servers:servers}=parseToml(text);
 return isRecord(servers)?servers.rigup:undefined;
}

async function inspectBlock(root:string,target:string,ownership:typeof entryOwnership|typeof localIgnoreOwnership){
 const {text,unsafe}=await targetText(root,target);
 try{
  const block=ownedContent(text,ownership);
  const lines=text?.split(/\r?\n/)??[];
  const complete=lines.includes(ownership.start)&&lines.includes(ownership.end);
  return {target,marked:block!==undefined,unsafe:!!unsafe||block!==undefined&&!complete};
 }
 catch{return {target,marked:true,unsafe:true};}
}

export async function inspectProjectSetup(root:string):Promise<ProjectSetupInspection>{
 const hosts=Object.keys(agents) as Agent[];
 const [launcher,ignore,entries,bindings]=await Promise.all([
  targetText(root,rigupLauncherTarget),
  inspectBlock(root,'.rigup/.gitignore',localIgnoreOwnership),
  Promise.all([...new Set(hosts.map(host=>agents[host].entry))].map(target=>inspectBlock(root,target,entryOwnership))),
  Promise.all(hosts.map(async agent=>{
   const expected=await prepareRigupResearchMcp(root,agent);
   const {text,unsafe}=await targetText(root,expected.target);
   try{
    const value=ownedContent(text,expected.ownership);
    const matchesSelector=value!==undefined&&equalOwnedContent(expected.ownership,value,expected.content);
    // TOML subtables can extend the active service beyond the bounded ownership range.
    const match=matchesSelector&&(agent!=='codex'||isDeepStrictEqual(codexService(text!),codexService(expected.content)));
    return {agent,target:expected.target,match,related:!!value?.includes(rigupLauncherTarget),unsafe:!!unsafe};
   }catch{return {agent,target:expected.target,match:false,related:!!text?.includes(rigupLauncherTarget),unsafe:true};}
  })),
 ]);
 const selected=bindings.filter(binding=>binding.match).map(binding=>binding.agent);
 const marked=[ignore,...entries].filter(block=>block.marked).map(block=>block.target);
 const launcherPresent=launcher.text!==undefined||launcher.unsafe;
 if(!marked.length&&!launcherPresent&&!selected.length)return {kind:'uninitialized'};
 const broken=bindings.filter(({agent,match,related,unsafe})=>!match&&
  (related||unsafe&&(marked.includes(agents[agent].entry)||!selected.length&&launcherPresent))).map(binding=>binding.target);
 if(!launcherPresent&&!selected.length&&!broken.length)return {kind:'ambiguous',paths:marked};
 const version=await inspectLauncher(launcher.text);
 if(!version)broken.push(rigupLauncherTarget);
 if(ignore.unsafe)broken.push(ignore.target);
 for(const agent of selected){
  const entry=entries.find(block=>block.target===agents[agent].entry);
  if(!entry?.marked||entry.unsafe)broken.push(agents[agent].entry);
 }
 if(!selected.length&&!broken.length)broken.push(...bindings.filter(binding=>marked.includes(agents[binding.agent].entry)).map(binding=>binding.target));
 if(broken.length||!version||!selected.length)return {kind:'incomplete',agents:selected,paths:[...new Set(broken.length?broken:[rigupLauncherTarget])]};
 return {kind:'claimable',agents:selected,launcherVersion:version};
}
