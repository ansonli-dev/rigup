import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {test} from 'node:test';
import {parse} from 'smol-toml';
import {scanRepository} from '../src/analyzer/repository.js';
import {loadOptions,validateOptions} from '../src/config.js';
import {doctor} from '../src/installer/doctor.js';
import {prepareIntegrations} from '../src/integrations/registry.js';
import {prepareCustomerMcp} from '../src/integrations/tools/customer-mcp.js';
import type {SetupOptions} from '../src/types.js';
import {project} from './helpers.js';

const url='https://tools.example.test/mcp';
const remote={id:'workspace',agents:['claude' as const],url};
const authenticated={...remote,bearerTokenEnv:'RIGUP_TEST_MCP_BEARER'};

test('HTTPS MCP configuration maps only a bearer environment reference into each native host',()=>project(async root=>{
 const directory=join(root,'.rigup');
 await mkdir(directory);
 await writeFile(join(directory,'config.yaml'),`
agents: [claude, codex, opencode, omp]
backend: host
mcp:
  - id: workspace
    agents: [claude, codex, opencode, omp]
    url: ${url}
    bearerTokenEnv: RIGUP_TEST_MCP_BEARER
`);
 const prior=process.env.RIGUP_TEST_MCP_BEARER;
 process.env.RIGUP_TEST_MCP_BEARER='fake-bearer-value';
 try{
  const options=await loadOptions(root,{});
  const prepared=await prepareIntegrations(await scanRepository(root,options),options);
  const assets=new Map(prepared.assets.filter(asset=>asset.source.kind==='customer-mcp').map(asset=>[asset.target,asset.content]));
  assert.deepEqual(JSON.parse(JSON.stringify(parse(assets.get('.codex/config.toml')!))),{mcp_servers:{workspace:{url,bearer_token_env_var:'RIGUP_TEST_MCP_BEARER'}}});
  const http={type:'http',url,headers:{Authorization:'Bearer ${RIGUP_TEST_MCP_BEARER}'}};
  for(const target of ['.mcp.json','.omp/mcp.json'])assert.deepEqual(JSON.parse(assets.get(target)!),http);
  assert.deepEqual(JSON.parse(assets.get('opencode.jsonc')!),{type:'remote',url,enabled:true,oauth:false,headers:{Authorization:'Bearer {env:RIGUP_TEST_MCP_BEARER}'}});
  assert.deepEqual(prepared.requirements,[]);
  assert.deepEqual(prepared.operations,[]);
  assert.doesNotMatch(JSON.stringify(prepared),/fake-bearer-value/);
 }finally{
  if(prior===undefined)delete process.env.RIGUP_TEST_MCP_BEARER;
  else process.env.RIGUP_TEST_MCP_BEARER=prior;
 }
}));

test('MCP bearer references require a literal HTTPS endpoint and a single environment name',()=>project(async root=>{
 const rejected:[NonNullable<SetupOptions['mcp']>[number],RegExp][]=[
  [{...authenticated,url:'http://tools.example.test/mcp'},/HTTPS/],
  [{...authenticated,url:'https://${HOST}/mcp'},/literal HTTPS/],
  [{...authenticated,url:'https://tools.example.test/{env:ROUTE}'},/literal HTTPS/],
  [{...authenticated,url:'https://tools.example.test/mcp#credential'},/literal HTTPS/],
  [{...authenticated,url:'https://user:private@tools.example.test/mcp'},/credential/i],
  [{...authenticated,url:'https://tools.example.test/mcp?access_token=private'},/credential/i],
  [{...authenticated,bearerTokenEnv:'${RIGUP_TEST_MCP_BEARER}'},/environment reference/],
  [{...authenticated,bearerTokenEnv:'fake-bearer-value'},/environment reference/],
  [{...authenticated,envRefs:['OTHER_TOKEN']},/remote authentication/],
  [{...authenticated,url:undefined,command:{executable:'node',args:[],cwd:'.',envRefs:[]}},/HTTPS/],
 ];
 for(const [item,error] of rejected){
  assert.throws(()=>validateOptions({mcp:[item]}),error);
  await assert.rejects(()=>prepareCustomerMcp(root,item),error);
 }
 for(const field of ['headers','bearerToken'])assert.throws(()=>validateOptions({mcp:[{...authenticated,[field]:'private'}]}),/unknown field/);
}));

test('legacy unauthenticated remote configuration remains usable while remote envRefs require an adapter',()=>project(async root=>{
 const legacy={...remote,url:'http://tools.example.test/mcp',envRefs:[]};
 assert.doesNotThrow(()=>validateOptions({mcp:[legacy]}));
 const result=await prepareCustomerMcp(root,legacy);
 assert.deepEqual(JSON.parse(result.assets[0].content),{type:'http',url:legacy.url});
 await assert.rejects(()=>prepareCustomerMcp(root,{...remote,envRefs:['OTHER_TOKEN']}),/remote authentication mapping requires explicit adapter/);
}));

test('doctor checks a remote bearer environment reference without exposing its value',()=>project(async root=>project(async state=>{
 const directory=join(root,'.rigup');
 await mkdir(directory);
 await writeFile(join(directory,'manifest.json'),JSON.stringify({schemaVersion:1,installId:'fixture',assets:[],options:{agents:[],backend:'host',mcp:[authenticated]}}));
 const prior=process.env.RIGUP_TEST_MCP_BEARER;
 const check=async()=>{
  const report=await doctor(root,{stateRoot:state});
  assert.doesNotMatch(JSON.stringify(report),/fake-bearer-value/);
  return report.diagnostics.find(item=>item.id==='env:RIGUP_TEST_MCP_BEARER')?.state;
 };
 try{
  delete process.env.RIGUP_TEST_MCP_BEARER;
  assert.equal(await check(),'pending');
  process.env.RIGUP_TEST_MCP_BEARER='fake-bearer-value';
  assert.equal(await check(),'pending');
 }finally{
  if(prior===undefined)delete process.env.RIGUP_TEST_MCP_BEARER;
  else process.env.RIGUP_TEST_MCP_BEARER=prior;
 }
})));
