import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {delimiter,dirname,join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {runCli,type CliIO} from '../src/cli.js';
import {project,testEnvironment,writeOpenSpecFixture} from './helpers.js';

const zh=['--language','zh-CN'];
const put=async(path:string,text:string,mode?:number)=>{
 await mkdir(dirname(path),{recursive:true});
 await writeFile(path,text,{mode});
};
const config=(cwd:string,yaml:string)=>put(join(cwd,'.rigup/config.yaml'),yaml+'\n');
const cliPath=fileURLToPath(new URL('../src/cli.ts',import.meta.url));

function fixture(run:(cwd:string,control:string,invoke:(args:string[],overrides?:Partial<CliIO>)=>Promise<{code:number;stdout:string;stderr:string}>)=>Promise<void>){
 return project(async control=>{
  const cwd=join(control,'project');
  await mkdir(cwd);
  await run(cwd,control,async(args,overrides)=>{
   let stdout='',stderr='';
   const code=await runCli(args,{cwd,isTTY:false,write:text=>stdout+=text,writeError:text=>stderr+=text,
    ...overrides,services:{cacheRoot:join(control,'cache'),stateRoot:join(control,'state'),...overrides?.services}});
   return {code,stdout,stderr};
  });
 });
}

const choices='provide supported comma-separated values, repeat the option, or separate values with spaces. In PowerShell, use quotes around comma-separated values.';
const oldLanguage='documentLanguage: use auto or a BCP 47 language tag such as zh-CN or en';
const cliCases=[
 {args:['init','--tools','none,openwiki'],expected:['none','单独使用'],error:'tools: none cannot be combined with a tool'},
 {args:['init','--profile','nope.json'],expected:['nope.json','找不到'],error:'profile: file not found'},
 {args:['init','--api-key-env','lower'],expected:['--api-key-env','环境变量名','ANTHROPIC_API_KEY'],error:'model.apiKeyEnv: environment reference required'},
 {args:['update','--continue','nope'],expected:['继续','执行模式'],error:'continuation cannot change explicit selections or execution mode'},
 {args:['update','--retire','x'],expected:['上次安装清单','x'],error:'retirement id not in old inventory'},
 {args:['init','--unknown'],expected:['未知选项'],error:'Unknown option'},
 {args:['init','--profile'],expected:['--profile','缺少参数值'],error:'--profile: value required'},
 {args:['init','--agents','foo'],expected:['--agents','分隔支持的值'],error:'--agents: '+choices},
 {args:['init','--tools','foo'],expected:['--tools','分隔支持的值'],error:'--tools: '+choices},
 {args:['init','--dry-run','--review'],expected:['执行模式只能选择一种'],error:'execution mode: choose one'},
 {args:['init','--request','relative.json'],expected:['绝对文件路径','host'],error:(control:string)=>'request: use an absolute file path inside '+join(control,'cache','host')},
 {args:['doctor','--check-host','codex'],expected:['--check-host claude','只能与 doctor 一起使用'],error:'--check-host claude is supported with doctor only'},
 {args:['doctor','--research-tokens','10'],expected:['--research-tokens','仅适用于 Codex 调研'],error:'--research-tokens applies to Codex research only'},
 {args:['init','--install-scope','project'],expected:['--prepare-openspec','project','global'],error:'--install-scope requires --prepare-openspec and project or global'},
 {args:['init','--prepare-native','--agents','claude','--sdd','openspec'],expected:['请与 init 一起使用','--sdd superpowers'],error:'--prepare-native: use init with explicit --agents and --sdd superpowers, with at most one of --review and --dry-run.'},
];
const configCases=[
 {yaml:'agents: [claude, foo]',expected:['agents[1]','claude','codex','opencode','omp'],error:'agents: expected supported agent list'},
 {yaml:'agents: claude',expected:['agents','列表','claude','codex','opencode','omp'],error:'agents: expected supported agent list'},
 {yaml:'sdd: bar',expected:['sdd','none','superpowers','openspec','spec-kit'],error:'sdd: unsupported selection'},
 {yaml:'tools: [x]',expected:['tools.0.id','openwiki','codegraph'],error:'tools.0.id: unsupported'},
 {yaml:'agents: [claude',expected:['YAML','语法'],error:'config: invalid YAML syntax'},
 {yaml:'model: {provider: anthropic}',expected:['model.model','模型名称'],error:'model.model: required'},
 {yaml:'mcp: [{id: x}]',expected:['mcp.0','url','command','二选一'],error:'mcp.0: choose url or command'},
 {yaml:'backend: nope',expected:['backend','codex','native','host'],error:'backend: expected codex, native or host'},
 {yaml:'executionPolicy: {mode: fast}',expected:['executionPolicy.mode','continuous','review'],error:'executionPolicy.mode: continuous or review required'},
 {yaml:'documentLanguage: invalid_tag',expected:['documentLanguage','auto','BCP 47'],error:oldLanguage},
];
const contains=(text:string,expected:string[])=>{
 for(const fragment of expected)assert.ok(text.includes(fragment),text);
};

for(const [index,item] of cliCases.entries())test('zh-CN CLI misuse C'+String(index+1).padStart(2,'0')+' '+item.args.join(' '),()=>fixture(async(cwd,control,invoke)=>{
 const code=index===4?1:2;
 if(index===4)await put(join(cwd,'.rigup/manifest.json'),JSON.stringify({
  schemaVersion:1,installId:'fixture',assets:[],options:{agents:['claude'],backend:'host'},
 }));
 const oldError=typeof item.error==='function'?item.error(control):item.error;
 const machine=await invoke([...item.args,...zh,'--json']);
 assert.equal(machine.code,code,machine.stdout);
 assert.equal(JSON.parse(machine.stdout).error,oldError);
 const human=await invoke([...item.args,...zh]);
 assert.equal(human.code,code,human.stdout);
 assert.ok(!human.stdout.includes(oldError),human.stdout);
 contains(human.stdout,item.expected);
}));

for(const [index,item] of configCases.entries())test('zh-CN config misuse Y'+String(index+1).padStart(2,'0')+' '+item.yaml,()=>fixture(async(cwd,_control,invoke)=>{
 await config(cwd,item.yaml);
 const machine=await invoke(['init',...zh,'--json']);
 assert.equal(machine.code,2,machine.stdout);
 assert.equal(JSON.parse(machine.stdout).error,item.error);
 const human=await invoke(['init',...zh]);
 assert.equal(human.code,2,human.stdout);
 assert.ok(!human.stdout.includes(item.error),human.stdout);
 contains(human.stdout,['.rigup/config.yaml','原因',...item.expected]);
}));

test('CLI subprocess uses the saved config locale and preserves the English JSON error',()=>fixture(async(cwd)=>{
 await config(cwd,'documentLanguage: zh-CN\nsdd: bar');
 const run=(...flags:string[])=>spawnSync(process.execPath,['--import','tsx',cliPath,'init',cwd,...flags],{encoding:'utf8'});
 const human=run();
 assert.equal(human.status,2,human.stderr);
 contains(human.stdout,['.rigup/config.yaml','sdd','spec-kit']);
 assert.doesNotMatch(human.stdout,/unsupported selection/);
 const machine=run('--json');
 assert.equal(machine.status,2,machine.stderr);
 assert.equal(JSON.parse(machine.stdout).error,'sdd: unsupported selection');
 assert.match(machine.stderr,/初始化/);
}));

test('profile validation names the profile, and system Chinese localizes the bare continuation error',t=>fixture(async(cwd,_control,invoke)=>{
 await put(join(cwd,'profile.yaml'),'agents: [unregistered]\n');
 const profile=await invoke(['init','--profile','profile.yaml',...zh]);
 assert.equal(profile.code,2,profile.stdout);
 contains(profile.stdout,['profile.yaml','agents[0]','codex']);
 assert.doesNotMatch(profile.stdout,/\.rigup\/config\.yaml|unregistered|expected supported agent list/);
 testEnvironment(t,{LC_ALL:'zh_CN.UTF-8'});
 const continuation=await invoke(['update','--continue','nope']);
 assert.equal(continuation.code,2,continuation.stdout);
 assert.match(continuation.stdout,/继续.*ID.*无效/);
 assert.doesNotMatch(continuation.stdout,/continuation id invalid/);
 assert.equal(JSON.parse((await invoke(['update','--continue','nope','--json'])).stdout).error,'continuation id invalid');
}));

test('OpenSpec root and entry requirements use Chinese in preflight and the summary',t=>fixture(async(_cwd,control,invoke)=>{
 const bin=join(control,'bin');
 await writeOpenSpecFixture(bin,"console.log(process.argv[2]==='--version'?'1.16.0':JSON.stringify({root:null}));\n");
 const path=bin+delimiter+process.env.PATH;
 testEnvironment(t,{PATH:path,RIGUP_CONSUMER_PATH:path});
 const args=['init','--agents','claude','--sdd','openspec','--review',...zh];
 const human=await invoke(args);
 assert.equal(human.code,3,human.stdout);
 assert.match(human.stdout,/OpenSpec[^\n]*缺少[^\n]*项目根/);
 assert.match(human.stdout,/OpenSpec[^\n]*claude[^\n]*工作流入口/);
 assert.match(human.stdout,/原因[^\n]*项目根/);
 assert.match(human.stdout,/--prepare-openspec/);
 assert.doesNotMatch(human.stdout,/project root is missing|workflow entries are missing/);
 const machine=await invoke([...args,'--json']);
 const {pending,requiredInput}=JSON.parse(machine.stdout);
 assert.deepEqual(pending,['OpenSpec project root is missing','claude: OpenSpec workflow entries are missing']);
 assert.deepEqual(requiredInput,pending);
}));

test('wizard renders the missing Superpowers skill before open-ended choices',()=>fixture(async(cwd,_control,invoke)=>{
 await put(join(cwd,'docs/superpowers/fixture.md'),'# Project marker\n');
 const {code,stdout}=await invoke(['init','--agents','omp',...zh],{isTTY:true,ask:async()=>null});
 assert.equal(code,130);
 assert.match(stdout,/检测到项目中的 superpowers 线索[^\n]*omp[^\n]*缺少[^\n]*superpowers:brainstorming/);
 assert.doesNotMatch(stdout,/missing native entry/);
}));

test('Superpowers preview localizes the next step and detailed readiness problem',t=>fixture(async(_cwd,control,invoke)=>{
 const bin=join(control,'bin');
 await put(join(bin,process.platform==='win32'?'claude.cmd':'claude'),process.platform==='win32'?'@exit /b 73\r\n':'#!/bin/sh\nexit 73\n',0o700);
 const path=bin+delimiter+process.env.PATH;
 testEnvironment(t,{PATH:path,RIGUP_CONSUMER_PATH:path});
 const args=['init','--agents','claude','--sdd','superpowers','--defer-research','--review',...zh];
 const human=await invoke([...args,'--verbose']);
 assert.equal(human.code,3,human.stdout);
 assert.match(human.stdout,/^原因: 缺少原生 Superpowers/m);
 assert.match(human.stdout,/^已阻止: .*缺少.*superpowers:brainstorming/m);
 assert.doesNotMatch(human.stdout,/missing native entry/);
 const command='/plugin install superpowers@claude-plugins-official';
 assert.ok(human.stdout.includes(command),human.stdout);
 const report=JSON.parse((await invoke([...args,'--json'])).stdout);
 assert.equal(report.pending[0].reason,'claude: missing native entry: superpowers:brainstorming; '+command);
 assert.equal(report.blockers[0],'superpowers: '+report.pending[0].reason);
 assert.match(report.nextCommand,/^rigup init .+ --agents claude --sdd superpowers --prepare-native$/);
 assert.equal(report.pending[0].nextCommand,report.nextCommand);
}));

test('native preparation localizes the concise OMP download reason and keeps its machine contract',()=>fixture(async(_cwd,control,invoke)=>{
 const bin=join(control,'bin'),home=join(control,'home');
 await mkdir(home);
 await put(join(bin,process.platform==='win32'?'omp.cmd':'omp'),process.platform==='win32'?'@exit /b 73\r\n':'#!/bin/sh\nexit 73\n',0o700);
 const args=['init','--agents','omp','--sdd','superpowers','--prepare-native'];
 let launched=0;
 const run=(response:()=>Response,flags:string[])=>invoke([...args,...flags],{services:{
  nativeSetup:{home,env:{PATH:bin},fetch:async()=>response(),launch:async()=>{launched++;return {code:1};}},
 }});
 const offline=()=>new Response(null,{status:503});
 const human=await run(offline,zh);
 assert.equal(human.code,3,human.stdout);
 assert.equal(human.stdout.split('\n').filter(line=>line.includes('无法从官方地址下载 OMP')).length,1,human.stdout);
 assert.match(human.stdout,/需要先解决的问题/);
 assert.doesNotMatch(human.stdout,/Could not download OMP/);
 const broken=await run(()=>Response.json({}),zh);
 assert.equal(broken.code,3,broken.stdout);
 assert.match(broken.stdout,/没有提供可用的最新软件包信息/);
 assert.equal(launched,0);
 const machine=await run(offline,[...zh,'--json']);
 assert.equal(machine.stdout,(await run(offline,['--language','en','--json'])).stdout);
 const report=JSON.parse(machine.stdout);
 assert.deepEqual(report.nativePreparation.blockers[0],{
  code:'download-failed',host:'omp',reason:'Could not download OMP metadata or package from its official URL.',
  evidence:['https://registry.npmjs.org/@loneexile%2fomp-superpowers/latest'],suggest:[],agent_can_draft:true,
 });
 assert.deepEqual(report.pending,['Some native workflow prerequisites need manual preparation.']);
}));

test('doctor localizes provider reason and friendly names while retaining its last English JSON line',()=>fixture(async(cwd,_control,invoke)=>{
 const assets=[['rigup:research-launcher','.rigup/rigup-mcp.mjs'],['mcp:claude:rigup','.mcp.json'],['customer:hidden-id','custom.yml']]
  .map(([logicalId,target])=>({logicalId,target,digest:'a'.repeat(64),ownership:{kind:'file'}}));
 const path=join(cwd,'.rigup/manifest.json');
 const original=JSON.stringify({schemaVersion:1,installId:'fixture',assets,options:{agents:['claude'],backend:'native',documentLanguage:'en'}});
 await put(path,original);
 await put(join(cwd,'.rigup/.gitignore'),'.env\n');
 await put(join(cwd,'.rigup/.env'),'RIGUP_PROVIDER=anthropic\nRIGUP_MODEL_ID=fixture-private-model\n',0o600);
 const human=await invoke(['doctor',...zh]);
 assert.equal(human.code,1,human.stdout);
 contains(human.stdout,['Rigup 调研启动器','Claude Code 的 Rigup MCP 配置','custom.yml','ANTHROPIC_API_KEY','设置位置','.rigup/.env']);
 assert.doesNotMatch(human.stdout,/rigup:research-launcher|mcp:claude:rigup|customer:hidden-id|env:RIGUP_PROVIDER|Selected Rigup CLI research provider|fixture-private-model/);
 const verbose=await invoke(['doctor',...zh,'--verbose']);
 contains(verbose.stdout,['rigup:research-launcher','mcp:claude:rigup','customer:hidden-id','env:RIGUP_PROVIDER','设置位置','.rigup/.env','项目文件']);
 assert.doesNotMatch(verbose.stdout,/Selected Rigup CLI research provider|fixture-private-model/);
 const machine=await invoke(['doctor',...zh,'--json']);
 assert.equal(machine.stdout,(await invoke(['doctor','--language','en','--json'])).stdout);
 const json=JSON.parse(machine.stdout);
 assert.equal(json.error,'environment env:RIGUP_BASE_URL: available — Optional company model gateway; destination: .rigup/.env; source: configuration');
 assert.equal(json.diagnostics.find((row:{id:string})=>row.id==='env:RIGUP_PROVIDER').reason,
  'Selected Rigup CLI research provider; destination: .rigup/.env; source: project-file');
 assert.doesNotMatch(machine.stdout,/fixture-private-model/);
 assert.equal(await readFile(path,'utf8'),original);
}));

test('doctor directs the user to a safe runtime file without exposing its contents',()=>fixture(async(cwd,_control,invoke)=>{
 await put(join(cwd,'.rigup/manifest.json'),JSON.stringify({
  schemaVersion:1,installId:'fixture',assets:[],options:{agents:[],backend:'native'},
 }));
 await put(join(cwd,'.rigup/.env'),'RIGUP_PROVIDER=private-synthetic-value\n',0o600);
 const human=await invoke(['doctor',...zh,'--verbose']);
 assert.equal(human.code,3,human.stdout);
 contains(human.stdout,['私有运行配置','.rigup/.env','未被 Git 跟踪']);
 assert.doesNotMatch(human.stdout,/effectively ignored regular file|private-synthetic-value/);
 const report=JSON.parse((await invoke(['doctor',...zh,'--json'])).stdout);
 assert.equal(report.runtimeSetup.template.reason,'Keep .rigup/.env unchanged; it must be an untracked, effectively ignored regular file inside the project.');
 assert.doesNotMatch(JSON.stringify(report),/private-synthetic-value/);
}));
