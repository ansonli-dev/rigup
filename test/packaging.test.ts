import {test} from 'node:test';import assert from 'node:assert/strict';import {packagedIndependence} from './packaging-support.js';
test('installed_assets_work_without_cli_or_its_dependencies',async()=>{
 const report=await packagedIndependence();
 assert.equal(report.rigupRemoved,true);
 assert.equal(report.nativeEcho,true);
 assert.equal(report.hookResult,0);
 assert.match(report.skillContent,/rigup-live-canary/);
 assert.ok(report.archiveFiles.every((path:string)=>!path.startsWith('templates/scripts/')));
 assert.ok(report.archiveFiles.includes('dist/integrations/tools/project-check.mjs'));
 assert.ok(report.archiveFiles.includes('docs/compatibility/upstream-lock.json'));
});
