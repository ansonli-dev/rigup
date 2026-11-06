import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {parse} from 'yaml';
import {scanRepository} from '../src/analyzer/repository.js';
import {renderFixed} from '../src/generator/render.js';
import {prepareIntegrations} from '../src/integrations/registry.js';
import {prepareQuality} from '../src/integrations/tools/quality.js';
import {executeCheck} from '../src/integrations/tools/project-check.mjs';
import {project,setNativeEntries} from './helpers.js';

const options={agents:['codex' as const],backend:'host' as const,sdd:'openspec' as const};

test('a prepared workflow refers to native checks and emits no verification runtime',()=>project(async root=>{
 await mkdir(join(root,'src'));
 await writeFile(join(root,'package.json'),JSON.stringify({scripts:{'deps:validate':'node check.mjs'}}));
 await writeFile(join(root,'src','domain.ts'),"import './controller';\n");
 await writeFile(join(root,'check.mjs'),"import {readFileSync} from 'node:fs';if(readFileSync('src/domain.ts','utf8').includes('import')){console.error('error no-domain-to-api-deps: src/domain.ts → src/controller.ts');process.exitCode=7;}\n");
 const profile=await scanRepository(root,options);
 setNativeEntries(profile,{codex:['openspec-propose','openspec-apply-change','openspec-archive-change']});
 const assets=await renderFixed(profile,options,await prepareIntegrations(profile,options),[],[]);
 for(const name of ['change-prepare','change-deliver']){
  const context=assets.find(asset=>asset.target.endsWith(name+'/references/project.md'))!.content;
  assert.match(context,/npm run deps:validate/);
  assert.equal(context.match(/npm run deps:validate/g)?.length,1);
  assert.doesNotMatch(context,/check-worktree|check-results|rigup:receipt|acceptance-digest|npm:\.:/);
 }
 assert.ok(assets.every(asset=>!asset.target.startsWith('.rigup/scripts/')));
 const command=()=>spawnSync('npm',['run','deps:validate'],{cwd:root,encoding:'utf8'});
 const failed=command();
 assert.equal(failed.status,7);
 assert.match(failed.stderr,/no-domain-to-api-deps: src\/domain\.ts → src\/controller\.ts/);
 await writeFile(join(root,'src','domain.ts'),'export const domain = true;\n');
 assert.equal(command().status,0);
}));

test('optional installer checks bound inherited output when a detached child holds the pipes',()=>project(async root=>{
 await writeFile(join(root,'check.mjs'),"import {spawn} from 'node:child_process';spawn(process.execPath,['-e','setTimeout(()=>{},1100)'],{detached:true,stdio:'inherit'}).unref();\n");
 const result=await executeCheck({executable:process.execPath,args:['check.mjs'],cwd:'.',envRefs:[]},root,{timeoutMs:150});
 assert.equal(result.status,'pending');
 assert.match(result.reason,/timed out/);
 assert.ok(result.durationMs<900,JSON.stringify(result));
}));

test('native CI reuses explicitly selected npm scripts and deduplicates generic selection',()=>project(async root=>{
 await writeFile(join(root,'package.json'),JSON.stringify({scripts:{test:'node test.mjs','verify:contracts':'node verify-contracts.mjs'}}));
 const configured={...options,quality:{gitlab:{checks:['test' as const,{cwd:'.',script:'test'},{cwd:'.',script:'verify:contracts'}]}}};
 const prepared=await prepareQuality(await scanRepository(root,configured),configured);
 assert.deepEqual(prepared.requirements,[]);
 const job=parse(prepared.assets.find(asset=>asset.target==='.rigup/gitlab-ci.yml')!.content)['rigup:checks'];
 assert.equal(job.script.length,3);
 assert.match(job.script[1],/npm.*run.*test/);
 assert.match(job.script[2],/npm.*run.*verify:contracts/);
 assert.ok(prepared.assets.every(asset=>!asset.target.startsWith('.rigup/scripts/')));
}));
