import {test} from 'node:test';import assert from 'node:assert/strict';
import {live,nativeCodexProbe,record} from './live-support.js';
test('live Codex native skill discovery and customer MCP connection',{skip:!live},async()=>{
 const report=await nativeCodexProbe();await record('codex-none-customer-mcp',report);assert.equal(report.status,'passed',JSON.stringify(report));
});
import {nativeOpenCodeProbe,nativeOmpProbe} from './live-support.js';
test('live OpenCode native discovery and MCP connection',{skip:!live},async()=>{const report=await nativeOpenCodeProbe();await record('opencode-none-customer-mcp',report);assert.equal(report.status,'passed',JSON.stringify(report));});
test('live OMP session discovery and MCP connection',{skip:!live},async t=>{const report=await nativeOmpProbe();await record('omp-none-customer-mcp',report);if(report.status==='pending'){t.skip(report.reason);return;}assert.equal(report.status,'passed',JSON.stringify(report));});
import {packagedIndependence} from './packaging-support.js';
test('live packaged assets stay discoverable after CLI and dependencies are removed',{skip:!live},async()=>{const report=await packagedIndependence(true);await record('packaged-independent-assets-codex',report);assert.equal(report.status,'passed');assert.equal(report.native.status,'passed',JSON.stringify(report.native));});
import {nativeClaudeProbe} from './live-support.js';
test('live Claude native prerequisites',{skip:!live},async t=>{const report=await nativeClaudeProbe();await record('claude-none-customer-mcp',report);if(report.status==='pending'){t.skip(report.reason);return;}assert.equal(report.status,'passed');});
import {nativeGateProbe} from './live-gates-support.js';
test('live Codex OpenSpec fixed delivery gate consumes customer reference',{skip:!live||process.env.RIGUP_LIVE_GATE!=='1'},async()=>{const report=await nativeGateProbe();assert.equal(report.status,'passed',JSON.stringify(report));});
