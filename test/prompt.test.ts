import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {promptChoice,ChoiceState,terminalReader} from '../src/prompt.js';
import {terminalUI} from '../src/terminal-ui.js';
import {withLocale} from '../src/i18n/index.js';
import {testEnvironment} from './helpers.js';
import {promptNativeCredentials} from '../src/onboarding.js';
test('plain_terminal_uses_numbered_input',async()=>{
 let output='';
 assert.deepEqual(await promptChoice({write:s=>output+=s,read:async()=> '1,3'},['claude','codex','omp']),['claude','omp']);
 assert.match(output,/1\. claude/);assert.doesNotMatch(output,/\x1b/);
});
test('secret_input_never_echoes',async()=>{
 let output=''; let hidden=false;
 assert.equal(await promptChoice({write:s=>output+=s,read:async secret=>{hidden=!!secret;return 'secret-value';}},[],true),'secret-value');
 assert.equal(hidden,true);assert.doesNotMatch(output,/secret-value/);
});
test('back_invalidates_dependent_choices',()=>{
 const state=new ChoiceState(); state.set('agents',['claude']); state.set('sdd','superpowers');state.set('model','selected');
 state.back('agents');assert.equal(state.get('sdd'),undefined);assert.equal(state.get('model'),undefined);
});
test('prompt_eof_and_escape_never_confirm',async()=>{
 for(const input of [null,'\x1b']) assert.equal(await promptChoice({write:()=>{},read:async()=>input},['yes','no']),null);
});
test('numbered multi-select retries invalid input and accepts common separators',async()=>{
 for(const selection of ['1，3','1、3','1 3']){
  const answers=['4',selection];let output='';
  assert.deepEqual(await promptChoice({write:s=>output+=s,read:async()=>answers.shift()??null},['claude','codex','omp']),['claude','omp']);
  assert.match(output,/invalid/i);
 }
});
test('raw input echoes through its writer and cancels if EOF arrives between reads',async()=>{
 const input=Object.assign(new PassThrough(),{isTTY:true,isRaw:false,setRawMode(raw:boolean){this.isRaw=raw;}});
 let output='';
 const read=terminalReader(input,s=>output+=s);
 const first=read();input.write('2\r');assert.equal(await first,'2');
 const ended=new Promise<void>(resolve=>input.once('end',resolve));input.end();input.resume();await ended;
 assert.equal(await read(),null);
 assert.equal(input.isRaw,false);assert.equal(output,'2\n');
});
test('an interrupt settles a pending line prompt and restores raw mode',{timeout:1000},async()=>{
 const input=Object.assign(new PassThrough(),{isTTY:true,isRaw:false,setRawMode(raw:boolean){this.isRaw=raw;}});
 const controller=new AbortController();
 const read=terminalReader(input,undefined,controller.signal);
 const pending=read();
 assert.equal(input.isRaw,true);
 controller.abort();
 assert.equal(await pending,null);
 assert.equal(input.isRaw,false);
 assert.equal(await read(),null);
});
test('native_input_adapter_consumes_lines_and_eof',async()=>{
 const {PassThrough}=await import('node:stream');
 const {terminalReader}=await import('../src/prompt.js');
 const input=new PassThrough();const read=terminalReader(input);
 input.end('1,2\n');
 assert.equal(await read(),'1,2');assert.equal(await read(),null);
});
test('native_secret_reader_restores_raw_mode_without_output',async()=>{
 const {PassThrough}=await import('node:stream');
 const {terminalReader}=await import('../src/prompt.js');
 const input=new PassThrough() as import('node:stream').PassThrough & {isTTY:boolean;isRaw:boolean;setRawMode(raw:boolean):void};
 input.isTTY=true;input.isRaw=false;input.setRawMode=raw=>{input.isRaw=raw;};
 const result=terminalReader(input)(true);
 input.write('hidden\r');assert.equal(await result,'hidden');assert.equal(input.isRaw,false);
});
test('legacy native model entry can reuse an explicitly named key from the environment',async t=>{
 testEnvironment(t,{RIGUP_TEST_LEGACY_KEY:'fixture'});
 const reads:boolean[]=[];
 const result=await promptNativeCredentials({agents:['codex'],backend:'native'},{
  write:()=>{},read:async secret=>{reads.push(!!secret);return secret?null:'fixture-model';},
 },undefined,{RIGUP_API_KEY_ENV:'RIGUP_TEST_LEGACY_KEY'});
 assert.equal(result?.model,'fixture-model');assert.deepEqual(reads,[false]);
});

test('rendered choices reuse preselection, Space, Back and keyboard cancellation',{timeout:2000},async t=>{
 testEnvironment(t,{CI:'',TERM:'xterm-256color',WT_SESSION:'rigup-test-terminal'});
 const input=Object.assign(new PassThrough(),{isTTY:true,isRaw:false,setRawMode(raw:boolean){this.isRaw=raw;}});
 const output=Object.assign(new PassThrough(),{isTTY:true,columns:80});
 let rendered='';
 output.on('data',chunk=>rendered+=chunk.toString());
 const ui=terminalUI({input,output})!;
 const tools=ui.ask({message:'Tools',choices:['openwiki','codegraph'],defaults:['openwiki'],multiple:true,empty:true});
 input.write(' \r');assert.deepEqual(await tools,[]);
 const sdd=withLocale('zh-CN',()=>ui.ask({message:'SDD',choices:[{value:'none',label:'无'}],back:true}));
 input.write('\x1b[B\r');assert.equal(await sdd,'back');
 assert.match(rendered,/返回/);
 for(const key of ['\x03','\x1b','\x04']){
  const next=ui.ask({message:'Continue?',choices:['Install','Cancel']});
  input.write(key);assert.equal(await next,null);assert.equal(input.isRaw,false);
 }
 input.destroy();output.destroy();
});
