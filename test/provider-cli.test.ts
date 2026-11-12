import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {project} from './helpers.js';
import {runCli} from '../src/cli.js';
import {resolveResearchProvider} from '../src/research/provider-settings.js';
import * as providerSettings from '../src/research/provider-settings.js';

const configKeys=['HOME','USERPROFILE','RIGUP_PROVIDER','RIGUP_MODEL_ID','RIGUP_BASE_URL','RIGUP_API_KEY_ENV','RIGUP_MAX_OUTPUT_TOKENS',
 'ANTHROPIC_API_KEY','ANTHROPIC_BASE_URL','ANTHROPIC_MODEL','OPENAI_API_KEY','OPENAI_BASE_URL','OPENAI_MODEL','FIXTURE_PROVIDER_TOKEN'];

test('the CLI applies a provider-free foundation, then uses private provider settings and an explicit model',()=>project(async root=>project(async home=>{
 const saved=configKeys.map(key=>process.env[key]);
 for(const key of configKeys)delete process.env[key];
 process.env.HOME=home;process.env.USERPROFILE=home;
 const calls:{model:string;stage:string;authorization:string|undefined;limit:number}[]=[];
 const server=createServer(async(req,res)=>{
  try{
   assert.equal(req.url,'/custom/v1/chat/completions');
   let body='';for await(const chunk of req)body+=chunk;
   const {model,messages,max_completion_tokens:limit}=JSON.parse(body);
   const context=JSON.parse(messages[1].content);
   calls.push({model,stage:context.kind,authorization:req.headers.authorization,limit});
   const data=context.kind==='analyze'?{observations:[],unknowns:[],guidance:[]}:{observations:[],unknowns:[],artifacts:[],dispositions:[]};
   res.setHeader('Content-Type','application/json');
   res.end(JSON.stringify({model,choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(data)}}],usage:{prompt_tokens:40,completion_tokens:20,total_tokens:60}}));
  }catch{res.writeHead(400).end();}
 });
 const cli=async(args:string[],expected:number)=>{
  let output='';
  const code=await runCli([...args,'--json'],{cwd:root,isTTY:false,write:value=>output+=value,services:{cacheRoot:join(home,'cache'),stateRoot:join(home,'state')}});
  assert.equal(code,expected,output);assert.doesNotMatch(output,/private-fixture-token/);return JSON.parse(output);
 };
 try{
  await writeFile(join(root,'README.md'),'# Project\nRun npm test before delivering a change.\n');
  const foundation=await cli(['init','--agents','claude','--sdd','none'],0);
  assert.equal(foundation.projectRules,'pending');assert.match(foundation.researchNextStep,/rigup_begin/);
  assert.match(await readFile(join(root,'CLAUDE.md'),'utf8'),/rules are pending/);
  assert.equal((await cli(['update','--review'],3)).phase,'research');
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const config=join(home,'.config','rigup');await mkdir(config,{recursive:true,mode:0o700});
  await writeFile(join(config,'provider.json'),JSON.stringify({provider:'openai-compatible',model:'private-default',apiKeyEnv:'FIXTURE_PROVIDER_TOKEN',baseURL:`http://127.0.0.1:${address.port}/custom/v1`,maxOutputTokens:750}),{mode:0o600});
  process.env.FIXTURE_PROVIDER_TOKEN='private-fixture-token';process.env.RIGUP_MODEL_ID='env-default';
  process.env.ANTHROPIC_API_KEY='unrelated-fixture-key';
  const review=await cli(['update','--review','--model','override-model'],3);
  assert.equal(review.executable,true);assert.equal(review.projectRules,'ready');
  assert.deepEqual(calls,[{model:'override-model',stage:'analyze',authorization:'Bearer private-fixture-token',limit:750},
   {model:'override-model',stage:'artifact-plan',authorization:'Bearer private-fixture-token',limit:750}]);
  await cli(['update','--apply',review.previewId,'--sessions-ended'],0);
  const manifest=await readFile(join(root,'.rigup','manifest.json'),'utf8');
  assert.doesNotMatch(manifest,/override-model|FIXTURE_PROVIDER_TOKEN|private-fixture-token|127\.0\.0\.1/);
  const unchanged=await cli(['update','--review','--model','override-model'],0);
  assert.equal(calls.length,2);assert.ok(unchanged.items.every((item:{action:string})=>['noop','keep'].includes(item.action)),JSON.stringify(unchanged.items));
  assert.equal(unchanged.installStatus,'up-to-date');assert.equal(unchanged.nextCommand,null);assert.ok(!unchanged.previewId);
  assert.equal(await readFile(join(root,'.rigup','manifest.json'),'utf8'),manifest);
 }finally{
  server.close();server.closeAllConnections();
  configKeys.forEach((key,index)=>{if(saved[index]===undefined)delete process.env[key];else process.env[key]=saved[index];});
 }
})));

test('output cap settings validate positive integers and give the environment precedence',()=>project(async root=>project(async home=>{
 const savedHome=process.env.HOME,savedProfile=process.env.USERPROFILE;
 process.env.HOME=home;process.env.USERPROFILE=home;
 try{
  assert.equal(await resolveResearchProvider(root,undefined,undefined,{}),undefined);
  const config=join(home,'.config','rigup');await mkdir(config,{recursive:true,mode:0o700});
  const path=join(config,'provider.json');
  await writeFile(path,JSON.stringify({provider:'anthropic',model:'gateway-model',maxOutputTokens:24_000}),{mode:0o600});
  const env={ANTHROPIC_API_KEY:'private-fixture-token'};
  assert.equal((await resolveResearchProvider(root,undefined,undefined,env))?.maxOutputTokens,24_000);
  assert.equal((await resolveResearchProvider(root,undefined,undefined,{...env,RIGUP_MAX_OUTPUT_TOKENS:'48000'}))?.maxOutputTokens,48_000);
  for(const value of ['','0','-5','1.5','many','9007199254740992']){
   await assert.rejects(resolveResearchProvider(root,undefined,undefined,{...env,RIGUP_MAX_OUTPUT_TOKENS:value}),/RIGUP_MAX_OUTPUT_TOKENS.*positive integer/);
  }
  await writeFile(path,JSON.stringify({provider:'anthropic',model:'gateway-model',maxOutputTokens:-1}),{mode:0o600});
  await assert.rejects(resolveResearchProvider(root,undefined,undefined,env),/Private research provider configuration/);
 }finally{
  if(savedHome===undefined)delete process.env.HOME;else process.env.HOME=savedHome;
  if(savedProfile===undefined)delete process.env.USERPROFILE;else process.env.USERPROFILE=savedProfile;
 }
})));

test('provider metadata selects declared key names without requiring or exposing credentials',()=>project(async root=>project(async home=>{
 const savedHome=process.env.HOME,savedProfile=process.env.USERPROFILE;
 process.env.HOME=home;process.env.USERPROFILE=home;
 try{
  const environment={RIGUP_PROVIDER:'anthropic',RIGUP_API_KEY_ENV:'CUSTOM_TOKEN',RIGUP_MAX_OUTPUT_TOKENS:'12000',CUSTOM_TOKEN:'fixture-secret'};
  assert.deepEqual(await providerSettings.researchProviderMetadata(root,undefined,undefined,environment),{
   identity:{provider:'anthropic',apiKeyEnv:'CUSTOM_TOKEN'},baseURL:'https://api.anthropic.com/',maxOutputTokens:12000,
  });
  assert.equal(await resolveResearchProvider(root,undefined,undefined,environment),undefined);
  assert.equal((await resolveResearchProvider(root,undefined,undefined,{...environment,RIGUP_MODEL_ID:'claude-auto[1m]'}))?.identity.model,'claude-auto[1m]');
  await assert.rejects(providerSettings.researchProviderMetadata(root,undefined,undefined,{...environment,RIGUP_MAX_OUTPUT_TOKENS:'0'}),/RIGUP_MAX_OUTPUT_TOKENS/);
 }finally{
  if(savedHome===undefined)delete process.env.HOME;else process.env.HOME=savedHome;
  if(savedProfile===undefined)delete process.env.USERPROFILE;else process.env.USERPROFILE=savedProfile;
 }
})));

test('interactive provider selection honors the explicit environment and its output cap',async()=>{
 const answers=['1',''];let output='';
 const selected=await providerSettings.promptResearchProvider({write:text=>output+=text,read:async()=>answers.shift()??null},'claude-auto[1m]',{
  ANTHROPIC_API_KEY:'fixture-private-key',RIGUP_MAX_OUTPUT_TOKENS:'24000',
 });
 assert.equal(selected?.apiKey,'fixture-private-key');assert.equal(selected?.identity.model,'claude-auto[1m]');assert.equal(selected?.maxOutputTokens,24_000);
 assert.doesNotMatch(output,/fixture-private-key/);
});

test('an existing v0.2.4 selection can enable research MCP without a provider',()=>project(async root=>project(async home=>{
 const cli=async(args:string[],expected:number)=>{
  let output='';
  const code=await runCli([...args,'--json'],{cwd:root,isTTY:false,write:value=>output+=value,services:{cacheRoot:join(home,'cache'),stateRoot:join(home,'state')}});
  assert.equal(code,expected,output);return JSON.parse(output);
 };
 await cli(['init','--agents','claude','--sdd','none','--backend','host'],0);
 await assert.rejects(()=>readFile(join(root,'.mcp.json')),{code:'ENOENT'});
 const migration=await cli(['update','--configure','--review'],3);
 assert.equal(migration.executable,true);assert.equal(migration.projectRules,'pending');
 await cli(['update','--apply',migration.previewId,'--sessions-ended'],0);
 assert.ok(JSON.parse(await readFile(join(root,'.mcp.json'),'utf8')).mcpServers.rigup);
})));
