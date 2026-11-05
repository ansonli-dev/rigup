import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {access,mkdir,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {delimiter,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {extractRelease,isolatedEnvironment} from './check.mjs';
const exec=promisify(execFile);
export async function checkNativeRelease({archive}) {
  const workspace=await realpath(await mkdtemp(join(tmpdir(),'rigup-portable-native-')));let complete=false;
  try{
    const installation=await extractRelease(resolve(archive),workspace);
    const info=JSON.parse(await readFile(join(installation,'BUILD_INFO.json'),'utf8'));
    const cli=join(installation,'rigup'),node=join(installation,'lib/node/bin/node');
    const project=join(workspace,'project');await mkdir(join(project,'src'),{recursive:true});await writeFile(join(project,'src/order.js'),'export function createOrder(id) { return {id}; }\n');
    const env=await isolatedEnvironment(workspace);
    const reports=[];
    const run=async(args,expected)=>{let result;try{result=await exec(cli,args,{cwd:project,env,timeout:600_000,maxBuffer:4_000_000});result.code=0;}catch(error){result=error;}assert.equal(result.code,expected,result.stderr);const report=JSON.parse(result.stdout);reports.push({args,exitCode:result.code,phase:report.phase,installStatus:report.installStatus});return report;};
    const preview=await run(['init','--agents','codex','--sdd','none','--tools','openwiki,codegraph','--review','--json'],3);
    assert.equal(preview.executable,true);assert.ok(preview.warnings.some(w=>w.includes('openwiki_begin')));assert.deepEqual(preview.operations.map(o=>o.id),['install:openwiki','install:codegraph','initialize:codegraph']);
    const installed=await run(['update','--apply',preview.previewId,'--sessions-ended','--json'],0);assert.equal(installed.installStatus,'complete');
    const manifest=JSON.parse(await readFile(join(project,'.rigup/manifest.json'),'utf8'));
    assert.equal(manifest.installedTools.openwiki.version,'0.7.3');assert.equal(manifest.installedTools.codegraph.version,'1.6.2');assert.ok(manifest.initializedTools.codegraph);assert.equal(manifest.initializedTools.openwiki,undefined);
    await assert.rejects(access(join(project,'openwiki')));
    const queryBin=await realpath(join(project,'.rigup/tools/codegraph/node_modules/.bin/codegraph'));
    const query=JSON.parse((await exec(node,[queryBin,'query','createOrder','--path',project,'--json'],{cwd:project,env:{...env,PATH:join(installation,'lib/node/bin')+delimiter+env.PATH,CODEGRAPH_NO_DAEMON:'1',CODEGRAPH_NO_DOWNLOAD:'1',DO_NOT_TRACK:'1'},timeout:60_000,maxBuffer:2_000_000})).stdout);
    assert.match(JSON.stringify(query),/createOrder/);assert.match(JSON.stringify(query),/src\/order\.js/);
    const unchanged=await run(['update','--dry-run','--json'],0);assert.deepEqual(unchanged.operations,[]);
    const noOp=await run(['update','--sessions-ended','--json'],0);assert.deepEqual(noOp.written,[]);
    const after=JSON.parse(await readFile(join(project,'.rigup/manifest.json'),'utf8'));assert.deepEqual(after.initializedTools,manifest.initializedTools);
    let daemon={outcome:'no-daemon-record'};
    const hasDaemon=await access(join(project,'.codegraph/daemon.pid')).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
    if(hasDaemon){
      const registry=pathToFileURL(join(project,'.rigup/tools/codegraph/node_modules',`@colbymchenry/codegraph-${process.platform}-${process.arch}`,'lib/dist/mcp/daemon-registry.js')).href;
      const code='const m=await import(process.argv[1]);console.log(JSON.stringify(await m.stopDaemonAt(process.argv[2],{preserveUnverified:true})));';
      daemon=JSON.parse((await exec(node,['--input-type=module','-e',code,registry,project],{cwd:project,env,timeout:30_000})).stdout);
      assert.ok(!['unverified','still-running'].includes(daemon.outcome),'Daemon exit must be verified before cleanup');
    }
    complete=true;
    return {status:'passed',target:info.target,version:info.version,source:info.source,runtime:info.runtime,systemNodeOrNpmOnCliPath:false,pinnedSoftwareInstalled:['openwiki@0.7.3','codegraph@1.6.2'],codegraphInitialized:true,businessQuery:true,noOpReinitialized:false,openwikiScaffoldInitialization:false,openwikiHandoff:true,daemonCleanup:daemon,reports,modelCalls:0};
  }catch(error){error.message+=' (retained native fixture: '+workspace+')';throw error;}
  finally{if(complete)await rm(workspace,{recursive:true,force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{if(process.argv.length!==3)throw Error('Usage: node scripts/release/check-native.mjs archive.tar.gz');console.log(JSON.stringify(await checkNativeRelease({archive:process.argv[2]})));}catch(error){console.error(error.message);process.exitCode=1;}
}
