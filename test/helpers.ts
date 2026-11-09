import {mkdir,mkdtemp,realpath,rm,writeFile} from 'node:fs/promises';
import {delimiter,join} from 'node:path';
import {homedir,tmpdir} from 'node:os';
import {mkdtempSync,rmSync,realpathSync} from 'node:fs';
import {after} from 'node:test';
import type {ProjectProfile} from '../src/analyzer/repository.js';
import type {Agent} from '../src/types.js';
// Default tests provide their own model credentials and active-session markers.
for(const key of ['ANTHROPIC_API_KEY','ANTHROPIC_MODEL','ANTHROPIC_BASE_URL','ANTHROPIC_CUSTOM_HEADERS','OPENAI_API_KEY','OPENAI_MODEL','OPENAI_BASE_URL','RIGUP_PROVIDER','RIGUP_MODEL_ID','RIGUP_BASE_URL','RIGUP_API_KEY_ENV','CODEX_THREAD_ID','CLAUDECODE','OPENCODE'])delete process.env[key];
// Unit workers use a separate native-plugin installation.
const nativeTestHome=realpathSync(mkdtempSync(join(process.platform==='win32'?homedir():tmpdir(),'.rigup-native-test-home-')));
Object.assign(process.env,{HOME:nativeTestHome,CODEX_HOME:join(nativeTestHome,'.codex'),CLAUDE_CONFIG_DIR:join(nativeTestHome,'.claude'),XDG_CONFIG_HOME:join(nativeTestHome,'.config'),PI_CODING_AGENT_DIR:join(nativeTestHome,'.omp/agent')});
if(process.platform==='win32')process.env.USERPROFILE=nativeTestHome;
after(()=>rmSync(nativeTestHome,{recursive:true,force:true}));
export function setNativeEntries(profile:ProjectProfile,entries:Partial<Record<Agent,string[]>>){profile.nativeEntries=entries;profile.skillSources={};for(const[key,names]of Object.entries(entries))profile.skillSources[key as Agent]=names.map(name=>({name,origin:'local',identity:'fixture/'+name+'/SKILL.md',digest:'fixture:'+name,satisfies:true}));}
export async function writeOpenSpecFixture(bin:string,source:string,shebang='#!'+process.execPath){
 await mkdir(bin,{recursive:true});
 if(process.platform==='win32'){
  const packageRoot=join(bin,'node_modules','@fission-ai','openspec');
  await mkdir(join(packageRoot,'bin'),{recursive:true});
  await writeFile(join(packageRoot,'package.json'),JSON.stringify({name:'@fission-ai/openspec',bin:{openspec:'bin/openspec.js'}}));
  await writeFile(join(packageRoot,'bin','openspec.js'),source);
  await writeFile(join(bin,'openspec.cmd'),'@echo off\r\nnode "%~dp0node_modules\\@fission-ai\\openspec\\bin\\openspec.js" %*\r\n');
 }else await writeFile(join(bin,'openspec'),shebang+'\n'+source,{mode:0o755});
}

export async function openspecFixturePath(root:string,control:string){
 await mkdir(join(root,'openspec'));
 await writeFile(join(root,'openspec/config.yaml'),'schema: spec-driven\n');
 const bin=join(control,'bin');
 await writeOpenSpecFixture(bin,'console.log(process.argv.includes("--version")?"1.16.0":JSON.stringify({root:{path:process.cwd(),source:"nearest"}}));\n');
 return bin+delimiter+process.env.PATH;
}
export async function project(fn:(root:string)=>Promise<void>) {
 const root=await realpath(await mkdtemp(join(tmpdir(),'rigup-scan-')));
 try{await fn(root);}finally{await rm(root,{recursive:true,force:true});}
}
