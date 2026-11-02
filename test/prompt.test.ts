import {test} from 'node:test';
import assert from 'node:assert/strict';
import {promptChoice,ChoiceState} from '../src/prompt.js';
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
