import {test} from 'node:test';
import assert from 'node:assert/strict';
import {selectResearchOutput,validateResearch,type RepositoryReader,type ResearchRequest} from '../src/analyzer/backend.js';
import {researchPrompt} from '../src/analyzer/prompts.js';

const request:ResearchRequest={kind:'analyze',runId:'fixture',root:process.cwd(),fingerprint:'fixture',
 options:{agents:['claude']},versions:{},budget:{maxCalls:2,maxTokens:1000},previousInventoryDigest:'none',templateSourcesDigest:'none'};
const reader:RepositoryReader={list:async()=>[],read:async()=>{throw Error('unexpected evidence');},search:async()=>[]};

test('research guidance documents and normalizes its string-array fields',async()=>{
 for(const field of ['scope','consumers','gaps'])assert.match(researchPrompt,new RegExp(field+' \\(string array\\)'));
 const result=selectResearchOutput(request,{guidance:[{topic:'Testing',coverageStatus:'missing',scope:'src',consumers:'test',gaps:'integration'}],observations:[],unknowns:[]});
 assert.deepEqual(result,{guidance:[{topic:'Testing',coverageStatus:'missing',scope:['src'],consumers:['test'],gaps:['integration']}],observations:[],unknowns:[]});
 await validateResearch(result,reader);
});

test('non-string guidance field members remain invalid',async()=>{
 for(const scope of [42,{},[42]]){
  const result=selectResearchOutput(request,{guidance:[{topic:'Testing',coverageStatus:'missing',scope,consumers:[],gaps:[]}],observations:[],unknowns:[]});
  await assert.rejects(()=>validateResearch(result,reader),/guidance: invalid source assessment/);
 }
});
