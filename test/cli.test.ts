import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runCli} from '../src/cli.js';

test('help_lists_lifecycle_commands', async () => {
  let output = '';
  const code = await runCli(['--help'], {cwd:tmpdir(), isTTY:false, write:(s:string)=>output+=s});
  assert.equal(code, 0);
  for (const cmd of ['init','update','doctor']) assert.match(output, new RegExp(cmd));
});
test('unknown_option_does_not_touch_project', async () => {
  const root = await mkdtemp(join(tmpdir(),'rigup-'));
  try {
    assert.equal(await runCli(['init','--unknown'], {cwd:root,isTTY:false,write:()=>{}}),2);
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root,{recursive:true,force:true}); }
});
test('bare_non_tty_exits_2_without_writes', async () => {
  const root = await mkdtemp(join(tmpdir(),'rigup-'));
  try {
    assert.equal(await runCli([], {cwd:root,isTTY:false,write:()=>{}}),2);
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('a TTY can save one approved preview for a later noninteractive apply',()=>project(root=>project(cacheRoot=>project(async stateRoot=>{
 const reports:Record<string,unknown>[]=[];let output='';
 const answers=['2'];const io={cwd:root,isTTY:true,write:(text:string)=>output+=text,read:async()=>answers.shift()??null,services:{cacheRoot,stateRoot,report:(report:Record<string,unknown>)=>reports.push(report)}};
 assert.equal(await runCli(['init','--agents','codex','--sdd','none','--tools','none','--defer-research','--language','auto'],io),3,output);
 const saved=reports.at(-1)!;assert.equal(saved.phase,'handoff');
 assert.match(output,new RegExp(' --apply '+saved.previewId));
 assert.deepEqual(await readdir(root),[]);
 assert.equal(await runCli(['update','--apply',String(saved.previewId),'--dry-run'],{...io,isTTY:false}),2);
 assert.deepEqual(await readdir(root),[]);
 assert.equal(await runCli(['update','--apply',String(saved.previewId),'--sessions-ended'],{...io,isTTY:false}),0,output);
 assert.equal(reports.at(-1)?.previewId,saved.previewId);
}))));

test('preview cancellation and incompatible standalone preparation cannot write the project',t=>project(root=>project(cacheRoot=>project(async stateRoot=>{
 testEnvironment(t,{RIGUP_CONSUMER_PATH:root});
 const io={cwd:root,isTTY:true,write:()=>{},read:async()=>null,services:{cacheRoot,stateRoot}};
 assert.equal(await runCli(['init','--agents','codex','--sdd','none','--tools','none','--defer-research','--language','auto'],io),130);
 assert.equal(await runCli(['init','--agents','codex','--sdd','openspec','--prepare-openspec','--review'],io),2);
 assert.deepEqual(await readdir(root),[]);
}))));

for(const flag of ['--resume','--request','--response'])test('interactive '+flag+' still requires approval for a new preview',()=>project(root=>project(cacheRoot=>project(async stateRoot=>{
 const {access,mkdir,writeFile}=await import('node:fs/promises');
 await mkdir(join(root,'.rigup'));
 await writeFile(join(root,'.rigup','config.yaml'),JSON.stringify({
  agents:['codex'],sdd:'none',projectRules:false,backend:'host',
  mcp:[{id:'docs',agents:['codex'],url:'https://example.org/mcp'}],
 }));
 const args=flag==='--resume'?[flag]:[flag,join(cacheRoot,'host','exchange.json')];
 let output='',reads=0;
 const code=await runCli(['update',...args],{
  cwd:root,isTTY:true,write:text=>output+=text,read:async()=>{reads++;return '3';},services:{cacheRoot,stateRoot},
 });
 assert.equal(code,130,output);assert.equal(reads,1);
 await assert.rejects(access(join(root,'.rigup','manifest.json')),{code:'ENOENT'});
 await assert.rejects(access(join(root,'.codex','config.toml')),{code:'ENOENT'});
}))));

test('plain preview describes zero writes and keeps file bodies in private details',()=>project(root=>project(cacheRoot=>project(async stateRoot=>{
 const {readFile,writeFile}=await import('node:fs/promises');
 let output='',stderr='';
 const io={cwd:root,isTTY:false,write:(text:string)=>output+=text,writeError:(text:string)=>stderr+=text,services:{cacheRoot,stateRoot}};
 const flags=['init','--agents','codex','--sdd','none','--dry-run'];
 assert.equal(await runCli(flags,io),0,output);
 assert.match(output,/Nothing was written to the project/);
 assert.doesNotMatch(output,/owned after/);
 const details=output.match(/^Details: (.+)$/m)?.[1];
 assert.ok(details);assert.ok(details.startsWith(stateRoot));
 assert.match(await readFile(details,'utf8'),/owned after/);
 output='';
 assert.equal(await runCli([...flags,'--json','--verbose'],io),0,output);
 assert.ok(JSON.parse(output).items.some((item:{after?:string})=>item.after));
 assert.match(stderr,/owned after/);
 await rm(join(stateRoot,'details'),{recursive:true});
 await writeFile(join(stateRoot,'details'),'unwritable log location');
 output='';
 assert.equal(await runCli([...flags,'--verbose'],io),0,output);
 assert.match(output,/Details unavailable/);assert.match(output,/owned after/);
 assert.deepEqual(await readdir(root),[]);
}))));

test('read-only command detection skips project binaries and links back into the project',{skip:process.platform==='win32'},t=>project(root=>project(async outside=>{
 const {mkdir,symlink,writeFile,access}=await import('node:fs/promises');
 const {delimiter}=await import('node:path');
 const {detectCommands}=await import('../src/setup-detection.js');
 const bin=join(root,'bin'),userBin=join(outside,'user bin'),called=join(outside,'called');
 await mkdir(bin);await mkdir(userBin);
 const command='#!/bin/sh\n/usr/bin/touch '+JSON.stringify(called)+'\n';
 await writeFile(join(userBin,'claude'),command,{mode:0o755});
 await writeFile(join(bin,'codex'),command,{mode:0o755});
 await symlink(join(bin,'codex'),join(userBin,'codex'));
 testEnvironment(t,{RIGUP_CONSUMER_PATH:['', 'bin',bin,userBin].join(delimiter)});
 const found=await detectCommands(root);
 assert.deepEqual(found.agents,['claude']);
 await assert.rejects(access(called),{code:'ENOENT'});
})));

test('TTY streams use the rendered confirmation and support cancelling with EOF', {timeout:3000}, t=>project(root=>project(cacheRoot=>project(async stateRoot=>{
 const {PassThrough}=await import('node:stream');
 const input=Object.assign(new PassThrough(),{isTTY:true,isRaw:false,setRawMode(value:boolean){this.isRaw=value;}});
 const output=Object.assign(new PassThrough(),{isTTY:true,columns:80,rows:24});
 testEnvironment(t,{CI:'',TERM:'xterm-256color',WT_SESSION:'rigup-test-terminal'});
 let rendered='';
 output.on('data',chunk=>{rendered+=chunk.toString();if(rendered.includes('Continue?')&&!input.writableEnded)input.end();});
 const result=await runCli(['init','--agents','codex','--sdd','none','--tools','none'],{
  cwd:root,isTTY:true,write:text=>output.write(text),terminal:{input,output},services:{cacheRoot,stateRoot},
 });
 assert.equal(result,130,rendered);
 assert.match(rendered,/Continue\?/);assert.match(rendered,/\x1b\[/);
 assert.equal(input.isRaw,false);
 assert.deepEqual(await readdir(root),[]);
}))));

test('interactive preview remains visible beside confirmation when stdout is redirected',()=>project(root=>project(cacheRoot=>project(async stateRoot=>{
 let stdout='',stderr='';
 const code=await runCli(['init','--agents','codex','--sdd','none','--tools','none'],{
  cwd:root,isTTY:true,outputIsTTY:false,write:text=>stdout+=text,writeError:text=>stderr+=text,
  read:async()=>{assert.match(stderr,/Preview [a-f0-9]{64}[\s\S]+Create[\s\S]+Continue\?/);return '3';},
  services:{cacheRoot,stateRoot},
 });
 assert.equal(code,130,stderr);
 assert.equal(stdout,'');assert.deepEqual(await readdir(root),[]);
}))));

test('default interactive setup defers a configured provider before any credentials or research',t=>project(root=>project(cacheRoot=>project(async stateRoot=>{
 const {mkdir,writeFile,readFile}=await import('node:fs/promises');
 await mkdir(join(root,'.rigup'));await writeFile(join(root,'.rigup/config.yaml'),'projectRules: true\n');
 testEnvironment(t,{RIGUP_PROVIDER:'invalid-provider',ANTHROPIC_API_KEY:'test-provider-secret',RIGUP_BASE_URL:'https://gateway.example.test'});
 let reads=0,calls=0,output='';
 const io={cwd:root,isTTY:true,write:(text:string)=>output+=text,read:async()=>{reads++;return reads===1?'':null;},
  services:{cacheRoot,stateRoot,backend:{run:async()=>{calls++;throw Error('unexpected research');}}}};
 const args=['init','--agents','codex','--sdd','none','--tools','none'];
 assert.equal(await runCli(args,io),0,output);
 assert.equal(reads,1);assert.equal(calls,0);
 assert.equal(JSON.parse(await readFile(join(root,'.rigup/manifest.json'),'utf8')).projectRules,'pending');
 output='';
 assert.equal(await runCli(['update','--backend','native','--model','fixture','--review','--json'],io),1,output);
 assert.match(JSON.parse(output).error,/RIGUP_PROVIDER/);assert.equal(calls,0);
}))));

test('explicit SDD none in a profile survives conflicting OpenSpec evidence',t=>project(root=>project(cacheRoot=>project(async stateRoot=>{
 const {mkdir,writeFile}=await import('node:fs/promises');
 await mkdir(join(root,'openspec'));await writeFile(join(root,'openspec/config.yaml'),'schema: spec-driven\n');
 await writeFile(join(root,'setup.yaml'),'agents: [codex]\nsdd: none\n');
 testEnvironment(t,{RIGUP_CONSUMER_PATH:cacheRoot});
 let output='';
 const code=await runCli(['init','--agents','codex','--profile','setup.yaml','--tools','none','--dry-run'],{
  cwd:root,isTTY:true,write:text=>output+=text,read:async()=>'',services:{cacheRoot,stateRoot},
 });
 assert.equal(code,0,output);assert.match(output,/原生 SDD \[Enter: none\]/);
 assert.equal((await readdir(root)).includes('.rigup'),false);
}))));

test('foundation reconfiguration retires only the unselected OpenWiki connection', t=>project(root=>project(cacheRoot=>project(async stateRoot=>{
 const {mkdir,writeFile,readFile}=await import('node:fs/promises');
 await mkdir(join(root,'.rigup'));
 await writeFile(join(root,'.rigup/config.yaml'),JSON.stringify({agents:['codex'],projectRules:true,sdd:'none',tools:[{id:'openwiki',install:false,initialize:false,agents:['codex']}]}));
 testEnvironment(t,{RIGUP_PROVIDER:'anthropic',ANTHROPIC_API_KEY:'rigup-ban-network-fixture'});
 let output='',calls=0;
 const io={cwd:root,isTTY:false,write:(text:string)=>output+=text,services:{cacheRoot,stateRoot,backend:{run:async()=>{
  calls++;return {status:'complete' as const,value:{data:{observations:[],unknowns:[],guidance:[],artifacts:[],dispositions:[]},model:'fixture',unknowns:[],usage:{calls:1,tokens:1}}};
 }}}};
 const invoke=async(args:string[],code:number,interactive=false)=>{
  output='';assert.equal(await runCli(args,interactive?{...io,isTTY:true,read:async()=>null}:io),code,output);
 };
 await invoke(['init','--model','fixture','--json'],0);
 assert.equal(JSON.parse(output).projectRules,'ready');
 const before=calls;
 const flags=['update','--configure','--agents','codex','--sdd','none','--tools','none','--review'];
 await invoke(flags,3,true);
 assert.match(output,/retire mcp:codex:openwiki/i);
 await invoke([...flags,'--retire','mcp:codex:openwiki,entry:AGENTS.md'],1,true);
 assert.match(output,/retirement contradicts selected/);
 await invoke([...flags,'--retire','mcp:codex:openwiki'],3,true);
 const id=output.match(/Preview ([a-f0-9]{64})/)?.[1];assert.ok(id);
 await invoke(['update','--apply',id,'--sessions-ended','--json'],0);
 assert.equal(JSON.parse(output).projectRules,'ready');assert.equal(calls,before);
 assert.match(await readFile(join(root,'.rigup/config.yaml'),'utf8'),/"?tools"?:\s*\[\s*\]/);
 const mcp=await readFile(join(root,'.codex/config.toml'),'utf8');
 assert.doesNotMatch(mcp,/mcp_servers.openwiki/);assert.match(mcp,/mcp_servers.rigup/);
}))));

test('bare_tty_routes_by_project_state',()=>project(async root=>{
 let output='';const answers=['1','1','4','3',''];
 const code=await runCli([],{cwd:root,isTTY:true,write:s=>output+=s,read:async()=>answers.shift()??null});
 assert.equal(code,0,output);assert.match(output,/init:/);
}));
test('eof_never_confirms', async () => {
 let output='';
 assert.equal(await runCli([], {cwd:tmpdir(),isTTY:true,write:(s:string)=>output+=s,read:async()=>null}),130);
 assert.doesNotMatch(output,/init: 尚未实现/);
});
test('damaged_manifest_is_not_fresh_project', async () => {
 const {mkdir,writeFile,readFile}=await import('node:fs/promises');
 const root=await mkdtemp(join(tmpdir(),'rigup-'));
 try {
  await mkdir(join(root,'.rigup')); await writeFile(join(root,'.rigup/manifest.json'),'{broken');
  let output='';
  assert.equal(await runCli(['init'],{cwd:root,isTTY:false,write:(s:string)=>output+=s}),1);
  assert.match(output,/manifest/); assert.doesNotMatch(output,/init: 尚未实现/);
  assert.equal(await readFile(join(root,'.rigup/manifest.json'),'utf8'),'{broken');
 } finally {await rm(root,{recursive:true,force:true});}
});
test('init_existing_manifest_uses_update_rules_and_doctor_is_read_only', async () => {
 const {mkdir,writeFile,readFile}=await import('node:fs/promises');
 const root=await mkdtemp(join(tmpdir(),'rigup-'));
 const original='{"schemaVersion":1,"installId":"fixture","assets":[]}';
 try {
  await mkdir(join(root,'.rigup'));await writeFile(join(root,'.rigup/manifest.json'),original);
  for(const [args,expected] of [[['init'],'update'],[['doctor'],'doctor']] as const){
   let out='';assert.equal(await runCli([...args],{cwd:root,isTTY:false,write:(s:string)=>out+=s}),3);
   assert.match(out,new RegExp(expected+':'));
   assert.equal(await readFile(join(root,'.rigup/manifest.json'),'utf8'),original);
  }
 } finally {await rm(root,{recursive:true,force:true});}
});
import {confirmedHarnessSource,project,testEnvironment,writeOpenSpecFixture} from './helpers.js';
import {fixedNpmView} from './native-tool-fixture.js';
test('tools flag keeps OpenWiki generation separate from protected CodeGraph initialization',t=>project(async root=>project(async cache=>project(async state=>{
 testEnvironment(t,{RIGUP_CONSUMER_PATH:''});
 const calls:string[]=[];
 let output='';const code=await runCli(['init','--tools','openwiki,codegraph','--dry-run','--json'],{cwd:root,isTTY:false,write:s=>output+=s,services:{cacheRoot:cache,stateRoot:state,npmView:async(args,cwd)=>{
  calls.push(args[1]);return JSON.stringify({...JSON.parse(await fixedNpmView(args,cwd)),version:'2.0.0','dist-tags.latest':'2.0.0'});
 }}});
 assert.equal(code,0,output);const report=JSON.parse(output);assert.equal(report.executable,true);assert.deepEqual(report.operations.map((o:any)=>o.id),['install:openwiki','install:codegraph','initialize:codegraph']);assert.ok(report.warnings.some((w:string)=>/openwiki_begin/.test(w)));assert.deepEqual(await readdir(root),[]);
 assert.deepEqual(calls,['openwiki@latest','@colbymchenry/codegraph@latest']);
 assert.ok(report.operations.every((operation:any)=>operation.version==='2.0.0'));
 assert.equal(report.operations[0].registry,'https://registry.npmjs.org/');
}))));
test('missing OpenSpec bindings return a copyable recovery command without applying',()=>project(async root=>project(async cache=>project(async state=>{
 let output='';const code=await runCli(['init','--agents','codex','--sdd','openspec','--defer-research','--json'],{cwd:root,isTTY:false,write:s=>output+=s,services:{cacheRoot:cache,stateRoot:state}});
 assert.equal(code,3);const report=JSON.parse(output);assert.equal(report.executable,false);
 assert.match(report.nextCommand,/--agents codex --sdd openspec --prepare-openspec/);
 assert.match(report.resumeCommand,/--agents codex --sdd openspec --defer-research/);
 assert.deepEqual(await readdir(root),[]);
}))));
test('explicit_dry_run_and_preflight_missing_inputs_never_call_backend_or_write_project',()=>project(async root=>project(async cache=>project(async state=>{
 let calls=0;const io={cwd:root,isTTY:false,write:()=>{},services:{cacheRoot:cache,stateRoot:state,backend:{run:async()=>{calls++;throw Error('unexpected research');}}}};
 assert.equal(await runCli(['init','--agents','codex','--dry-run'],io),0);assert.equal(calls,0);assert.deepEqual(await readdir(root),[]);
 const {mkdir,writeFile}=await import('node:fs/promises');await mkdir(root+'/.rigup');await writeFile(root+'/.rigup/config.yaml','agents: []\n');
 assert.equal(await runCli(['init'],io),3);assert.equal(calls,0);
}))));
test('continuous_run_never_prompts_after_start',()=>project(async root=>project(async cache=>project(async state=>{
 let reads=0;const code=await runCli(['init','--agents','codex'],{cwd:root,isTTY:false,write:()=>{},read:async()=>{reads++;throw Error('stdin removed');},services:{cacheRoot:cache,stateRoot:state}});assert.equal(code,0);assert.equal(reads,0);
}))));
test('host_pending_returns_3_and_preserves_project_bytes',()=>project(async root=>project(async cache=>project(async state=>{
 const before=await readdir(root);let output='';const code=await runCli(['init','--agents','codex','--sdd','openspec','--backend','host','--dry-run'],{cwd:root,isTTY:false,write:s=>output+=s,services:{cacheRoot:cache,stateRoot:state}});assert.equal(code,3);assert.match(output,/Pending host research/);assert.deepEqual(await readdir(root),before);
}))));
test('review_mode_waits_only_when_selected',()=>project(async root=>project(async cache=>project(async state=>{
 let out='';assert.equal(await runCli(['init','--agents','codex','--review'],{cwd:root,isTTY:false,write:s=>out+=s,services:{cacheRoot:cache,stateRoot:state}}),3);assert.match(out,/--apply/);assert.deepEqual(await readdir(root),[]);
}))));
test('continuation_rejects_changed_inputs_without_project_writes',()=>project(async root=>project(async cache=>project(async state=>{
 const {writeFile}=await import('node:fs/promises');let out='';const io={cwd:root,isTTY:false,write:(s:string)=>out+=s,services:{cacheRoot:cache,stateRoot:state}};assert.equal(await runCli(['init','--agents','codex','--sdd','openspec','--backend','host','--dry-run'],io),3);const id=out.match(/--continue ([a-f0-9]{64})/)![1];await writeFile(root+'/new.ts','changed');out='';assert.equal(await runCli(['update','--continue',id],io),1);assert.match(out,/changed/);assert.deepEqual(await readdir(root),['new.ts']);
}))));
test('apply_id_cannot_redirect_cli_to_a_different_project_root',()=>project(async root=>project(async other=>project(async cache=>project(async state=>{
 const {preview}=await import('../src/installer/preview.js');const {scanRepository}=await import('../src/analyzer/repository.js');const options={agents:[],backend:'host' as const};const p=await preview({root:other,fingerprint:(await scanRepository(other,options)).fingerprint,options,assets:[{logicalId:'a',target:'other.md',content:'must not write',ownership:{kind:'file'},source:{kind:'test',ref:'test'}}],operations:[],dispositions:[],warnings:[],requirements:[],versions:{}},[],{cacheRoot:cache+'/previews'});let out='';assert.equal(await runCli(['update','--apply',p.previewId,'--sessions-ended'],{cwd:root,isTTY:false,write:s=>out+=s,services:{cacheRoot:cache,stateRoot:state}}),1);assert.match(out,/root|project/);assert.deepEqual(await readdir(other),[]);
})))));


test('first_run_with_only_a_backend_still_guides_missing_agents_and_sdd',()=>project(async root=>project(async cache=>project(async state=>{
 const {readFile}=await import('node:fs/promises');const answers=['1','1','3'];const reports:Record<string,any>[]=[];let output='';
 const code=await runCli(['init','--backend','host'],{cwd:root,isTTY:true,write:s=>output+=s,read:async()=>answers.shift()??null,services:{cacheRoot:cache,stateRoot:state,report:r=>reports.push(r)}});
 assert.equal(code,3,output);assert.equal(answers.length,0);const paused=reports.find(r=>r.requestPath);assert.ok(paused,'interactive selections must reach actual host research');
 const request=JSON.parse(await readFile(paused.requestPath,'utf8'));assert.deepEqual(request.context.options.agents,['claude']);assert.equal(request.context.options.sdd,'superpowers');assert.equal(request.context.options.backend,'host');assert.equal(request.context.root,root);assert.deepEqual(await readdir(root),[]);
}))));

test('interactive_agent_selection_preserves_explicit_sdd_and_tool_arguments',()=>project(async root=>project(async cache=>project(async state=>{
 const {readFile}=await import('node:fs/promises');const answers=['1'];const reports:Record<string,any>[]=[];let output='';
 const code=await runCli(['init','--sdd','openspec','--tools','none','--backend','host','--language','zh-cn','--dry-run'],{cwd:root,isTTY:true,write:s=>output+=s,read:async()=>answers.shift()??null,services:{cacheRoot:cache,stateRoot:state,report:r=>reports.push(r)}});
 assert.equal(code,3,output);assert.equal(answers.length,0);const paused=reports.find(r=>r.requestPath);assert.ok(paused);
 const request=JSON.parse(await readFile(paused.requestPath,'utf8'));assert.deepEqual(request.context.options.agents,['claude']);assert.equal(request.context.options.sdd,'openspec');assert.equal(request.context.options.tools,undefined);assert.equal(request.context.options.documentLanguage,'zh-CN');assert.deepEqual(await readdir(root),[]);
}))));

test('explicit_first_run_selections_do_not_need_reentering_in_a_terminal',()=>project(async root=>project(async cache=>project(async state=>{
 let output='';const code=await runCli(['init','--agents','claude','--sdd','none','--tools','none','--dry-run'],{cwd:root,isTTY:true,write:s=>output+=s,read:async()=>{throw Error('Explicit choices must not be asked again');},services:{cacheRoot:cache,stateRoot:state}});
 assert.equal(code,0,output);assert.deepEqual(await readdir(root),[]);
}))));


test('partial_native_api_key_reference_reaches_the_tty_model_and_secret_guide',()=>project(async root=>project(async cache=>project(async state=>{
 const previousModel=process.env.ANTHROPIC_MODEL;const previousKey=process.env.RIGUP_TEST_NAMED_API_KEY;delete process.env.ANTHROPIC_MODEL;delete process.env.RIGUP_TEST_NAMED_API_KEY;
 try{let output='';const answers=['fixture-model',null];const reads:boolean[]=[];
  const code=await runCli(['init','--agents','claude','--sdd','openspec','--tools','none','--api-key-env','RIGUP_TEST_NAMED_API_KEY','--dry-run'],{cwd:root,isTTY:true,write:s=>output+=s,read:async secret=>{reads.push(!!secret);return answers.shift()??null;},services:{cacheRoot:cache,stateRoot:state}});
  assert.equal(code,130,output);assert.deepEqual(reads,[false,true]);assert.match(output,/RIGUP_TEST_NAMED_API_KEY/);assert.deepEqual(await readdir(root),[]);
 }finally{if(previousModel===undefined)delete process.env.ANTHROPIC_MODEL;else process.env.ANTHROPIC_MODEL=previousModel;if(previousKey===undefined)delete process.env.RIGUP_TEST_NAMED_API_KEY;else process.env.RIGUP_TEST_NAMED_API_KEY=previousKey;}
}))));

test('OpenSpec preparation reports the required session acknowledgement in JSON',t=>project(root=>project(async bin=>{
 const {delimiter}=await import('node:path');
 await writeOpenSpecFixture(bin,'console.log(process.argv.includes("--version")?"1.16.0":JSON.stringify({root:null}));');
 const path=process.env.PATH;
 process.env.PATH=bin+delimiter+path;
 t.after(()=>{process.env.PATH=path;});
 const original=process.env.CLAUDECODE;
 process.env.CLAUDECODE='1';
 t.after(()=>{if(original===undefined)delete process.env.CLAUDECODE;else process.env.CLAUDECODE=original;});
 t.mock.method(process,'cwd',()=>root);
 let output='';
 const code=await runCli(['init','--agents','claude','--sdd','openspec','--prepare-openspec','--json'],{
  cwd:root,isTTY:false,write:s=>output+=s,
 });
 const report=JSON.parse(output);
 assert.equal(code,3,output);
 assert.equal(report.nextCommand,report.resumeCommand);
 assert.match(report.nextCommand,/--prepare-openspec --sessions-ended$/);
 assert.ok(report.requiredInput.some((item:string)=>item.includes('--sessions-ended')));
 assert.deepEqual(await readdir(root),[]);
})));

test('CLI list options accept PowerShell array strings, split args and repeated flags',t=>project(root=>project(cache=>project(async state=>{
 testEnvironment(t,{RIGUP_CONSUMER_PATH:''});
 for(const args of [
  ['--agents','claude codex','--tools','openwiki codegraph'],
  ['--agents','claude','codex','--tools','openwiki','codegraph'],
  ['--agents=claude,codex','--tools=openwiki','--tools','codegraph'],
 ]){
  let output='';
  const code=await runCli(['init','.',...args,'--dry-run','--json'],{cwd:root,isTTY:false,write:s=>output+=s,services:{cacheRoot:cache,stateRoot:state,npmView:fixedNpmView}});
  assert.equal(code,0,output);
  const report=JSON.parse(output);
  assert.deepEqual(report.operations.map((op:{id:string})=>op.id),['install:openwiki','install:codegraph','initialize:codegraph']);
  assert.ok(report.items.some((item:{target:string})=>item.target==='.mcp.json'));
  assert.ok(report.items.some((item:{target:string})=>item.target==='.codex/config.toml'));
 }
 let output='';
 const code=await runCli(['init','--tools','unknown','--json'],{cwd:root,isTTY:false,write:s=>output+=s});
 assert.equal(code,2);
 assert.match(JSON.parse(output).error,/--tools.*PowerShell.*quotes/);
}))));

test('review returns up-to-date for an unchanged rules-disabled installation',()=>project(root=>project(cache=>project(async state=>{
 const {mkdir,readFile,writeFile}=await import('node:fs/promises');
 const invoke=async(...args:string[])=>{
  let output='';
  const code=await runCli([...args,'--json'],{cwd:root,isTTY:false,write:s=>output+=s,services:{cacheRoot:cache,stateRoot:state}});
  return {code,...JSON.parse(output)};
 };
 await mkdir(join(root,'.rigup'));
 await writeFile(join(root,'.rigup','config.yaml'),'agents: [claude]\nprojectRules: false\n');
 assert.equal((await invoke('init')).code,0);
 const manifestPath=join(root,'.rigup','manifest.json');
 const current=await readFile(manifestPath,'utf8');
 const unchanged=await invoke('update','--review');
 assert.equal(unchanged.code,0,JSON.stringify(unchanged));
 assert.equal(unchanged.installStatus,'up-to-date');
 assert.equal(unchanged.nextCommand,null);
 assert.ok(!unchanged.previewId);
 assert.equal(await readFile(manifestPath,'utf8'),current);
}))));

test('harness CLI reviews restored approved authority without provider or file changes',()=>project(root=>project(cache=>project(async state=>{
 const {readFile,writeFile}=await import('node:fs/promises');
 const options={agents:['codex' as const],backend:'host' as const,projectRules:true,scope:['api']};
 const {path,body}=await confirmedHarnessSource(root,options);
 await writeFile(join(root,'profile.json'),JSON.stringify({...options,projectConventions:{topics:[{id:'api-errors',title:'API errors',scope:['api'],source:path}]}}));
 const invoke=async(args:string[],backend?:import('../src/analyzer/backend.js').AnalysisBackend)=>{
  let output='';
  const code=await runCli([...args,'--json'],{cwd:root,isTTY:false,write:s=>output+=s,services:{cacheRoot:cache,stateRoot:state,backend}});
  return {code,...JSON.parse(output)};
 };
 const prepared=await invoke(['init','--profile','profile.json','--backend','host','--sdd','none','--review'],{run:async()=>({status:'complete',value:{
  model:'fixture',unknowns:[],usage:{calls:1,tokens:1},data:{observations:[],guidance:[],artifacts:[],dispositions:[]},
 }})});
 assert.equal(prepared.projectRules,'ready',JSON.stringify(prepared));
 const applyPreview=(id:string)=>invoke(['update','--apply',id,'--sessions-ended']);
 assert.equal((await applyPreview(prepared.previewId)).code,0);
 const original=await readFile(join(root,path),'utf8');
 await writeFile(join(root,path),original.replace(body,'Use a different response contract.'));
 assert.equal((await applyPreview(prepared.previewId)).projectRules,'pending');
 const changed=await invoke(['update','--review']);
 assert.equal(changed.projectRules,'pending');
 await writeFile(join(root,path),original);
 const reconciled=await invoke(['update','--review']);
 assert.ok(reconciled.previewId);
 assert.notEqual(reconciled.previewId,prepared.previewId);
 assert.equal(reconciled.projectRules,'ready');
 assert.equal((await applyPreview(changed.previewId)).code,1);
 const approved=await applyPreview(reconciled.previewId);
 assert.equal(approved.code,0,JSON.stringify(approved));
 assert.deepEqual(approved.written,[]);
 assert.equal((await invoke(['doctor'])).projectRules,'ready');
 const unchanged=await invoke(['update','--review']);
 assert.equal(unchanged.installStatus,'up-to-date');
 assert.equal(unchanged.previewId,undefined);
 assert.equal(await readFile(join(root,path),'utf8'),original);
}))));

test('claude,omp Superpowers actual project sources produce an executable preview and separate apply',()=>project(async root=>project(async cache=>project(async state=>{
 const {mkdir,writeFile,readFile}=await import('node:fs/promises');
 for(const host of ['.claude','.omp'])for(const name of ['brainstorming','writing-plans','executing-plans','verification-before-completion']){
  const path=join(root,host,'skills',name);await mkdir(path,{recursive:true});
  await writeFile(join(path,'SKILL.md'),`---\nname: ${name}\ndescription: Native workflow\n---\nUse native approvals.\n`);
 }
 await writeFile(join(root,'user.txt'),'preserve');
 let output='';const io={cwd:root,isTTY:false,write:(s:string)=>output+=s,services:{cacheRoot:cache,stateRoot:state}};
 const code=await runCli(['init','--agents','claude,omp','--sdd','superpowers','--defer-research','--review','--json'],io);
 const report=JSON.parse(output);assert.equal(report.executable,true,output);assert.equal(code,3);
 output='';assert.equal(await runCli(['update','--apply',report.previewId,'--sessions-ended','--json'],io),0,output);
 assert.equal(JSON.parse(output).status,'complete');
 for(const host of ['.claude','.omp'])for(const stage of ['prepare','ready','deliver']){
  const content=await readFile(join(root,host,'skills','change-'+stage,'references/project.md'),'utf8');
  assert.match(content,/Native prepare: brainstorming, writing-plans/);assert.match(content,/Native deliver: executing-plans, verification-before-completion/);
 }
 assert.equal(await readFile(join(root,'user.txt'),'utf8'),'preserve');
}))));

for(const mutation of ['skill','manifest','entry','path','disable'] as const)for(const interrupted of [false,true])test(`native ${mutation} replacement rejects ${interrupted?'interrupted recovery':'saved apply'} before further project writes`,t=>project(root=>project(cache=>project(state=>project(async home=>{
 const {mkdir,writeFile,readFile,rename}=await import('node:fs/promises');const {apply}=await import('../src/installer/apply.js');
 const omp=join(home,'agent'),plugin=join(omp,'plugins/node_modules/omp-superpowers');
 testEnvironment(t,{PI_CODING_AGENT_DIR:omp});
 await mkdir(join(plugin,'extensions'),{recursive:true});await writeFile(join(plugin,'extensions/superpowers.ts'),'export default function() {}');
 await writeFile(join(plugin,'package.json'),'{"name":"omp-superpowers","version":"0.1.0","omp":{"extensions":["./extensions/superpowers.ts"]}}');
 await writeFile(join(omp,'plugins/package.json'),'{"dependencies":{"omp-superpowers":"0.1.0"}}');
 for(const name of ['brainstorming','writing-plans','executing-plans','verification-before-completion']){const path=join(plugin,'skills',name);await mkdir(path,{recursive:true});await writeFile(join(path,'SKILL.md'),`---\nname: ${name}\ndescription: Native\n---\nNative gates\n`);}
 await writeFile(join(root,'user.txt'),'preserve');
 let output='';const io={cwd:root,isTTY:false,write:(s:string)=>output+=s,services:{cacheRoot:cache,stateRoot:state}};
 assert.equal(await runCli(['init','--agents','omp','--sdd','superpowers','--defer-research','--review','--json'],io),3,output);
 const review=JSON.parse(output);assert.equal(review.executable,true,output);
 const dependencies={cacheRoot:join(cache,'previews'),stateRoot:state};
 if(interrupted)await assert.rejects(()=>apply(review.previewId,{...dependencies,hook:async point=>{if(point==='after-file')throw Error('test interrupted after one write');}}),/test interrupted/);
 const snapshot=async()=>{const paths=await readdir(root,{recursive:true});return Promise.all(paths.sort().map(async path=>[path,await readFile(join(root,path),'base64').catch(()=>null)]));};
 const before=await snapshot();
 if(mutation==='skill')await writeFile(join(plugin,'skills/brainstorming/SKILL.md'),'---\nname: brainstorming\ndescription: Changed\n---\n');
 if(mutation==='manifest')await writeFile(join(plugin,'package.json'),'{"name":"omp-superpowers","version":"0.1.1","omp":{"extensions":["./extensions/superpowers.ts"]}}');
 if(mutation==='entry')await writeFile(join(plugin,'extensions/superpowers.ts'),'export default function(){return 1;}');
 if(mutation==='path')await rename(join(plugin,'skills/brainstorming'),join(plugin,'skills/moved'));
 if(mutation==='disable')await writeFile(join(omp,'plugins/omp-plugins.lock.json'),'{"plugins":{"omp-superpowers":{"enabled":false}}}');
 await assert.rejects(()=>apply(review.previewId,{...dependencies,recover:interrupted}),/source.*changed|snapshot|input/i);
 assert.deepEqual(await snapshot(),before);
})))));

for(const scenario of ['missing-claude','missing-omp','missing-both','conflict','cancel'] as const)test(`claude,omp ${scenario} preserves user files`,()=>project(root=>project(cacheRoot=>project(async stateRoot=>{
 const {mkdir,writeFile,readFile}=await import('node:fs/promises');
 for(const host of ['claude','omp'])if(scenario!=='missing-both'&&scenario!=='missing-'+host)for(const name of ['brainstorming','writing-plans','executing-plans','verification-before-completion']){
  const path=join(root,'.'+host,'skills',name);await mkdir(path,{recursive:true});await writeFile(join(path,'SKILL.md'),`---\nname: ${name}\ndescription: Native workflow\n---\nKeep native approvals.`);
 }
 if(scenario==='conflict'){const path=join(root,'.omp/skills/duplicate/brainstorming');await mkdir(path,{recursive:true});await writeFile(join(path,'SKILL.md'),'---\nname: brainstorming\ndescription: Conflicting workflow\n---\nDifferent requirements');}
 await writeFile(join(root,'user.txt'),'User work');const before=await readdir(root,{recursive:true});
 let output='';const code=await runCli(['init','--agents','claude,omp','--sdd','superpowers','--tools','none','--defer-research','--language','auto',...(scenario==='cancel'?[]:['--json'])],{cwd:root,isTTY:scenario==='cancel',read:async()=>null,write:s=>output+=s,services:{cacheRoot,stateRoot}});
 if(scenario==='cancel')assert.equal(code,130,output);
 else {assert.equal(code,3,output);const report=JSON.parse(output);assert.equal(report.executable,false);assert.match(output,scenario==='conflict'?/omp.*conflict/:/missing native entry:/);}
 assert.deepEqual(await readdir(root,{recursive:true}),before);assert.equal(await readFile(join(root,'user.txt'),'utf8'),'User work');
}))));
