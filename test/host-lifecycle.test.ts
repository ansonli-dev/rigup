import {test} from 'node:test';import assert from 'node:assert/strict';
import {project} from './helpers.js';import {mkdir,writeFile,readFile,readdir} from 'node:fs/promises';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {resolve} from 'node:path';
const exec=promisify(execFile);
test('multi_process_host_analyze_plan_two_candidates_acceptance_and_preview',()=>project(async root=>project(async home=>{
 // A subprocess has an isolated home/cache/state and actual native project entry fixtures.
 for(const name of ['openspec-propose','openspec-apply-change','openspec-archive-change']) {await mkdir(root+'/.agents/skills/'+name,{recursive:true});await writeFile(root+'/.agents/skills/'+name+'/SKILL.md','---\nname: '+name+'\ndescription: Native fixture\n---\nNative fixture\n');}
 await writeFile(root+'/source.ts','export const service = true;\n');
 const args=['--import','tsx',resolve('src/cli.ts'),'init',root,'--agents','codex','--sdd','openspec','--backend','host','--dry-run'];const env={...process.env,HOME:home};
 const seen:string[]=[];let response:string|undefined;let continuation:string|undefined;
 for(let round=0;round<8;round++) {
  let output='',code=0;try{output=(await exec(process.execPath,continuation?['--import','tsx',resolve('src/cli.ts'),'update',root,'--continue',continuation,'--response',response!]:args,{env})).stdout;}catch(e){output=(e as any).stdout;code=(e as any).code;}
  if(code===0){assert.equal(seen.length,6);assert.match(output,/Preview/);assert.doesNotMatch(output,/Blocked/);assert.equal(await readFile(root+'/source.ts','utf8'),'export const service = true;\n');assert.ok(!(await readdir(root)).includes('docs'));const previewId=output.match(/Preview ([a-f0-9]{64})/)![1];const applied=await exec(process.execPath,['--import','tsx',resolve('src/cli.ts'),'update',root,'--apply',previewId,'--sessions-ended'],{env});assert.match(applied.stdout,/Install complete/);assert.match(await readFile(root+'/docs/rigup/one.md','utf8'),/Service guidance/);const updated=await exec(process.execPath,args,{env});assert.doesNotMatch(updated.stdout,/Pending host/);return;}
  assert.equal(code,3,output);const path=output.match(/Pending host (?:research|generation): (.+)\n/)?.[1];assert.ok(path,output);continuation=output.match(/--continue ([a-f0-9]{64})/)![1];const request=JSON.parse(await readFile(path,'utf8'));const phase=request.context.expectedOutput??'analyze';seen.push(phase+':'+(request.context.artifact??''));
  let data:Record<string,unknown>={observations:[],unknowns:[],guidance:[]};
  if(phase==='plan')data={...data,artifacts:['one','two'].map(id=>({logicalId:id,target:'docs/rigup/'+id+'.md',purpose:'Guide scoped service checks',consumer:'change-deliver:review',required:true,reason:'Missing service guidance '+id,sourceRefs:[],seedPaths:['source.ts'],relatedArtifacts:[],acceptance:['Retain scope and unknowns']})),dispositions:[]};
  if(phase==='content')data.content='# Service guidance\n\nApplies only to source.ts. Other modules remain unknown.\n';
  if(phase==='acceptance'){data.accepted=true;data.reason='Scoped content inspected against evidence and gates';}
  response=path.replace('.request.json','.response.json');await writeFile(response,JSON.stringify({requestId:request.requestId,requestDigest:request.requestDigest,model:'host-fixture',data}),{mode:0o600});
 }
 assert.fail('host pipeline did not finish');
})));
import {spawn} from 'node:child_process';import {pathToFileURL} from 'node:url';
test('second_cli_cannot_mutate_active_generation_run_and_host_pending_releases_lock',()=>project(async root=>project(async home=>{
 const env={...process.env,HOME:home};const script=`import {executeLifecycle} from ${JSON.stringify(pathToFileURL(resolve('src/lifecycle.ts')).href)};await executeLifecycle(${JSON.stringify(root)},{agents:['codex'],sdd:'openspec',backend:'host'},{dryRun:true},s=>process.stdout.write(s),{backend:{run:async()=>{process.stdout.write('WAITING\\n');await new Promise(r=>{process.stdin.resume();process.stdin.once('end',r)});return {status:'pending-host',requestId:'pending',requestPath:'/private/request',nextCommand:'resume'}}}});`;
 const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',script],{env,stdio:['pipe','pipe','pipe']});let stdout='';await new Promise<void>((done,reject)=>{child.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.includes('WAITING'))done();});child.once('error',reject);child.once('exit',code=>{if(!stdout.includes('WAITING'))reject(Error('early child exit '+code));});});
 const runDir=home+'/.cache/rigup/runs';const files=await readdir(runDir);const before=await Promise.all(files.map(f=>readFile(runDir+'/'+f,'utf8')));
 try {await assert.rejects(()=>exec(process.execPath,['--import','tsx',resolve('src/cli.ts'),'init',root,'--agents','codex','--sdd','openspec','--backend','host','--dry-run'],{env}),e=>(e as any).code===1&&/locked/.test((e as any).stdout));assert.deepEqual(await Promise.all(files.map(f=>readFile(runDir+'/'+f,'utf8'))),before);}
 finally{const finished=new Promise(r=>child.once('exit',r));child.stdin.end();await finished;}
 const next=await exec(process.execPath,['--import','tsx',resolve('src/cli.ts'),'init',root,'--agents','codex','--dry-run'],{env});assert.match(next.stdout,/Preview/);
})));
