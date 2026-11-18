import {execFile} from 'node:child_process';
import {lstat} from 'node:fs/promises';
import {promisify} from 'node:util';
import {digest} from '../analyzer/evidence.js';
import {PROMPT_VERSION} from '../analyzer/prompts.js';
import {READ_POLICY_VERSION} from '../analyzer/read-policy.js';
import {scanInstallationSources} from '../analyzer/repository.js';
import {DOCUMENT_POLICY_VERSION} from '../generator/document-policy.js';
import {renderFixed,TEMPLATE_VERSION} from '../generator/render.js';
import {equalTomlValue} from '../integrations/agents/config-edit.js';
import {rigupLauncherTarget,rigupLauncherTemplate} from '../integrations/agents/rigup-config.js';
import {prepareIntegrations,type PreparedAsset} from '../integrations/registry.js';
import {essentialEnvironment,hasGitMetadata} from '../runtime-private-env.js';
import type {SetupOptions,SetupPlan} from '../types.js';
import {RIGUP_VERSION} from '../version.js';
import {readFileState} from './file-state.js';
import {equalOwnedContent,ownedContent,targetPath} from './ownership.js';
import {inspectProjectSetup} from './project-setup.js';

const git=promisify(execFile);

export async function assertClaimStorage(root:string):Promise<void>{
 const baseline=await targetPath(root,'.rigup/baseline');
 const info=await lstat(baseline).catch(error=>{if(error.code!=='ENOENT')throw error;});
 if(info&&!info.isDirectory())throw Error('.rigup/baseline must be a local directory');
 if(!await hasGitMetadata(root))return;
 const options={env:essentialEnvironment(),timeout:5000,maxBuffer:256_000};
 for(const target of ['.rigup/manifest.json','.rigup/baseline/']){
  const path=target.replace(/\/$/,'');
  try{
   const {stdout}=await git('git',['-C',root,'ls-files','-z','--',':(icase,literal)'+path],options);
   if(stdout)throw Error('Tracked installation records');
   await git('git',['-C',root,'check-ignore','--quiet','--no-index','--',target],options);
  }catch{throw Error(target+' must be ignored by Git and untracked before claiming this project');}
 }
}

export async function checkClaimSelection(root:string,plan:SetupPlan):Promise<void>{
 const setup=await inspectProjectSetup(root);
 if(setup.kind!=='claimable'||setup.launcherVersion!==plan.claim?.launcherVersion||
    [...setup.agents].sort().join()!==[...plan.options.agents].sort().join()){
  const paths='paths' in setup?' ('+setup.paths.join(', ')+')':'';
  throw Error('Rigup project bindings changed. Review the existing configuration again'+paths);
 }
}

export async function prepareClaimPlan(root:string,options:SetupOptions,configDigests?:Record<string,string>):Promise<SetupPlan>{
 options={...options,agents:[...new Set(options.agents)]};
 const setup=await inspectProjectSetup(root);
 if(setup.kind!=='claimable'||[...setup.agents].sort().join()!==[...options.agents].sort().join()){
  throw Error('Rigup project bindings changed. Review the existing configuration again');
 }
 const projectRules=options.projectRules??true;
 options={...options,projectRules};
 const inventoryOptions={...options,projectRules:true,tools:undefined};
 const profile=await scanInstallationSources(root,inventoryOptions,[]);
 const integration=await prepareIntegrations(profile,inventoryOptions,undefined,'claim');
 const candidates=await renderFixed(profile,inventoryOptions,integration,[],[]);
 const assets:PreparedAsset[]=[];
 const warnings=[...new Set(integration.warnings)];
 if(options.tools?.length)warnings.push('Review selected tools separately to verify their local installation.');
 const launcher=(await rigupLauncherTemplate()).replace('__RIGUP_VERSION__',setup.launcherVersion);
 for(const candidate of candidates){
  const state=await readFileState(root,candidate.target);
  const binary=candidate.encoding==='base64';
  const text=state.bytes?.toString(binary?'base64':'utf8');
  const selector=candidate.ownership;
  const content=ownedContent(text,selector);
  const marked=candidate.logicalId==='rigup:local-state-ignore'||candidate.logicalId.startsWith('entry:');
  const expected=candidate.target===rigupLauncherTarget?launcher:candidate.content;
  const matches=content!==undefined&&(marked||(binary?content===expected:equalOwnedContent(selector,content,expected)))&&
   (selector.kind!=='toml-table'||equalTomlValue(text!,expected,selector.path));
  if(!matches){
   if(candidate.target===rigupLauncherTarget||candidate.logicalId.startsWith('entry:')||candidate.logicalId.startsWith('mcp:')&&candidate.source.ref==='rigup'){
    throw Error(candidate.target+': required Rigup configuration changed while preparing the claim');
   }
   warnings.push(candidate.target+': Existing managed content could not be verified. Review it separately.');
   continue;
  }
  const source=marked||candidate.target===rigupLauncherTarget?{...candidate.source,digest:digest(content)}:candidate.source;
  assets.push({...candidate,source,content,...(candidate.mode===undefined?{}:{mode:state.mode})});
 }
 const claim={launcherVersion:setup.launcherVersion,...(configDigests?{configDigests}:{})};
 return {root,options,claim,fingerprint:profile.fingerprint,assets,operations:[],dispositions:[],warnings,requirements:[],
  versions:{rigup:RIGUP_VERSION,prompt:PROMPT_VERSION,template:TEMPLATE_VERSION,document:DOCUMENT_POLICY_VERSION,read:READ_POLICY_VERSION},
  ...(projectRules?{projectRules:'pending'}:{})};
}
