import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {access, mkdir, readFile, symlink, writeFile} from 'node:fs/promises';
import {delimiter, dirname, join} from 'node:path';
import {promisify} from 'node:util';
import {runCli} from '../src/cli.js';
import {project, testEnvironment} from './helpers.js';
import {fixedNpmView} from './native-tool-fixture.js';

const exec=promisify(execFile);
const nodeDir=dirname(process.execPath);

async function openWikiCommand(bin:string, marker:string) {
 await mkdir(bin,{recursive:true});
 const script='console.log(JSON.stringify({marker:'+JSON.stringify(marker)+',cwd:process.cwd(),args:process.argv.slice(2)}));\n';
 if(process.platform==='win32'){
  const pkg=join(bin,'node_modules','openwiki');
  await mkdir(join(pkg,'dist/cli'),{recursive:true});
  await writeFile(join(pkg,'package.json'),JSON.stringify({name:'openwiki',version:'0.9.0',bin:{openwiki:'dist/cli/cli.js'}}));
  await writeFile(join(pkg,'dist/cli/cli.js'),script);
  await writeFile(join(bin,'openwiki.cmd'),'@echo off\r\nnode "%~dp0node_modules\\openwiki\\dist\\cli\\cli.js" %*\r\n');
 }else await writeFile(join(bin,'openwiki'),'#!/usr/bin/env node\n'+script,{mode:0o755});
}

test('new --tools selects existing PATH OpenWiki without consulting npm',t=>project(root=>project(outside=>project(async stateRoot=>{
 const bin=join(outside,'trusted command bin');
 await openWikiCommand(bin,'trusted');
 testEnvironment(t,{RIGUP_CONSUMER_PATH:[bin,nodeDir].join(delimiter)});
 let stdout='',views=0;
 const code=await runCli(['init','--agents','claude','--sdd','none','--tools','openwiki','--dry-run','--json'],{
  cwd:root,isTTY:false,write:text=>stdout+=text,
  services:{cacheRoot:join(stateRoot,'cache'),stateRoot,npmView:async(...args)=>{views++;return fixedNpmView(...args);}},
 });
 const result=JSON.parse(stdout);
 assert.equal(code,0,stdout);
 assert.equal(result.executable,true);
 assert.deepEqual(result.operations,[]);
 assert.equal(views,0);
}))));
test('generated external MCP launches the trusted PATH entry from the project root',t=>project(root=>project(outside=>project(async stateRoot=>{
 const fake=join(root,'bin'),trusted=join(outside,'trusted with space');
 await openWikiCommand(fake,'project decoy');
 await openWikiCommand(trusted,'trusted');
 const childPath=[fake,trusted,nodeDir,process.env.PATH].join(delimiter);
 testEnvironment(t,{RIGUP_CONSUMER_PATH:childPath});
 await mkdir(join(root,'.rigup'));
 await writeFile(join(root,'.rigup','config.yaml'),'agents: [claude]\nbackend: host\nprojectRules: false\ntools:\n - id: openwiki\n   install: false\n   initialize: false\n   agents: [claude]\n');
 const subdirectory=join(root,'src','sub');
 await mkdir(subdirectory,{recursive:true});
 let stdout='';
 const code=await runCli(['init','--sessions-ended','--json'],{
  cwd:root,isTTY:false,write:text=>stdout+=text,services:{cacheRoot:join(stateRoot,'cache'),stateRoot},
 });
 assert.equal(code,0,stdout);
 const {mcpServers:{openwiki}}=JSON.parse(await readFile(join(root,'.mcp.json'),'utf8'));
 assert.equal(openwiki.command,'node','the host starts its Node launcher');
 const launched=await exec(process.execPath,openwiki.args,{cwd:subdirectory,env:{...process.env,PATH:childPath}});
 assert.deepEqual(JSON.parse(launched.stdout),{marker:'trusted',cwd:root,args:['mcp','--host','claude']});
}))));

test('doctor detects a project Node ahead of the host interpreter and missing PATH wiring',t=>project(root=>project(outside=>project(async stateRoot=>{
 const trusted=join(outside,'user bin');
 await openWikiCommand(trusted,'trusted');
 testEnvironment(t,{RIGUP_CONSUMER_PATH:[trusted,nodeDir].join(delimiter)});
 await mkdir(join(root,'.rigup'));
 await writeFile(join(root,'.rigup','config.yaml'),'agents: [claude]\nbackend: host\nprojectRules: false\ntools:\n - id: openwiki\n   install: false\n   initialize: false\n   agents: [claude]\n');
 assert.equal(await runCli(['init','--sessions-ended','--json'],{cwd:root,isTTY:false,write:()=>{},services:{cacheRoot:join(stateRoot,'cache'),stateRoot}}),0);
 const decoy=join(root,'bin');
 await mkdir(decoy);
 await writeFile(join(decoy,process.platform==='win32'?'node.exe':'node'),'never invoke this project file',{mode:0o755});
 process.env.RIGUP_CONSUMER_PATH=decoy;
 let stdout='';
 await runCli(['doctor','--json'],{
  cwd:root,isTTY:false,write:text=>stdout+=text,services:{cacheRoot:join(stateRoot,'cache'),stateRoot},
 });
 const report=JSON.parse(stdout);
 assert.ok(report.diagnostics.some((item:{id:string;state:string;reason:string})=>item.id==='tools:host-node'&&item.state==='pending'&&item.reason.includes('host PATH')));
 assert.ok(report.diagnostics.some((item:{id:string;state:string;reason:string})=>item.id==='openwiki:binary'&&item.state==='pending'&&item.reason.includes('--configure')));
}))));

test('an installed CodeGraph npm shim without its platform payload is repairable without running it',t=>project(root=>project(outside=>project(async stateRoot=>{
 const bin=join(outside,'bin');
 const pkg=join(process.platform==='win32'?bin:join(outside,'lib'),'node_modules','@colbymchenry','codegraph');
 await mkdir(bin);
 await mkdir(pkg,{recursive:true});
 const platform='@colbymchenry/codegraph-'+process.platform+'-'+process.arch;
 const marker=join(outside,'called');
 await writeFile(join(pkg,'package.json'),JSON.stringify({name:'@colbymchenry/codegraph',version:'1.6.2',bin:{codegraph:'npm-shim.js'},optionalDependencies:{[platform]:'1.6.2'}}));
 const js='#!/usr/bin/env node\nrequire("fs").writeFileSync('+JSON.stringify(marker)+',"unexpected");\n';
 await writeFile(join(pkg,'npm-shim.js'),js,{mode:0o755});
 if(process.platform==='win32')await writeFile(join(bin,'codegraph.cmd'),'@echo off\r\nnode "%~dp0node_modules\\@colbymchenry\\codegraph\\npm-shim.js" %*\r\n');
 else await symlink(join(pkg,'npm-shim.js'),join(bin,'codegraph'));
 testEnvironment(t,{RIGUP_CONSUMER_PATH:[bin,nodeDir].join(delimiter)});
 let stdout='',views=0;
 const code=await runCli(['init','--agents','claude','--sdd','none','--tools','codegraph','--dry-run','--json'],{
  cwd:root,isTTY:false,write:text=>stdout+=text,
  services:{cacheRoot:join(stateRoot,'cache'),stateRoot,npmView:async(...args)=>{views++;return fixedNpmView(...args);}},
 });
 const report=JSON.parse(stdout);
 assert.equal(code,3,stdout);
 assert.ok(report.blockers.some((item:string)=>item.includes(platform)));
 assert.equal(views,0);
 await assert.rejects(access(marker),{code:'ENOENT'});
}))));
