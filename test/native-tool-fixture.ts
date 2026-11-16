import {mkdir,mkdtemp,realpath,rm,symlink,writeFile} from 'node:fs/promises';
import {dirname,join,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {softwareInstallRecipe,toolPackage,type NativeTool} from '../src/integrations/tools/recipes.js';
import {inspectProjectToolInstall} from '../src/integrations/tools/software.js';
import type {ToolInstallReceipt} from '../src/integrations/tools/installed-state.js';
import {scanRepository,type ProjectProfile} from '../src/analyzer/repository.js';
import {loadPreview,preview} from '../src/installer/preview.js';
import type {SetupOperation,SetupOptions} from '../src/types.js';
import {loadUpstreamLock,prepareIntegrations,prepareProjectToolOperations} from '../src/integrations/registry.js';
import type {NpmView} from '../src/integrations/tools/npm-resolution.js';

export const fixedNpmView:NpmView=async args=>{
 const name=args[1].slice(0,-'@latest'.length);
 const id=name==='@colbymchenry/codegraph'?'codegraph':name==='@fission-ai/openspec'?'openspec':name;
 const pin=(await loadUpstreamLock()).find(entry=>entry.integrationId===id);
 if(!pin?.packageIntegrity)throw Error('Missing test package identity for '+name);
 return JSON.stringify({name,version:pin.version,'dist-tags.latest':pin.version,'dist.integrity':pin.packageIntegrity});
};

export async function prepareSoftwareInstall(root:string,id:NativeTool,version:string,integrity?:string,receipt?:ToolInstallReceipt){
 const local=await inspectProjectToolInstall(root,id,receipt);
 if('pending' in local)return local;
 if('identity' in local)return {reused:true as const,version:local.identity.version};
 return softwareInstallRecipe(local.root,id,version,integrity);
}

export async function prepareToolFixture(profile:ProjectProfile,options:SetupOptions,view:NpmView|null=fixedNpmView){
 const stateRoot=await realpath(await mkdtemp(join(tmpdir(),'rigup-tool-fixture-')));
 try{
  const assembly=await prepareIntegrations(profile,options);
  const plan=await prepareProjectToolOperations({...assembly,root:profile.root,options,fingerprint:profile.fingerprint,dispositions:[],versions:{}},profile,{stateRoot,view:view??undefined});
  return {...assembly,operations:plan.operations,warnings:plan.warnings,requirements:plan.requirements};
 }finally{await rm(stateRoot,{recursive:true,force:true});}
}

export async function saveNativeOperations(root:string,cacheRoot:string,operations:SetupOperation[]){
 const options:SetupOptions={agents:[],backend:'host'};
 const {fingerprint}=await scanRepository(root,options);
 const review=await preview({root,fingerprint,options,operations,assets:[],dispositions:[],warnings:[],requirements:[],versions:{}},[],{cacheRoot,stateRoot:cacheRoot});
 return loadPreview(review.previewId,cacheRoot);
}

export async function writeNativeToolFixture(root:string,id:NativeTool,version:string,type:'commonjs'|'module'='commonjs',target=toolPackage(id).prefix){
 const {name,entry}=toolPackage(id);
 const prefix=join(root,target),packageRoot=join(prefix,'node_modules',name),binary=join(packageRoot,entry);
 await mkdir(dirname(binary),{recursive:true});
 await writeFile(join(packageRoot,'package.json'),JSON.stringify({name,version,type,bin:{[id]:'./'+entry}}));
 await writeFile(binary,'#!/usr/bin/env node\n',{mode:0o755});
 let launcher=binary;
 if(process.platform!=='win32'){
  launcher=join(prefix,'node_modules','.bin',id);
  await mkdir(dirname(launcher),{recursive:true});
  await symlink(relative(dirname(launcher),binary),launcher);
 }
 return {prefix,packageRoot,binary,launcher};
}
