import {test} from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {runCli} from '../src/cli.js';
import {project} from './helpers.js';
import {mkdir,readdir,readFile,writeFile} from 'node:fs/promises';
import {runtimeEnvironment,runtimeSetupSummary} from '../src/runtime-inputs.js';
import {resolveResearchProvider} from '../src/research/provider-settings.js';
import {atomicProjectWrite} from '../src/installer/manifest.js';
import {readRuntimeFile} from '../src/runtime-private-env.js';
import type {LifecycleServices} from '../src/lifecycle.js';

for(const [provider,prefix] of [['anthropic','ANTHROPIC'],['openai-compatible','OPENAI']] as const)test('local-only '+prefix+' key and model select the declared provider',()=>project(root=>project(async home=>{
 const names=['HOME','USERPROFILE','RIGUP_PROVIDER','RIGUP_MODEL_ID','RIGUP_BASE_URL','RIGUP_API_KEY_ENV','RIGUP_MAX_OUTPUT_TOKENS','ANTHROPIC_API_KEY','ANTHROPIC_BASE_URL','ANTHROPIC_MODEL','OPENAI_API_KEY','OPENAI_BASE_URL','OPENAI_MODEL'];
 const before=names.map(name=>process.env[name]);for(const name of names)delete process.env[name];process.env.HOME=home;process.env.USERPROFILE=home;
 try{
  await mkdir(join(root,'.rigup'));await writeFile(join(root,'.rigup/.gitignore'),'/.env\n/.env.rigup-*.tmp\n');
  const selected={agents:[],backend:'native' as const,projectRules:true};
  const key=prefix+'_API_KEY';
  await atomicProjectWrite(root,'.rigup/.env',Buffer.from(key+'="synthetic-local-provider-secret"\n'+prefix+'_MODEL="exact-local-model"\n'),0o600);
  const summary=await runtimeSetupSummary(root,selected);
  assert.equal(summary.inputs.find(input=>input.name===key)?.state,'present');assert.doesNotMatch(JSON.stringify(summary),/synthetic-local-provider-secret/);
  const env=await runtimeEnvironment(root,selected,'provider');
  const resolved=await resolveResearchProvider(root,undefined,undefined,env);
  assert.equal(resolved?.identity.provider,provider);assert.equal(resolved?.identity.model,'exact-local-model');assert.equal(resolved?.apiKey,'synthetic-local-provider-secret');
  assert.equal((await runtimeEnvironment(root,selected,'customer:environment'))[key],undefined);
 }finally{names.forEach((name,index)=>{if(before[index]===undefined)delete process.env[name];else process.env[name]=before[index];});}
})));

test('an explicit CLI model selects a provider whose only ambient input is its declared key',()=>project(async root=>project(async home=>{
 const names=['HOME','USERPROFILE','RIGUP_PROVIDER','RIGUP_MODEL_ID','RIGUP_BASE_URL','RIGUP_API_KEY_ENV','RIGUP_MAX_OUTPUT_TOKENS','ANTHROPIC_API_KEY','ANTHROPIC_BASE_URL','ANTHROPIC_MODEL','OPENAI_API_KEY','OPENAI_BASE_URL','OPENAI_MODEL'];
 const before=names.map(name=>process.env[name]);
 for(const name of names)delete process.env[name];
 process.env.HOME=home;process.env.USERPROFILE=home;process.env.OPENAI_API_KEY='synthetic-explicit-model-secret';
 let output='';
 try{
  const code=await runCli(['init','--agents','codex','--sdd','none','--model','exact-gateway-model','--json'],{cwd:root,isTTY:false,write:value=>output+=value,
   services:{cacheRoot:join(home,'cache'),stateRoot:join(home,'state'),backend:{run:async request=>{
    assert.equal(request.effectiveModel?.provider,'openai-compatible');assert.equal(request.effectiveModel?.model,'exact-gateway-model');
    return {status:'complete',value:{data:{observations:[],unknowns:[],guidance:[],artifacts:[],dispositions:[]},model:'fixture',unknowns:[],usage:{calls:1,tokens:1}}};
   }}}});
  assert.equal(code,0,output);assert.equal(JSON.parse(output).projectRules,'ready');
  assert.doesNotMatch(output,/synthetic-explicit-model-secret/);
 }finally{names.forEach((name,index)=>{if(before[index]===undefined)delete process.env[name];else process.env[name]=before[index];});}
})));

const providerEnvNames=['HOME','USERPROFILE','RIGUP_PROVIDER','RIGUP_MODEL_ID','RIGUP_BASE_URL','RIGUP_API_KEY_ENV','RIGUP_MAX_OUTPUT_TOKENS','ANTHROPIC_API_KEY','ANTHROPIC_BASE_URL','ANTHROPIC_MODEL','OPENAI_API_KEY','OPENAI_BASE_URL','OPENAI_MODEL'];
async function isolatedProvider(run:(root:string,home:string)=>Promise<void>){
 await project(root=>project(async home=>{
  const before=providerEnvNames.map(name=>process.env[name]);
  for(const name of providerEnvNames)delete process.env[name];
  process.env.HOME=home;process.env.USERPROFILE=home;
  try{await run(root,home);}
  finally{providerEnvNames.forEach((name,index)=>{if(before[index]===undefined)delete process.env[name];else process.env[name]=before[index];});}
 }));
}
async function privateEnv(root:string,text:string){
 await mkdir(join(root,'.rigup'));
 await writeFile(join(root,'.rigup/.gitignore'),'/.env\n/.env.rigup-*.tmp\n');
 await atomicProjectWrite(root,'.rigup/.env',Buffer.from(text),0o600);
}
function providerCli(root:string,home:string){
 const models:{provider:string;model:string}[]=[];
 const services:LifecycleServices={cacheRoot:join(home,'cache'),stateRoot:join(home,'state'),backend:{run:async request=>{
  assert.ok(request.effectiveModel);models.push({provider:request.effectiveModel.provider,model:request.effectiveModel.model});
  return {status:'complete',value:{data:{observations:[],unknowns:[],guidance:[],artifacts:[],dispositions:[]},model:'fixture',unknowns:[],usage:{calls:1,tokens:1}}};
 }}};
 return {models,run:async(args:string[],expected:number)=>{
  let output='';
  const code=await runCli([...args,'--json'],{cwd:root,isTTY:false,write:value=>output+=value,services});
  assert.equal(code,expected,output);assert.doesNotMatch(output,/synthetic-explicit-model-secret/);
  return JSON.parse(output);
 }};
}
async function assertNoStoredKey(directory:string){
 for(const entry of await readdir(directory,{withFileTypes:true})){
  const path=join(directory,entry.name);
  if(entry.isDirectory())await assertNoStoredKey(path);
  else if(entry.isFile())assert.doesNotMatch(await readFile(path,'utf8'),/synthetic-explicit-model-secret/,path);
 }
}

for(const [provider,prefix] of [['anthropic','ANTHROPIC'],['openai-compatible','OPENAI']] as const){
 test('a lone '+prefix+' key declares the missing default model without dispatching research',()=>isolatedProvider(async(root,home)=>{
  const key=prefix+'_API_KEY';process.env[key]='synthetic-explicit-model-secret';
  const cli=providerCli(root,home);
  const report=await cli.run(['init','--agents','codex','--sdd','none'],0);
  assert.equal(cli.models.length,0);assert.equal(report.projectRules,'pending');
  assert.equal(report.runtimeSetup.inputs.find((input:{name:string})=>input.name===key)?.state,'present');
  assert.equal(report.runtimeSetup.inputs.find((input:{name:string})=>input.name==='RIGUP_MODEL_ID')?.state,'missing');
  assert.equal((await readRuntimeFile(root)).entries.get('RIGUP_MODEL_ID')?.value,'');
 }));
 for(const source of ['local','ambient'] as const)test('--model uses and imports the '+source+' '+prefix+' key without saving its override',()=>isolatedProvider(async(root,home)=>{
  const key=prefix+'_API_KEY',secret='synthetic-explicit-model-secret';
  if(source==='local')await privateEnv(root,key+'="'+secret+'"\n');
  else process.env[key]=secret;
  const cli=providerCli(root,home);
  const report=await cli.run(['init','--agents','codex','--sdd','none','--model','exact-override'],0);
  assert.deepEqual(cli.models,[{provider,model:'exact-override'},{provider,model:'exact-override'}]);
  assert.equal(report.projectRules,'ready');
  assert.equal(report.runtimeSetup.inputs.find((input:{name:string})=>input.name===key)?.state,'present');
  const file=await readRuntimeFile(root);assert.equal(file.problem,undefined);
  assert.equal(file.entries.get(key)?.value,secret);assert.doesNotMatch(file.text,/exact-override/);
  assert.doesNotMatch(await readFile(join(root,'.rigup/manifest.json'),'utf8'),/exact-override|synthetic-explicit-model-secret/);
  delete process.env[key];
  const update=await cli.run(['update','--review','--model','exact-override'],0);
  assert.equal(update.installStatus,'up-to-date');assert.equal(cli.models.length,2);
  assert.equal(update.runtimeSetup.inputs.find((input:{name:string})=>input.name===key)?.state,'present');
  const missingModel=await cli.run(['update','--review'],0);
  assert.equal(missingModel.installStatus,'up-to-date');assert.equal(cli.models.length,2);
  assert.equal(missingModel.runtimeSetup.inputs.find((input:{name:string})=>input.name==='RIGUP_MODEL_ID')?.state,'missing');
  await assertNoStoredKey(home);
 }));

 test('--model preserves the populated '+prefix+' local model and later uses that default',()=>isolatedProvider(async(root,home)=>{
  const original=prefix+'_API_KEY="synthetic-explicit-model-secret"\n'+prefix+'_MODEL="saved-local-model" # keep this model\n';
  await privateEnv(root,original);
  const cli=providerCli(root,home);
  await cli.run(['init','--agents','codex','--sdd','none','--model','exact-override'],0);
  const text=await readFile(join(root,'.rigup/.env'),'utf8');assert.ok(text.startsWith(original));assert.doesNotMatch(text,/exact-override/);
  await cli.run(['update','--review'],0);
  assert.deepEqual(cli.models,[{provider,model:'exact-override'},{provider,model:'exact-override'},{provider,model:'saved-local-model'},{provider,model:'saved-local-model'}]);
 }));

 test('review and replay retain the declared '+prefix+' provider without persisting --model',()=>isolatedProvider(async(root,home)=>{
  const key=prefix+'_API_KEY';process.env[key]='synthetic-explicit-model-secret';
  const cli=providerCli(root,home);
  const review=await cli.run(['init','--agents','codex','--sdd','none','--review','--model','exact-override'],3);
  assert.equal(review.runtimeSetup.inputs.find((input:{name:string})=>input.name===key)?.state,'present');
  await assert.rejects(readFile(join(root,'.rigup/.env')),{code:'ENOENT'});
  const applied=await cli.run(['update','--apply',review.previewId,'--sessions-ended'],0);
  assert.equal(applied.runtimeSetup.inputs.find((input:{name:string})=>input.name===key)?.state,'present');
  assert.equal((await readRuntimeFile(root)).entries.get(key)?.value,'synthetic-explicit-model-secret');
  delete process.env[key];
  const replay=await cli.run(['update','--apply',review.previewId,'--sessions-ended'],0);
  assert.equal(replay.runtimeSetup.inputs.find((input:{name:string})=>input.name===key)?.state,'present');
  assert.equal(cli.models.length,2);
  assert.doesNotMatch(await readFile(join(root,'.rigup/manifest.json'),'utf8'),/exact-override|synthetic-explicit-model-secret/);
  await assertNoStoredKey(home);
 }));
}

test('provider inference keeps complete candidates ahead of an unrelated key-only provider',()=>isolatedProvider(async(root,home)=>{
 process.env.ANTHROPIC_API_KEY='unselected-provider-key';
 await privateEnv(root,'OPENAI_API_KEY="synthetic-explicit-model-secret"\nOPENAI_MODEL="saved-local-model"\n');
 const cli=providerCli(root,home);
 const report=await cli.run(['init','--agents','codex','--sdd','none'],0);
 assert.deepEqual(cli.models,[{provider:'openai-compatible',model:'saved-local-model'},{provider:'openai-compatible',model:'saved-local-model'}]);
 assert.equal(report.runtimeSetup.inputs.some((input:{name:string})=>input.name==='ANTHROPIC_API_KEY'),false);
 assert.doesNotMatch((await readRuntimeFile(root)).text,/unselected-provider-key/);
}));

test('--model with two safely overlaid provider keys requires an explicit provider',()=>isolatedProvider(async(root,home)=>{
 await privateEnv(root,'ANTHROPIC_API_KEY="synthetic-explicit-model-secret"\nOPENAI_API_KEY="synthetic-explicit-model-secret"\nOPENAI_MODEL="saved-local-model"\n');
 const cli=providerCli(root,home);
 const report=await cli.run(['init','--agents','codex','--sdd','none','--model','exact-override'],2);
 assert.match(report.error,/RIGUP_PROVIDER/);assert.equal(cli.models.length,0);
 assert.doesNotMatch((await readRuntimeFile(root)).text,/exact-override/);
}));

test('a provider key remains undeclared when CLI research is not enabled',()=>isolatedProvider(async root=>{
 process.env.OPENAI_API_KEY='synthetic-explicit-model-secret';
 const options={agents:[],backend:'host' as const,projectRules:false};
 assert.deepEqual((await runtimeSetupSummary(root,options)).inputs,[]);
 assert.equal((await runtimeEnvironment(root,options,'provider')).OPENAI_API_KEY,undefined);
}));
