import assert from 'node:assert/strict';
import {access,mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {test} from 'node:test';
import {runCli,type CliIO} from '../src/cli.js';
import {resolveLocale,t as message,withLocale} from '../src/i18n/index.js';
import {en} from '../src/i18n/en.js';
import {zhCN} from '../src/i18n/zh-CN.js';
import {project,testEnvironment} from './helpers.js';

test('language resolution follows explicit tags and then the first system locale',()=>{
 const chinese={LANG:'zh_CN.UTF-8'};
 assert.equal(resolveLocale('zh-Hant',{}),'zh-CN');
 assert.equal(resolveLocale('en-US',chinese),'en');
 assert.equal(resolveLocale('ja',chinese),'en');
 assert.equal(resolveLocale('auto',chinese),'zh-CN');
 assert.equal(resolveLocale(undefined,{...chinese,LC_MESSAGES:'C'}),'en');
 assert.equal(resolveLocale('auto',{LC_ALL:'zh_CN.UTF-8',LC_MESSAGES:'C',LANG:'C'}),'zh-CN');
 assert.ok(['en','zh-CN'].includes(resolveLocale(undefined,{})));
});

test('both message catalogues use the same parameter names',()=>{
 const params=(text:string)=>[...new Set([...text.matchAll(/\{(\w+)\}/g)].map(match=>match[1]))].sort();
 for(const key of Object.keys(en) as (keyof typeof en)[]){
  assert.ok(zhCN[key].trim(),key);
  assert.deepEqual(params(zhCN[key]),params(en[key]),key);
 }
 assert.equal(withLocale('en',()=>message('result.needsAction')),'Needs action');
 assert.equal(withLocale('zh-CN',()=>message('openspec.resumeSelection',{agents:'codex, omp'})),'继续已选的 OpenSpec 设置（codex, omp）');
 assert.match(message('openspec.resumeSelection'),/\{agents\}/);
});

test('the wizard asks language first and saves the selection without creating config.yaml',t=>project(root=>project(cacheRoot=>project(async stateRoot=>{
 testEnvironment(t,{LC_ALL:'zh_CN.UTF-8',LC_MESSAGES:'en_US.UTF-8'});
 const questions:string[]=[];
 let output='';
 const io:CliIO={cwd:root,isTTY:true,write:text=>output+=text,ask:async question=>{
  questions.push(question.message);
  if(questions.length===1){
   assert.deepEqual(question.choices,[{value:'zh-CN',label:'中文'},{value:'en',label:'English'}]);
   assert.deepEqual(question.defaults,['zh-CN']);
   assert.equal(question.back,undefined);
   return ['zh-CN'];
  }
  if(questions.length===2){assert.match(question.message,/目标/);return ['codex'];}
  assert.match(question.message,/继续/);
  return ['Install'];
 },services:{cacheRoot,stateRoot}};
 assert.equal(await runCli(['init','--sdd','none','--tools','none'],io),0,output);
 assert.equal(questions.length,3);
 assert.equal(JSON.parse(await readFile(join(root,'.rigup','manifest.json'),'utf8')).options.documentLanguage,'zh-CN');
 await assert.rejects(access(join(root,'.rigup','config.yaml')),{code:'ENOENT'});
 testEnvironment(t,{LC_ALL:'C'});
 output='';
 assert.equal(await runCli([], {...io,ask:async question=>{
  assert.deepEqual(question.choices[0],{value:'update',label:'更新'});
  return ['exit'];
 }}),130);
 assert.equal(await runCli(['update','--dry-run'],{...io,isTTY:false}),0,output);
 assert.match(output,/^更新: /);
 assert.match(output,/结果: /);
}))));

test('an explicit non-UI language bypasses the question and persists through configure',t=>project(root=>project(cacheRoot=>project(async stateRoot=>{
 testEnvironment(t,{LC_ALL:'zh_CN.UTF-8'});
 const questions:string[]=[];
 let output='';
 assert.equal(await runCli(['init','--configure','--language','ja','--agents','codex','--sdd','none','--tools','none'],{
  cwd:root,isTTY:true,write:text=>output+=text,ask:async question=>{questions.push(question.message);return ['Install'];},
  services:{cacheRoot,stateRoot},
 }),0,output);
 assert.deepEqual(questions,['Continue?']);
 assert.match(output,/^init: /);
 assert.doesNotMatch(output,/\p{Script=Han}/u);
 assert.match(await readFile(join(root,'.rigup','config.yaml'),'utf8'),/^documentLanguage: ja$/m);
 assert.equal(JSON.parse(await readFile(join(root,'.rigup','manifest.json'),'utf8')).options.documentLanguage,'ja');
}))));

test('applying a saved preview starts in the preview language and rejects an override',()=>project(root=>project(cacheRoot=>project(async stateRoot=>{
 let output='',report:Record<string,unknown>={};
 const io:CliIO={cwd:root,isTTY:false,write:text=>output+=text,services:{cacheRoot,stateRoot,report:value=>{report=value;}}};
 await mkdir(join(root,'.rigup'));
 await writeFile(join(root,'.rigup','config.yaml'),'documentLanguage: en\n');
 assert.equal(await runCli(['init','--language','zh-CN','--sdd','none','--dry-run'],io),0,output);
 const id=String(report.previewId);
 assert.match(id,/^[a-f0-9]{64}$/);
 output='';
 assert.equal(await runCli(['update','--apply',id,'--language','en'],io),2,output);
 assert.match(output,/prepare a new preview to change the document language/);
 output='';
 const result=await runCli(['update','--apply',id],io);
 assert.match(output,/^更新: /);
 assert.match(output,/结果: /);
 assert.equal(result,0,output);
}))));

test('profile language applies before the header and project configuration takes precedence',()=>project(root=>project(cacheRoot=>project(async stateRoot=>{
 await mkdir(join(root,'.rigup'));
 await writeFile(join(root,'profile.yaml'),'documentLanguage: zh-CN\nagents: [codex]\n');
 const settings=join(root,'.rigup','config.yaml');
 await writeFile(settings,'profile: profile.yaml\n');
 let output='';
 const io:CliIO={cwd:root,isTTY:false,write:text=>output+=text,services:{cacheRoot,stateRoot}};
 assert.equal(await runCli(['update','--dry-run'],io),0,output);
 assert.match(output,/^更新: /);
 await writeFile(settings,'profile: profile.yaml\ndocumentLanguage: en\n');
 output='';
 assert.equal(await runCli(['doctor'],io),3,output);
 assert.match(output,/^doctor: /);
}))));

test('help follows a language flag after --help',t=>project(async root=>{
 testEnvironment(t,{LC_ALL:'C'});
 let output='';
 assert.equal(await runCli(['--help','--language','zh-CN'],{cwd:root,isTTY:false,write:text=>output+=text}),0);
 assert.match(output,/互动|交互/);
 assert.match(output,/rigup doctor/);
}));

test('an argument error uses the saved project locale and keeps the original JSON error',()=>project(async root=>{
 await mkdir(join(root,'.rigup'));
 await writeFile(join(root,'.rigup','config.yaml'),'documentLanguage: zh-CN\n');
 let stdout='',stderr='';
 const exit=await runCli(['doctor','--unknown','--json'],{
  cwd:root,isTTY:false,write:text=>stdout+=text,writeError:text=>stderr+=text,
 });
 assert.equal(exit,2);
 assert.equal(JSON.parse(stdout).error,'Unknown option');
 assert.equal(stderr,'未知选项\n');
}));

test('doctor localizes the header and diagnoses while its JSON and fallback error stay identical',t=>project(root=>project(async stateRoot=>{
 await mkdir(join(root,'.rigup'));
 await writeFile(join(root,'.rigup','manifest.json'),JSON.stringify({
  schemaVersion:1,installId:'fixture',options:{agents:[],backend:'host',documentLanguage:'auto'},
  assets:[{logicalId:'fixture-asset',target:'fixture.md',digest:'a'.repeat(64),ownership:{kind:'file'}}],
 }));
 const run=async(locale:string,args:string[],code:number)=>{
  testEnvironment(t,{LC_ALL:locale});
  let stdout='',stderr='';
  assert.equal(await runCli(args,{cwd:root,isTTY:false,write:text=>stdout+=text,writeError:text=>stderr+=text,services:{stateRoot}}),code,stdout);
  return {stdout,stderr};
 };
 const english=await run('C',['doctor','--json'],1);
 const chinese=await run('zh_CN.UTF-8',['doctor','--json'],1);
 assert.equal(chinese.stdout,english.stdout);
 assert.equal(JSON.parse(chinese.stdout).error,'config fixture-asset: failed — Trusted generated baseline unavailable');
 assert.match(chinese.stderr,/^诊断: /);
 assert.match(chinese.stderr,/配置 fixture-asset: 失败 — 无法读取可信的生成基线/);
 assert.doesNotMatch(english.stderr,/\p{Script=Han}/u);

 const error=await run('zh_CN.UTF-8',['init','--bad-flag','--json'],2);
 assert.equal(error.stdout,(await run('C',['init','--bad-flag','--json'],2)).stdout);
 assert.equal(JSON.parse(error.stdout).error,'Unknown option');
 assert.match(error.stderr,/未知选项/);
})));

test('update preview localizes the rendered details and retains stable paths',()=>project(root=>project(cacheRoot=>project(async stateRoot=>{
 let output='';
 const exit=await runCli(['update','--agents','codex','--language','zh-CN','--dry-run','--verbose'],{
  cwd:root,isTTY:false,write:text=>output+=text,services:{cacheRoot,stateRoot},
 });
 assert.equal(exit,0,output);
 assert.match(output,/预览 [a-f0-9]{64}/);
 assert.match(output,/创建 AGENTS\.md/);
 assert.match(output,/\+\+\+ 变更后的受管内容/);
 assert.doesNotMatch(output,/^Preview |Create \d file|owned after/m);
}))));
