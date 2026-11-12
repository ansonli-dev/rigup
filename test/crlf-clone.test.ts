import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {project} from './helpers.js';
import {scanRepository} from '../src/analyzer/repository.js';
import {generateFoundation,prepareGeneration} from '../src/generator/generate.js';
import {preview} from '../src/installer/preview.js';
import {apply} from '../src/installer/apply.js';
import {doctor} from '../src/installer/doctor.js';
import {loadManifest} from '../src/installer/baseline.js';

const exec=promisify(execFile),options={agents:['claude' as const,'codex' as const],backend:'host' as const,projectRules:true};
async function plan(root:string){const profile=await scanRepository(root,options);return generateFoundation(profile,options,await prepareGeneration(profile,options),(await loadManifest(root))?.assets??[]);}
test('real autocrlf clone adopts file block JSON and TOML without rewriting user bytes',()=>project(source=>project(workspace=>project(cacheRoot=>project(async stateRoot=>{
 await exec('git',['init','--quiet',source]);
 const initial=await preview(await plan(source),[],{cacheRoot});await apply(initial.previewId,{cacheRoot,stateRoot});
 await writeFile(join(source,'CLAUDE.md'),'customer prefix\n'+await readFile(join(source,'CLAUDE.md'),'utf8')+'customer suffix\n');
 await exec('git',['-C',source,'add','.']);
 await exec('git',['-C',source,'-c','user.name=Rigup Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','--quiet','-m','generated fixture']);
 const root=join(workspace,'clone');
 await exec('git',['clone','--quiet','--no-local','--config','core.autocrlf=true',source,root]);
 assert.equal(await loadManifest(root),undefined);
 const targets=['CLAUDE.md','.rigup/rigup-mcp.mjs','.mcp.json','.codex/config.toml','.rigup/.gitignore'];
 const before=await Promise.all(targets.map(target=>readFile(join(root,target))));
 assert.ok(before.every(bytes=>bytes.includes(Buffer.from('\r\n'))));
 const approved=await preview(await plan(root),[],{cacheRoot});assert.equal(approved.executable,true,approved.blockers.join('\n'));
 await apply(approved.previewId,{cacheRoot,stateRoot});
 assert.deepEqual(await Promise.all(targets.map(target=>readFile(join(root,target)))),before);
 const report=await doctor(root,{stateRoot});const assets=(await loadManifest(root))!.assets;
 assert.ok(assets.every(asset=>report.diagnostics.some(d=>d.id===asset.logicalId&&d.state==='configured')));
 assert.equal((await preview(await plan(root),[],{cacheRoot,skipUnchanged:true,reviewEntryBlocks:true})).noChanges,true);
})))))
