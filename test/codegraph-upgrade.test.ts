import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {project} from './helpers.js';
import {scanRepository} from '../src/analyzer/repository.js';
import {prepareIntegrations,type PreparedAsset} from '../src/integrations/registry.js';
import {preview} from '../src/installer/preview.js';
import {apply} from '../src/installer/apply.js';
import {equalOwnedContent,ownedContent} from '../src/installer/ownership.js';
import type {SetupPlan,SetupOptions} from '../src/types.js';

test('v0.4.1 managed CodeGraph bindings migrate in all four formats and then stay unchanged',()=>project(root=>project(cacheRoot=>project(async stateRoot=>{
 const historical=JSON.parse(await readFile(new URL('../docs/compatibility/fixtures/v0.4.1-codegraph.json',import.meta.url),'utf8')) as {release:string;commit:string;options:SetupOptions;assets:PreparedAsset[]};
 assert.equal(historical.release,'v0.4.1');assert.equal(historical.commit,'9447bf170af40a00d5284c32936db5be07d97ffb');
 assert.deepEqual(historical.assets.map(asset=>asset.target).sort(),['.codex/config.toml','.mcp.json','.omp/mcp.json','opencode.jsonc']);
 // The historical release supplies the owned bytes. Installation receipts and native
 // process behavior are exercised separately; this fixture isolates managed migration.
 const options:SetupOptions={agents:[],backend:'host'};
 const plan=async(assets:PreparedAsset[],update=false):Promise<SetupPlan>=>({root,options,fingerprint:(await scanRepository(root,options)).fingerprint,assets,operations:[],dispositions:update?assets.map(asset=>({logicalId:asset.logicalId,action:'update',reason:'Upgrade released binding'})):[],warnings:[],requirements:[],versions:{}});
 const initial=await preview(await plan(historical.assets),[],{cacheRoot});assert.equal(initial.executable,true);
 await apply(initial.previewId,{cacheRoot,stateRoot});
 // Preserve a customer field outside the managed key/table during the upgrade.
 const claude=join(root,'.mcp.json');const customer=JSON.parse(await readFile(claude,'utf8'));customer.customerSetting='keep';await writeFile(claude,JSON.stringify(customer,null,2)+'\n');
 const prepared=await prepareIntegrations(await scanRepository(root,historical.options),historical.options);
 const current=prepared.assets.filter(asset=>asset.logicalId.startsWith('mcp:')&&asset.logicalId.endsWith(':codegraph'));
 assert.equal(current.length,4);
 assert.ok(current.every(asset=>asset.content!==historical.assets.find(old=>old.logicalId===asset.logicalId)!.content));
 const approved=await preview(await plan(current,true),[],{cacheRoot});
 assert.equal(approved.executable,true,approved.blockers.join('\n'));
 const result=await apply(approved.previewId,{cacheRoot,stateRoot});assert.equal(result.status,'complete');assert.equal(result.written.length,4);
 for(const asset of current){const installed=ownedContent(await readFile(join(root,asset.target),'utf8'),asset.ownership);assert.ok(installed!==undefined&&equalOwnedContent(asset.ownership,installed,asset.content));}
 assert.equal(JSON.parse(await readFile(claude,'utf8')).customerSetting,'keep');
 const before=await Promise.all(current.map(asset=>readFile(join(root,asset.target))));
 const repeated=await preview(await plan(current,true),[],{cacheRoot,skipUnchanged:true});
 assert.equal(repeated.noChanges,true);
 assert.deepEqual(await Promise.all(current.map(asset=>readFile(join(root,asset.target)))),before);
}))));
