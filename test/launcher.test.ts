import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,readFile,rename,unlink,writeFile} from 'node:fs/promises';
import {delimiter,dirname,join} from 'node:path';
import {project} from './helpers.js';
import {scanRepository} from '../src/analyzer/repository.js';
import {generateFoundation,prepareGeneration} from '../src/generator/generate.js';

const exec=promisify(execFile);
const version=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).version;
import {fakeRigup} from './launcher-support.js';
async function launcher(root:string){
 const options={agents:['claude' as const],backend:'host' as const,projectRules:true};
 const profile=await scanRepository(root,options),plan=await generateFoundation(profile,options,await prepareGeneration(profile,options));
 const content=plan.assets.find(a=>a.logicalId==='rigup:research-launcher')!.content;
 await mkdir(join(root,'.rigup'),{recursive:true});await writeFile(join(root,'.rigup/rigup-mcp.mjs'),content);
 const binding=JSON.parse(plan.assets.find(a=>a.logicalId==='mcp:claude:rigup')!.content);
 await writeFile(join(root,'.mcp.json'),JSON.stringify({mcpServers:{rigup:binding}}));
 return {plan,binding};
}
test('generated installation records the writing Rigup version',()=>project(async root=>{
 assert.equal((await launcher(root)).plan.versions.rigup,version);
}));
test('first PATH version mismatch blocks MCP before a later compatible CLI can run',()=>project(root=>project(old=>project(async current=>{
 const {binding}=await launcher(root);await fakeRigup(old,'0.0.1');await fakeRigup(current,version);
 const result=await exec(process.execPath,binding.args,{cwd:root,env:{...process.env,PATH:[old,current,dirname(process.execPath)].join(delimiter)},timeout:12000}).then(()=>undefined,error=>error);
 assert.ok(result,'stale CLI must not start MCP');
 assert.equal(result.stdout,'');assert.ok(result.stderr.includes(version));assert.match(result.stderr,/0\.0\.1/);assert.ok(result.stderr.includes(old));
 await assert.rejects(readFile(join(root,'mcp-started')),{code:'ENOENT'});
}))));
test('Windows first unresolved PATH shim blocks fallback to a later CLI',{skip:process.platform!=='win32'&&'uses native Windows npm shims'},()=>project(root=>project(old=>project(async current=>{
 const {binding}=await launcher(root);await writeFile(join(old,'rigup.cmd'),'@echo off\r\necho 0.0.1\r\n');await fakeRigup(current,version);
 const result=await exec(process.execPath,binding.args,{cwd:root,env:{...process.env,PATH:[old,current,dirname(process.execPath)].join(delimiter)},timeout:12000}).then(()=>undefined,error=>error);
 assert.ok(result,'an unresolved first command cannot select a different later command');assert.equal(result.stdout,'');assert.ok(result.stderr.includes(old));
 await assert.rejects(readFile(join(root,'mcp-started')),{code:'ENOENT'});
}))));
test('Windows PATH package without a command shim is not an executable candidate',{skip:process.platform!=='win32'&&'uses native Windows npm shims'},()=>project(root=>project(old=>project(async current=>{
 const {binding}=await launcher(root);await fakeRigup(old,'0.0.1');await unlink(join(old,'rigup.cmd'));await fakeRigup(current,version);
 await exec(process.execPath,binding.args,{cwd:root,env:{...process.env,PATH:[old,current,dirname(process.execPath)].join(delimiter)},timeout:12000});
 assert.equal(await readFile(join(root,'mcp-started'),'utf8'),'yes');
}))));
test('matching first CLI starts from a nested directory after Unicode project relocation',()=>project(workspace=>project(async bin=>{
 const root=join(workspace,'original');await mkdir(root);const {binding}=await launcher(root);await fakeRigup(bin,version);
 const moved=join(workspace,'移动 project');await rename(root,moved);await mkdir(join(moved,'nested'));
 await exec(process.execPath,binding.args,{cwd:join(moved,'nested'),env:{...process.env,PATH:bin+delimiter+dirname(process.execPath)},timeout:12000});
 assert.equal(await readFile(join(moved,'mcp-started'),'utf8'),'yes');
})));
test('manifest and embedded version disagreement fails before invoking MCP',()=>project(root=>project(async bin=>{
 const {binding}=await launcher(root);await fakeRigup(bin,version);
 await writeFile(join(root,'.rigup/manifest.json'),JSON.stringify({schemaVersion:1,installId:'fixture',assets:[],versions:{rigup:'0.0.2'}}),{mode:0o600});
 const result=await exec(process.execPath,binding.args,{cwd:root,env:{...process.env,PATH:bin+delimiter+dirname(process.execPath)},timeout:12000}).then(()=>undefined,error=>error);
 assert.ok(result);assert.match(result.stderr,/manifest|disagree/i);await assert.rejects(readFile(join(root,'mcp-started')),{code:'ENOENT'});
})));
for(const scenario of ['malformed','timeout'])test('unverifiable '+scenario+' CLI version does not start MCP',()=>project(root=>project(async bin=>{
 const {binding}=await launcher(root);await fakeRigup(bin,'untrusted output',undefined,scenario==='timeout');
 const result=await exec(process.execPath,binding.args,{cwd:root,env:{...process.env,PATH:bin+delimiter+dirname(process.execPath)},timeout:12000}).then(()=>undefined,error=>error);
 assert.ok(result);assert.match(result.stderr,/version/i);assert.doesNotMatch(result.stderr,/untrusted output/);await assert.rejects(readFile(join(root,'mcp-started')),{code:'ENOENT'});
})));
