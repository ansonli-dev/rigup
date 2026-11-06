import {mkdir,mkdtemp,realpath,rm,writeFile} from 'node:fs/promises';
import {delimiter,join} from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtempSync,rmSync,realpathSync} from 'node:fs';
import {after} from 'node:test';
import type {ProjectProfile} from '../src/analyzer/repository.js';
import type {Agent} from '../src/types.js';
// Unit workers never inherit the developer's native-plugin/auth installation.
const nativeTestHome=realpathSync(mkdtempSync(join(tmpdir(),'rigup-native-test-home-')));
Object.assign(process.env,{HOME:nativeTestHome,CODEX_HOME:join(nativeTestHome,'.codex'),CLAUDE_CONFIG_DIR:join(nativeTestHome,'.claude'),XDG_CONFIG_HOME:join(nativeTestHome,'.config'),PI_CODING_AGENT_DIR:join(nativeTestHome,'.omp/agent')});
after(()=>rmSync(nativeTestHome,{recursive:true,force:true}));
export function setNativeEntries(profile:ProjectProfile,entries:Partial<Record<Agent,string[]>>){profile.nativeEntries=entries;profile.skillSources={};for(const[key,names]of Object.entries(entries))profile.skillSources[key as Agent]=names.map(name=>({name,origin:'local',identity:'fixture/'+name+'/SKILL.md',digest:'fixture:'+name,satisfies:true}));}
export async function openspecFixturePath(root:string,control:string){
 await mkdir(join(root,'openspec'));
 await writeFile(join(root,'openspec/config.yaml'),'schema: spec-driven\n');
 const bin=join(control,'bin');
 await mkdir(bin);
 await writeFile(join(bin,'openspec'),'#!'+process.execPath+'\nconsole.log(process.argv.includes("--version")?"1.16.0":JSON.stringify({root:{path:process.cwd(),source:"nearest"}}));\n',{mode:0o755});
 return bin+delimiter+process.env.PATH;
}
export async function project(fn:(root:string)=>Promise<void>) {
 const root=await realpath(await mkdtemp(join(tmpdir(),'rigup-scan-')));
 try{await fn(root);}finally{await rm(root,{recursive:true,force:true});}
}
