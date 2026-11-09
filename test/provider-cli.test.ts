import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {project} from './helpers.js';
import {runCli} from '../src/cli.js';

const configKeys=['HOME','USERPROFILE','RIGUP_PROVIDER','RIGUP_MODEL_ID','RIGUP_BASE_URL','RIGUP_API_KEY_ENV',
 'ANTHROPIC_API_KEY','ANTHROPIC_BASE_URL','ANTHROPIC_MODEL','OPENAI_API_KEY','OPENAI_BASE_URL','OPENAI_MODEL','FIXTURE_PROVIDER_TOKEN'];

test('the CLI applies a provider-free foundation, then uses private provider settings and an explicit model',()=>project(async root=>project(async home=>{
 const saved=configKeys.map(key=>process.env[key]);
 for(const key of configKeys)delete process.env[key];
 process.env.HOME=home;process.env.USERPROFILE=home;
 const calls:{model:string;stage:string;authorization:string|undefined}[]=[];
 const server=createServer(async(req,res)=>{
  try{
   assert.equal(req.url,'/custom/v1/chat/completions');
   let body='';for await(const chunk of req)body+=chunk;
   const {model,messages}=JSON.parse(body);
   const context=JSON.parse(messages[1].content);
   calls.push({model,stage:context.kind,authorization:req.headers.authorization});
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
  await writeFile(join(config,'provider.json'),JSON.stringify({provider:'openai-compatible',model:'private-default',apiKeyEnv:'FIXTURE_PROVIDER_TOKEN',baseURL:`http://127.0.0.1:${address.port}/custom/v1`}),{mode:0o600});
  process.env.FIXTURE_PROVIDER_TOKEN='private-fixture-token';process.env.RIGUP_MODEL_ID='env-default';
  process.env.ANTHROPIC_API_KEY='unrelated-fixture-key';
  const review=await cli(['update','--review','--model','override-model'],3);
  assert.equal(review.executable,true);assert.equal(review.projectRules,'ready');
  assert.deepEqual(calls,[{model:'override-model',stage:'analyze',authorization:'Bearer private-fixture-token'},
   {model:'override-model',stage:'artifact-plan',authorization:'Bearer private-fixture-token'}]);
  await cli(['update','--apply',review.previewId,'--sessions-ended'],0);
  const manifest=await readFile(join(root,'.rigup','manifest.json'),'utf8');
  assert.doesNotMatch(manifest,/override-model|FIXTURE_PROVIDER_TOKEN|private-fixture-token|127\.0\.0\.1/);
  const unchanged=await cli(['update','--review','--model','override-model'],3);
  assert.equal(calls.length,2);assert.ok(unchanged.items.every((item:{action:string})=>['noop','keep'].includes(item.action)),JSON.stringify(unchanged.items));
  assert.deepEqual((await cli(['update','--apply',unchanged.previewId,'--sessions-ended'],0)).written,[]);
  assert.equal(await readFile(join(root,'.rigup','manifest.json'),'utf8'),manifest);
 }finally{
  server.close();server.closeAllConnections();
  configKeys.forEach((key,index)=>{if(saved[index]===undefined)delete process.env[key];else process.env[key]=saved[index];});
 }
})));

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
