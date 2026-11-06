import {execFile,spawn} from 'node:child_process';import {promisify} from 'node:util';import {join,resolve} from 'node:path';import {mkdtemp,realpath,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';
import {parse} from 'smol-toml';
import {nativeCodexProbe} from './live-support.js';
const exec=promisify(execFile);
export async function packagedIndependence(withNative=false){
 const control=await realpath(await mkdtemp(join(tmpdir(),'rigup-package-')));const root=control+'/project';await mkdir(root);const source=control+'/canary';await mkdir(source);await writeFile(source+'/SKILL.md','---\nname: rigup-live-canary\ndescription: Use for the native packaged fixture.\n---\nRead local references when present. Never bypass approval gates.\n');
 const server=`import readline from 'node:readline';for await(const line of readline.createInterface({input:process.stdin})){let r;try{r=JSON.parse(line)}catch{continue}if(!('id' in r))continue;let result;if(r.method==='initialize')result={protocolVersion:r.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'rigup-live-canary',version:'1.0.0'}};else if(r.method==='tools/list')result={tools:[{name:'rigup_echo',description:'Fixture echo',inputSchema:{type:'object',properties:{message:{type:'string'}},required:['message']},annotations:{readOnlyHint:true}}]};else if(r.method==='tools/call')result={content:[{type:'text',text:r.params.arguments.message}]};else result={};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');}`;
 await writeFile(root+'/server.mjs',server);await writeFile(root+'/check.mjs','process.exit(0);\n');await writeFile(root+'/package.json',JSON.stringify({name:'consumer-fixture',private:true,scripts:{lint:'node check.mjs'}}));await exec('git',['-C',root,'init','-q']);await exec('git',['-C',root,'config','core.hooksPath','.git/hooks']);await exec('git',['-C',root,'add','package.json','check.mjs','server.mjs']);
 await mkdir(root+'/.git/hooks',{recursive:true});
 await writeFile(root+'/.git/hooks/pre-commit','#!/bin/sh\nnpm run lint\n',{mode:0o755});
 await mkdir(root+'/.rigup');await writeFile(root+'/.rigup/config.yaml',JSON.stringify({agents:['codex'],backend:'host',customSkills:[{source}],mcp:[{id:'rigup-live-canary',agents:['codex'],command:{executable:process.execPath,args:['server.mjs'],cwd:'.',envRefs:[]}}],quality:{preCommit:['lint']}}));
 const packed=(await exec('npm',['pack','--json','--pack-destination',control],{cwd:resolve('.'),timeout:60000,maxBuffer:2_000_000})).stdout;const match=packed.match(/(\[\s*\{[\s\S]*\])\s*$/);if(!match)throw Error('npm pack omitted machine metadata');const meta=JSON.parse(match[1])[0];if(meta.files.some((f:{path:string})=>f.path.includes('.superpowers')||f.path.includes('.DS_Store')||f.path.startsWith('test/')))throw Error('Package contains cache or fixtures');
 const consumer=control+'/consumer';await mkdir(consumer);await exec('npm',['install','--prefix',consumer,join(control,meta.filename),'--prefer-offline','--omit=dev','--ignore-scripts','--no-audit','--no-fund','--userconfig',control+'/user.npmrc','--globalconfig',control+'/global.npmrc'],{timeout:60000,maxBuffer:1_000_000});
 const installedCli=consumer+'/node_modules/.bin/rigup';const env={...process.env,HOME:control+'/cli-home',NO_COLOR:'1'};await mkdir(env.HOME,{mode:0o700});const report=JSON.parse((await exec(installedCli,['init',root,'--json'],{env,timeout:60000,maxBuffer:2_000_000})).stdout);if(report.exitCode!==0)throw Error('Packaged CLI did not install fixture: '+JSON.stringify(report));
 await rm(consumer+'/node_modules',{recursive:true,force:true});
 await rm(root+'/.rigup/manifest.json');
 for(const asset of ['scripts','mcp','checks.json'])await assert.rejects(readFile(root+'/.rigup/'+asset),{code:'ENOENT'});
 await exec('git',['hook','run','pre-commit'],{cwd:root,timeout:60000,maxBuffer:1_000_000});
 const config=parse(await readFile(root+'/.codex/config.toml','utf8')) as {mcp_servers:Record<string,{command:string;args:string[];cwd:string}>};
 const entry=config.mcp_servers['rigup-live-canary'];
 assert.deepEqual({...entry},{command:process.execPath,args:['server.mjs'],cwd:root,env_vars:[]});
 const serverProcess=spawn(entry.command,entry.args,{cwd:entry.cwd,stdio:['pipe','pipe','pipe']});
 const echo=await new Promise<boolean>((done,reject)=>{
  let buffer='';
  const timer=setTimeout(()=>{serverProcess.kill('SIGKILL');reject(Error('Project MCP server timed out'));},10000);
  serverProcess.on('close',()=>{clearTimeout(timer);done(buffer.includes('packaged-canary'));});
  serverProcess.on('error',error=>{clearTimeout(timer);reject(error);});
  serverProcess.stdout.on('data',chunk=>{buffer+=chunk;});
  serverProcess.stdin.end(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'rigup_echo',arguments:{message:'packaged-canary'}}})+'\n');
 });
 let native;if(withNative)native=await nativeCodexProbe({root,control,source,server,startedAt:new Date().toISOString(),installed:report});
 return {status:echo?'passed':'failed',archive:meta.filename,archiveIntegrity:meta.integrity,archiveFiles:meta.files.map((f:{path:string})=>f.path),rigupRemoved:true,hookResult:0,nativeEcho:echo,fixture:root,native:native??'not executed in local contract; requires live client',skillContent:await readFile(root+'/.agents/skills/rigup-live-canary/SKILL.md','utf8')};
}
