import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {runCli} from '../src/cli.js';
import {project} from './helpers.js';
import {mkdir,readdir,readFile,writeFile} from 'node:fs/promises';
import {runtimeEnvironment,runtimeSetupSummary} from '../src/runtime-inputs.js';
import {resolveResearchProvider} from '../src/research/provider-settings.js';
import {atomicProjectWrite} from '../src/installer/manifest.js';
import {apply} from '../src/installer/apply.js';
import {loadPreview} from '../src/installer/preview.js';
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

const providerEnvNames=['HOME','USERPROFILE','RIGUP_CONSUMER_PATH','TEAM_KEY','OTHER_KEY','RIGUP_PROVIDER','RIGUP_MODEL_ID','RIGUP_BASE_URL','RIGUP_API_KEY_ENV','RIGUP_MAX_OUTPUT_TOKENS','ANTHROPIC_API_KEY','ANTHROPIC_BASE_URL','ANTHROPIC_MODEL','OPENAI_API_KEY','OPENAI_BASE_URL','OPENAI_MODEL'];
async function isolatedProvider(run:(root:string,home:string)=>Promise<void>){
 await project(root=>project(async home=>{
  const before=providerEnvNames.map(name=>process.env[name]);
  for(const name of providerEnvNames)delete process.env[name];
  process.env.HOME=home;process.env.USERPROFILE=home;process.env.RIGUP_CONSUMER_PATH=home;
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
async function assertNoStoredKey(directory:string,values=['synthetic-explicit-model-secret'],except?:string){
 for(const entry of await readdir(directory,{withFileTypes:true})){
  const path=join(directory,entry.name);
  if(entry.isDirectory())await assertNoStoredKey(path,values,except);
  else if(entry.isFile()&&path!==except){
   const content=await readFile(path,'utf8');
   assert.ok(values.every(value=>!content.includes(value)),path);
  }
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
  await assert.rejects(readFile(join(root,'.rigup/.env')),{code:'ENOENT'});
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
  const saved=await loadPreview(review.previewId,join(home,'cache','previews'));
  assert.deepEqual(saved.plan.providerEnvImport,{provider,apiKeyEnv:key});
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

const ambientKey='synthetic-issue-89-ambient-key';
const gateway='https://issue-89-gateway.example.test/v1';
const providerSecretName='ANTHROPIC_API_KEY';

const emptyResearch={status:'complete' as const,value:{
 data:{observations:[],unknowns:[],guidance:[],artifacts:[],dispositions:[]},model:'fixture',unknowns:[],usage:{calls:1,tokens:1},
}};

function importCli(root:string,home:string,backend:LifecycleServices['backend']|null={run:async()=>assert.fail('unexpected research call')},runChecks?:LifecycleServices['runChecks']){
 const services={cacheRoot:join(home,'cache'),stateRoot:join(home,'state'),backend:backend??undefined,runChecks};
 const envPath=join(root,'.rigup','.env'),previews=join(services.cacheRoot,'previews');
 return {
  services,envPath,previews,
  async run(args:string[],expected:number,answers?:string[]){
   let stdout='',stderr='',report;
   const code=await runCli(args,{
    cwd:root,isTTY:answers!==undefined,outputIsTTY:answers!==undefined,read:answers?async()=>answers.shift()??null:undefined,
    services:{...services,report:value=>{report=value;}},
    write:value=>stdout+=value,writeError:value=>stderr+=value,
   });
   assert.equal(code,expected,stdout+stderr);
   assert.ok([ambientKey,gateway].every(value=>!(stdout+stderr).includes(value)));
   return {stdout,stderr,report:args.includes('--json')?JSON.parse(stdout):report};
  },
 };
}

function anthropicEnvironment(){
 Object.assign(process.env,{ANTHROPIC_API_KEY:ambientKey,ANTHROPIC_BASE_URL:gateway});
}

for(const inputs of ['clean','key and gateway','complete ambient defaults','private preset','project model and injected policy'] as const){
 test('all-default interactive init keeps the private file absent with '+inputs,()=>isolatedProvider(async(root,home)=>{
  if(inputs!=='clean')anthropicEnvironment();
  if(inputs==='complete ambient defaults')process.env.ANTHROPIC_MODEL='fixture-default-model';
  if(inputs==='private preset'){
   const config=join(home,'.config','rigup');
   await mkdir(config,{recursive:true,mode:0o700});
   await writeFile(join(config,'provider.json'),JSON.stringify({provider:'anthropic',model:'private-default-model'}),{mode:0o600});
  }
  if(inputs==='project model and injected policy'){
   await mkdir(join(root,'.rigup'));
   await writeFile(join(root,'.rigup/config.yaml'),JSON.stringify({
    projectRules:true,model:{provider:'anthropic',model:'project-default-model',apiKeyEnv:providerSecretName},
    providerEnvImport:{provider:'anthropic',apiKeyEnv:providerSecretName},
   }));
  }
  const cli=importCli(root,home);
  const {report}=await cli.run(['init'],0,['','','','','']);
  assert.equal(report.projectRules,'pending');
  assert.equal(report.runtimeSetup.template.needsUpdate,false);
  await assert.rejects(readFile(cli.envPath),{code:'ENOENT'});
 }));
}

test('a provider key name explicitly shared with a customer command follows that consumer',()=>isolatedProvider(async(root,home)=>{
 anthropicEnvironment();
 await mkdir(join(root,'.rigup'));
 await writeFile(join(root,'.rigup/config.yaml'),JSON.stringify({
  projectRules:true,customSkills:[{source:'customer-skill',position:'deliver'}],customer:{commands:{environment:{executable:process.execPath,args:['fixture.mjs'],cwd:'.',envRefs:[providerSecretName]}}},
 }));
 await mkdir(join(root,'customer-skill'));
 await writeFile(join(root,'customer-skill','SKILL.md'),'---\nname: fixture-check\ndescription: Check the local environment.\n---\nRun the environment check.\n');
 const cli=importCli(root,home);
 const {report}=await cli.run(['init','--json'],0);
 const file=await readRuntimeFile(root);
 assert.deepEqual([...file.entries.keys()],[providerSecretName]);
 assert.equal(file.entries.get(providerSecretName)?.value,ambientKey);
 assert.deepEqual(report.runtimeSetup.template.imported,[{name:providerSecretName,source:'calling-environment'}]);
}));

test('a saved explicit update applies only the approved provider and key reference',()=>isolatedProvider(async(root,home)=>{
 const cli=importCli(root,home);
 await cli.run(['init','--json'],0);
 anthropicEnvironment();
 Object.assign(process.env,{RIGUP_PROVIDER:'anthropic',RIGUP_API_KEY_ENV:'ISSUE_89_CUSTOM_KEY',ISSUE_89_CUSTOM_KEY:ambientKey});
 try{
  const {report:review}=await cli.run(['update','--review','--json'],3);
  const {plan}=await loadPreview(review.previewId,cli.previews);
  assert.deepEqual(plan.providerEnvImport,{provider:'anthropic',apiKeyEnv:'ISSUE_89_CUSTOM_KEY'});
  await assert.rejects(readFile(cli.envPath),{code:'ENOENT'});
  const argv=['update','--apply',review.previewId,'--sessions-ended','--json'];
  Object.assign(process.env,{RIGUP_PROVIDER:'openai-compatible',OPENAI_API_KEY:'synthetic-unapproved-provider'});
  await cli.run(argv,0);
  await assert.rejects(readFile(cli.envPath),{code:'ENOENT'});
  delete process.env.RIGUP_PROVIDER;
  process.env.RIGUP_API_KEY_ENV=providerSecretName;
  await cli.run(argv,0);
  await assert.rejects(readFile(cli.envPath),{code:'ENOENT'});
  delete process.env.RIGUP_API_KEY_ENV;
  const {report}=await cli.run(argv,0);
  assert.deepEqual(report.runtimeSetup.template.imported.find((item:{name:string})=>item.name==='ISSUE_89_CUSTOM_KEY'),
   {name:'ISSUE_89_CUSTOM_KEY',source:'calling-environment'});
  const entries=(await readRuntimeFile(root)).entries;
  assert.equal(entries.get('ISSUE_89_CUSTOM_KEY')?.value,ambientKey);
  assert.equal(entries.get('RIGUP_BASE_URL')?.value,gateway);
  assert.equal(entries.has(providerSecretName),false);
  assert.equal(entries.has('OPENAI_API_KEY'),false);
 }finally{
  delete process.env.ISSUE_89_CUSTOM_KEY;
 }
}));

for(const approved of [false,true]){
 test('interrupted apply uses the original '+(approved?'provider authorization':'approval without provider authorization'),()=>isolatedProvider(async(root,home)=>{
  execFileSync('git',['-C',root,'init','-q']);
  const cli=importCli(root,home);
  if(approved){
   anthropicEnvironment();
   process.env.RIGUP_PROVIDER='anthropic';
  }
  const {report:review}=await cli.run(['init','--review','--json'],3);
  assert.equal(!!(await loadPreview(review.previewId,cli.previews)).plan.providerEnvImport,approved);
  await assert.rejects(()=>apply(review.previewId,{
   cacheRoot:cli.previews,stateRoot:cli.services.stateRoot,hook:async point=>{if(point==='after-file')throw Error('fixture interrupted');},
  }),/fixture interrupted/);
  await assert.rejects(readFile(cli.envPath),{code:'ENOENT'});
  if(approved)delete process.env.RIGUP_PROVIDER;
  else{
   anthropicEnvironment();
   process.env.RIGUP_PROVIDER='anthropic';
  }
  const {report:resume}=await cli.run(['update','--resume','--review','--json'],3);
  assert.equal(resume.previewId,review.previewId);
  await cli.run(['update','--apply',resume.previewId,'--resume','--sessions-ended','--json'],0);
  if(approved)assert.equal((await readRuntimeFile(root)).entries.get(providerSecretName)?.value,ambientKey);
  else await assert.rejects(readFile(cli.envPath),{code:'ENOENT'});
 }));
 test('host continuation keeps '+(approved?'explicit':'absent')+' provider authorization and rejects an edited grant',()=>isolatedProvider(async(root,home)=>{
  await mkdir(join(root,'.rigup'));
  await writeFile(join(root,'.rigup/config.yaml'),'projectRules: true\n');
  let calls=0;
  const cli=importCli(root,home,{run:async()=>{
   if(calls++)return emptyResearch;
   return {status:'pending-host',requestId:'fixture',requestPath:join(home,'cache','host','fixture.request.json')};
  }});
  if(approved){
   anthropicEnvironment();
   process.env.RIGUP_PROVIDER='anthropic';
  }
  const {report:first}=await cli.run(['init','--agents','codex','--backend','host','--review','--json'],3);
  const id=first.nextCommand.match(/--continue ([a-f0-9]{64})/)?.[1];
  assert.ok(id);
  if(approved)delete process.env.RIGUP_PROVIDER;
  else{
   anthropicEnvironment();
   process.env.RIGUP_PROVIDER='anthropic';
  }
  const path=join(cli.services.stateRoot,'runs',id+'.json');
  const original=await readFile(path,'utf8');
  const changed=JSON.parse(original);
  changed.mode.providerEnvImport={provider:'anthropic',apiKeyEnv:'OTHER_KEY'};
  await writeFile(path,JSON.stringify(changed));
  const {report:rejected}=await cli.run(['update','--continue',id,'--json'],1);
  assert.match(rejected.error,/continuation input\/configuration changed/);
  assert.equal(calls,1);
  await assert.rejects(readFile(cli.envPath),{code:'ENOENT'});
  await writeFile(path,original);
  await writeFile(join(root,'ordinary-source.ts'),'export const fixture = true;\n');
  const {report:review}=await cli.run(['update','--continue',id,'--json'],3);
  const {plan}=await loadPreview(review.previewId,cli.previews);
  assert.deepEqual(plan.providerEnvImport,approved?{provider:'anthropic',apiKeyEnv:providerSecretName}:undefined);
  await cli.run(['update','--apply',review.previewId,'--sessions-ended','--json'],0);
  if(approved)assert.equal((await readRuntimeFile(root)).entries.get(providerSecretName)?.value,ambientKey);
  else await assert.rejects(readFile(cli.envPath),{code:'ENOENT'});
 }));
}

test('an unmarked saved preview installs without copying a selector and key introduced at apply',()=>isolatedProvider(async(root,home)=>{
 execFileSync('git',['-C',root,'init','-q']);
 const cli=importCli(root,home);
 const {report:review}=await cli.run(['init','--review','--json'],3);
 const saved=await loadPreview(review.previewId,cli.previews);
 assert.equal(Object.hasOwn(saved.plan,'providerEnvImport'),false);
 anthropicEnvironment();
 process.env.RIGUP_PROVIDER='anthropic';
 await cli.run(['update','--apply',review.previewId,'--sessions-ended','--json'],0);
 await assert.rejects(readFile(cli.envPath),{code:'ENOENT'});
}));

test('explicit provider choice at the prompt authorizes the named input while typed credentials stay in memory',()=>isolatedProvider(async(root,home)=>{
 const typed='synthetic-issue-89-typed-secret';
 const cli=importCli(root,home,{run:async()=>emptyResearch});
 const {report:review,stdout}=await cli.run(
  ['init','--agents','codex','--sdd','none','--tools','none','--language','en','--model','prompt-model','--review'],3,['1','',typed]);
 assert.ok(!stdout.includes(typed));
 const {plan}=await loadPreview(review.previewId,cli.previews);
 assert.deepEqual(plan.providerEnvImport,{provider:'anthropic',apiKeyEnv:providerSecretName});
 await assert.rejects(readFile(cli.envPath),{code:'ENOENT'});
 anthropicEnvironment();
 await cli.run(['update','--apply',review.previewId,'--sessions-ended','--json'],0);
 const file=await readRuntimeFile(root);
 assert.equal(file.entries.get(providerSecretName)?.value,ambientKey);
 assert.doesNotMatch(file.text,/synthetic-issue-89-typed-secret|prompt-model/);
 assert.match(await readFile(join(root,'.rigup/.gitignore'),'utf8'),/^\/\.env$/m);
 await assertNoStoredKey(home,[ambientKey,gateway,typed]);
 await assertNoStoredKey(root,[ambientKey,gateway,typed],cli.envPath);
}));

test('the default provider prompt choice defers to MCP without authorizing a runtime write',()=>isolatedProvider(async(root,home)=>{
 anthropicEnvironment();
 Object.assign(process.env,{RIGUP_PROVIDER:'anthropic',RIGUP_API_KEY_ENV:'ISSUE_89_UNSET_KEY'});
 const cli=importCli(root,home);
 const args=['init','--agents','codex','--sdd','none','--tools','none','--language','en','--model','prompt-model','--review'];
 await cli.run(args,130,[]);
 const {report:review}=await cli.run(args,3,['']);
 assert.equal((await loadPreview(review.previewId,cli.previews)).plan.providerEnvImport,undefined);
 await cli.run(['update','--apply',review.previewId,'--sessions-ended','--json'],0);
 await assert.rejects(readFile(cli.envPath),{code:'ENOENT'});
}));

const importNotice='Imported ANTHROPIC_API_KEY from the calling environment into .rigup/.env (git-ignored)';
const chineseImportNotice='已从调用环境导入 ANTHROPIC_API_KEY 到 .rigup/.env（git 已忽略）';

for(const verbose of [false,true]){
 test('explicit provider import reports one '+(verbose?'verbose':'localized default')+' notice',()=>isolatedProvider(async(root,home)=>{
  anthropicEnvironment();
  process.env.RIGUP_PROVIDER='anthropic';
  const cli=importCli(root,home);
  const {stdout,report}=await cli.run(['init','--language',verbose?'en':'zh-CN',...(verbose?['--verbose']:[])],0,['','','','']);
  assert.equal((await readRuntimeFile(root)).entries.get(providerSecretName)?.value,ambientKey);
  assert.deepEqual(report.runtimeSetup.template.imported.find((item:{name:string})=>item.name===providerSecretName),
   {name:providerSecretName,source:'calling-environment'});
  const credentialLines=stdout.split('\n').filter(line=>line.includes(providerSecretName));
  assert.deepEqual(credentialLines,[verbose?importNotice:chineseImportNotice]);
  await assertNoStoredKey(home,[ambientKey,gateway]);
  await assertNoStoredKey(root,[ambientKey,gateway],cli.envPath);
 }));
}

test('the first saved apply announces the copy and a completed replay emits no import notice',()=>isolatedProvider(async(root,home)=>{
 anthropicEnvironment();
 process.env.RIGUP_PROVIDER='anthropic';
 const cli=importCli(root,home);
 const {report:review}=await cli.run(['init','--review','--json'],3);
 const argv=['update','--apply',review.previewId,'--sessions-ended'];
 assert.equal((await cli.run(argv,0)).stdout.split('\n').filter(line=>line===importNotice).length,1);
 assert.ok(!(await cli.run(argv,0)).stdout.includes(importNotice));
 const {stdout,report}=await cli.run([...argv,'--json'],0);
 assert.ok(!stdout.includes(importNotice));
 assert.deepEqual(report.runtimeSetup.template.imported,[]);
}));

test('an existing private key wins and does not produce a calling-environment import notice',()=>isolatedProvider(async(root,home)=>{
 anthropicEnvironment();
 process.env.RIGUP_PROVIDER='anthropic';
 const contents='# a retained comment\nANTHROPIC_API_KEY="synthetic-local-wins" # retained\n';
 await privateEnv(root,contents);
 const cli=importCli(root,home);
 const {stdout,report}=await cli.run(['init','--language','en'],0,['','','','']);
 assert.ok((await readFile(cli.envPath,'utf8')).startsWith(contents));
 assert.equal((await readRuntimeFile(root)).entries.get(providerSecretName)?.value,'synthetic-local-wins');
 assert.ok(!stdout.includes(providerSecretName));
 assert.equal(report.runtimeSetup.template.imported.some((input:{name:string})=>input.name===providerSecretName),false);
}));

test('a blocked private credential write produces no import notice',()=>isolatedProvider(async(root,home)=>{
 anthropicEnvironment();
 process.env.RIGUP_PROVIDER='anthropic';
 const cli=importCli(root,home);
 const {report:review}=await cli.run(['init','--review','--json'],3);
 await mkdir(join(root,'.rigup'));
 const invalid='ANTHROPIC_API_KEY=\nANTHROPIC_API_KEY=\n';
 await writeFile(cli.envPath,invalid);
 const {stdout,report}=await cli.run(['update','--apply',review.previewId,'--sessions-ended'],0);
 assert.equal(report.runtimeSetup.template.state,'pending');
 assert.deepEqual(report.runtimeSetup.template.imported,[]);
 assert.ok(!stdout.includes(importNotice));
 assert.equal(await readFile(cli.envPath,'utf8'),invalid);
}));

for(const useAdapter of [false,true]){
 test('an explicit API key reference wins over an ambient alias '+(useAdapter?'for a native request and saved apply':'in the saved approval'),t=>isolatedProvider(async(root,home)=>{
  const teamKey='synthetic-issue-89-team-key',otherKey='synthetic-issue-89-other-key';
  Object.assign(process.env,{RIGUP_API_KEY_ENV:'OTHER_KEY',TEAM_KEY:teamKey,OTHER_KEY:otherKey,OPENAI_BASE_URL:gateway});
  await mkdir(join(root,'.rigup'));
  await writeFile(join(root,'.rigup/config.yaml'),JSON.stringify({
   projectRules:true,model:{provider:'openai-compatible',model:'fixture-default',apiKeyEnv:'PRESET_KEY'},
  }));
  const authorization:string[]=[];
  if(useAdapter)t.mock.method(globalThis,'fetch',async (url:string,init:RequestInit)=>{
   assert.equal(new URL(url).hostname,'issue-89-gateway.example.test');
   authorization.push(new Headers(init.headers).get('Authorization')??'');
   const {messages}=JSON.parse(init.body as string),context=JSON.parse(messages[1].content);
   const data=context.kind==='analyze'?{observations:[],unknowns:[],guidance:[]}:{observations:[],unknowns:[],artifacts:[],dispositions:[]};
   return Response.json({
    model:'fixture-model',choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(data)}}],
    usage:{prompt_tokens:2,completion_tokens:1,total_tokens:3},
   });
  });
  const cli=importCli(root,home,useAdapter?null:{run:async request=>{
   assert.equal(request.effectiveModel?.apiKeyEnv,'TEAM_KEY');
   return emptyResearch;
  }});
  const {report:review}=await cli.run(
   ['init','--agents','codex','--sdd','none','--model','fixture-model','--api-key-env','TEAM_KEY','--review','--json'],3);
  assert.ok(review.executable);
  const {plan}=await loadPreview(review.previewId,cli.previews);
  assert.equal(plan.providerEnvImport?.apiKeyEnv,'TEAM_KEY');
  await assert.rejects(readFile(cli.envPath),{code:'ENOENT'});
  const {stdout}=await cli.run(['update','--apply',review.previewId,'--sessions-ended'],0);
  assert.match(stdout,/Imported TEAM_KEY from the calling environment/);
  assert.ok(!stdout.includes(teamKey)&&!stdout.includes(otherKey));
  const file=await readRuntimeFile(root);
  assert.equal(file.entries.get('TEAM_KEY')?.value,teamKey);
  assert.equal(file.entries.get('RIGUP_API_KEY_ENV')?.value,'TEAM_KEY');
  assert.equal(file.entries.has('OTHER_KEY'),false);
  assert.ok(!file.text.includes(otherKey));
  if(useAdapter)assert.deepEqual(authorization,['Bearer '+teamKey,'Bearer '+teamKey]);
  await assertNoStoredKey(home,[teamKey,otherKey]);
 }));
}

for(const mode of ['inline','saved'] as const){
 for(const json of [false,true])test(mode+' apply retains its failure after an environment import in '+(json?'JSON':'terminal output'),()=>isolatedProvider(async(root,home)=>{
  anthropicEnvironment();
  process.env.RIGUP_PROVIDER='anthropic';
  let fail=true;
  const failure='fixture check error after environment write';
  const cli=importCli(root,home,undefined,async()=>{
   assert.equal((await readRuntimeFile(root)).entries.get(providerSecretName)?.value,ambientKey);
   if(fail)throw Error(failure);
   return [];
  });
  const init=['init','--agents','codex','--sdd','none'];
  const saved=mode==='saved'?(await cli.run([...init,'--review','--json'],3)).report.previewId:undefined;
  const applyArgs=saved?['update','--apply',saved,'--sessions-ended']:init;
  const {stdout,stderr,report}=await cli.run([...applyArgs,...(json?['--json']:[])],1);
  await assert.rejects(readFile(join(root,'.rigup','manifest.json')),{code:'ENOENT'});
  assert.equal((await readRuntimeFile(root)).entries.get(providerSecretName)?.value,ambientKey);
  if(json){
   assert.equal(report.error,failure);
   assert.equal(report.phase,saved?'preflight':'preview');
   assert.equal(report.installStatus,saved?'failed':'not-installed');
   assert.ok(!(stdout+stderr).includes(importNotice));
  }else{
   assert.equal(stdout.split('\n').filter(line=>line===importNotice).length,1);
   assert.ok(stdout.includes(failure));
   assert.doesNotMatch(stdout,/Install complete/);
  }
  fail=false;
  const previewId=saved??report.previewId;
  const retry=await cli.run(['update','--apply',previewId,'--resume','--sessions-ended'],0);
  assert.ok(!retry.stdout.includes(importNotice));
  await assertNoStoredKey(home,[ambientKey,gateway]);
 }));
}
