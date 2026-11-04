import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createWriteStream} from 'node:fs';
import {access,mkdir,mkdtemp,readFile,readdir,realpath,writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname,join,resolve} from 'node:path';

const exec=promisify(execFile),commit='9506629ed003a561c6627735480cce4994244bb4';
const sha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
const options={agents:['codex'],backend:'codex',sdd:'openspec',executionPolicy:{mode:'review'},tools:[{id:'openwiki',install:true,initialize:false,agents:['codex']},{id:'codegraph',install:true,initialize:true,agents:['codex']}],researchBudget:{maxCalls:12,maxTokens:1200000},readBudget:{maxFiles:4000,maxBytes:24000000},scope:['AGENTS.md','README.md','package.json','docs','apps/react-vite','.agents','openspec']};
test('live Bulletproof React completes semantic setup within its unchanged budget',{skip:process.env.RIGUP_LIVE_BULLETPROOF_CONTEXT!=='1',timeout:1800000},async()=>{
 const workspace=await realpath(process.env.RIGUP_E2E_WORKSPACE??await mkdtemp('/private/tmp/rigup-context-e2e-'));
 assert.ok(workspace.startsWith('/private/tmp/rigup-context-e2e-'),'use a dedicated disposable workspace');
 const cli=await realpath(process.env.RIGUP_E2E_CLI!),openspec=process.env.RIGUP_OPENSPEC_BIN!;assert.ok(cli.endsWith('/rigup/dist/cli.js'));
 const root=workspace+'/frontend',home=workspace+'/home',out=process.env.RIGUP_LIVE_EVIDENCE_DIR??'docs/compatibility/evidence/2026-11-05-context-budget';
 const authRoot=process.env.CODEX_HOME??join(homedir(),'.codex');await mkdir(home,{recursive:true,mode:0o700});
 const env={...process.env,HOME:home,CODEX_HOME:authRoot,XDG_CONFIG_HOME:home+'/config',DO_NOT_TRACK:'1',OPENSPEC_TELEMETRY:'0',NO_COLOR:'1'};delete env.ANTHROPIC_API_KEY;delete env.ANTHROPIC_MODEL;
 let record:any;try{record=JSON.parse(await readFile(workspace+'/result.json','utf8'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 record??={caseId:'github-project/frontend/context-budget',status:'running',startedAt:new Date().toISOString(),workspace,root,commit,options,steps:[],limitations:['Actual default Codex model; its served model ID is not exposed.','Application/native-host checks are recorded separately from this semantic CLI flow.','Formal human semantic approval is not implied by execution success.']};
 assert.deepEqual(record.options,options,'resuming the same case cannot increase its budget or alter scope');
 const persist=()=>writeFile(workspace+'/result.json',JSON.stringify(record,null,2)+'\n',{mode:0o600});
 const budgetDir=home+'/.local/state/rigup/codex';
 const ledgers=async()=>{let files:string[]=[];try{files=await readdir(budgetDir);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}return Object.fromEntries(await Promise.all(files.filter(f=>f.endsWith('.usage.json')).sort().map(async f=>[f,JSON.parse(await readFile(join(budgetDir,f),'utf8'))])));};
 const usage=(values:any)=>{const attempts=Object.values(values).flatMap((v:any)=>Object.values(v.attempts)) as any[];return {calls:attempts.length,tokens:attempts.some(a=>a.tokens==='unknown')?'unknown':attempts.reduce((n,a)=>n+a.tokens,0)};};
 const run=async(label:string,args:string[])=>{
  const before=usage(await ledgers());assert.ok(before.calls<=12&&before.tokens!=='unknown'&&Number(before.tokens)<=1200000,'retain all charged attempts before continuing');
  const stdoutFile=createWriteStream(join(workspace,label+'.stdout.json'),{mode:0o600}),stderrFile=createWriteStream(join(workspace,label+'.stderr.log'),{mode:0o600});let stdout='';
  const startedAt=new Date().toISOString();const child=spawn(cli,args,{cwd:root,env,stdio:['ignore','pipe','pipe']});child.stdout.on('data',chunk=>{stdout+=chunk;stdoutFile.write(chunk);});child.stderr.pipe(stderrFile);
  const timer=setTimeout(()=>child.kill('SIGINT'),25*60*1000);const code=await new Promise<number|null>((done,reject)=>{child.once('error',reject);child.once('exit',done);});clearTimeout(timer);stdoutFile.end();stderrFile.end();
  const data=JSON.parse(stdout);record.steps.push({label,args,startedAt,finishedAt:new Date().toISOString(),code,data});await persist();return {code,data};
 };
 try{
  try{await access(root+'/.git');}catch{await exec('git',['-c','credential.helper=','-c','core.hooksPath=/dev/null','clone','--no-hardlinks','--no-tags',process.env.RIGUP_E2E_SOURCE??'https://github.com/alan2207/bulletproof-react.git',root],{env:{...env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'},timeout:120000});}
  assert.equal((await exec('git',['-C',root,'rev-parse','HEAD'])).stdout.trim(),commit);
  const packageRoot=resolve(dirname(cli),'..');record.package={name:JSON.parse(await readFile(packageRoot+'/package.json','utf8')).name,sourceRevision:process.env.RIGUP_E2E_SOURCE_REVISION??'unknown',cliSha256:sha(await readFile(cli)),hostSha256:sha(await readFile(packageRoot+'/dist/analyzer/host.js'))};assert.equal(record.package.name,'rigup');
  let marker:any;try{marker=JSON.parse(await readFile(workspace+'/fixture.json','utf8'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  if(!marker){
   assert.equal((await exec('git',['-C',root,'diff','HEAD','--name-only'])).stdout,'');await assert.rejects(access(root+'/.rigup/config.yaml'));
   assert.equal((await exec(openspec,['--version'])).stdout.trim(),'1.16.0');await exec(openspec,['init','--tools','codex','--profile','core','--no-animation','--no-copilot-cloud'],{cwd:root,env,timeout:30000,maxBuffer:1000000});
   await mkdir(root+'/.rigup',{recursive:true});await writeFile(root+'/.rigup/config.yaml',JSON.stringify(options,null,2)+'\n');
   const files=(await exec('git',['-C',root,'ls-files','-z'])).stdout.split('\0').filter(Boolean);assert.equal(files.length,535);
   const originalHashes=Object.fromEntries(await Promise.all(files.map(async path=>[path,sha(await readFile(join(root,path)))])));
   const nativeHashes:Record<string,string>={};for(const dir of await readdir(root+'/.agents/skills'))if(dir.startsWith('openspec-'))nativeHashes['.agents/skills/'+dir+'/SKILL.md']=sha(await readFile(root+'/.agents/skills/'+dir+'/SKILL.md'));
   marker={root,commit,options,originalHashes,nativeHashes};await writeFile(workspace+'/fixture.json',JSON.stringify(marker,null,2)+'\n',{mode:0o600});
  }
  assert.equal(marker.root,root);assert.equal(marker.commit,commit);assert.deepEqual(marker.options,options);assert.deepEqual(JSON.parse(await readFile(root+'/.rigup/config.yaml','utf8')),options);
  await persist();
  let manifest:any;try{manifest=JSON.parse(await readFile(root+'/.rigup/manifest.json','utf8'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  if(!manifest){
   const prepared=await run('01-semantic-preview',['init',root,'--resume','--json']);assert.equal(prepared.code,3,JSON.stringify(prepared.data));assert.equal(prepared.data.phase,'handoff');assert.equal(prepared.data.executable,true);assert.ok(prepared.data.operations.every((o:any)=>o.id!=='initialize:openwiki'));
   const applied=await run('02-independent-apply',['update',root,'--apply',prepared.data.previewId,'--sessions-ended','--resume','--json']);assert.equal(applied.code,0,JSON.stringify(applied.data));
   manifest=JSON.parse(await readFile(root+'/.rigup/manifest.json','utf8'));
  }
  assert.equal(manifest.options.sdd,'openspec');assert.equal(manifest.options.backend,'codex');assert.deepEqual(manifest.options.researchBudget,{maxCalls:12,maxTokens:1200000});assert.deepEqual(Object.keys(manifest.initializedTools),['codegraph']);await assert.rejects(access(root+'/openwiki'));await assert.rejects(access(root+'/.rigup/native/openwiki'));
  const before=await ledgers();const counts=usage(before);assert.ok(counts.calls>0&&counts.calls<=12);assert.ok(typeof counts.tokens==='number'&&counts.tokens<=1200000);
  const unchanged=await run('03-unchanged-preview',['update',root,'--dry-run','--sessions-ended','--json']);assert.equal(unchanged.code,0,JSON.stringify(unchanged.data));assert.deepEqual(unchanged.data.operations,[]);assert.ok(unchanged.data.items.every((i:any)=>i.action==='keep'));
  const applied=await run('04-unchanged-apply',['update',root,'--apply',unchanged.data.previewId,'--sessions-ended','--json']);assert.equal(applied.code,0,JSON.stringify(applied.data));assert.deepEqual(applied.data.written,[]);assert.deepEqual(await ledgers(),before);
  const reference=manifest.assets.find((a:any)=>a.target.endsWith('change-deliver/references/project.md'));assert.ok(reference);const refPath=join(root,reference.target),note='\nLocal E2E note: preserve this user-maintained addition.\n';const ref=await readFile(refPath,'utf8');if(!ref.endsWith(note))await writeFile(refPath,ref+note);
  const protectedPreview=await run('05-local-note',['update',root,'--dry-run','--sessions-ended','--json']);assert.equal(protectedPreview.code,0,JSON.stringify(protectedPreview.data));assert.ok((await readFile(refPath,'utf8')).endsWith(note));assert.deepEqual(await ledgers(),before);
  const originalChanges=[];for(const [path,hash] of Object.entries(marker.originalHashes)){const body=await readFile(join(root,path));if(sha(body)===hash)continue;assert.equal(path,'AGENTS.md');const original=(await exec('git',['-C',root,'show','HEAD:AGENTS.md'])).stdout;assert.ok(body.toString().includes(original));originalChanges.push({path,originalContentRetained:true});}
  for(const [path,hash] of Object.entries(marker.nativeHashes))assert.equal(sha(await readFile(join(root,path))),hash);
  const exchange=home+'/.cache/rigup/codex/exchange',measurements=[];
  for(const file of await readdir(exchange,{recursive:true}))if(file.endsWith('.request.json')){
   const requestPath=join(exchange,file),raw=await readFile(requestPath,'utf8'),body=JSON.parse(raw);
   assert.equal(body.context.evidencePolicy,'dependency-manifests-v1');assert.deepEqual(body.context.budget,{maxCalls:12,maxTokens:1200000});assert.deepEqual(body.context.options.scope,options.scope);
   assert.ok(body.paths.includes('apps/react-vite/yarn.lock'));assert.ok(body.omittedEvidence.some((o:any)=>o.path==='apps/react-vite/yarn.lock'));assert.ok(!body.evidence.some((e:any)=>e.evidence.path==='apps/react-vite/yarn.lock'));
   assert.ok(Buffer.byteLength(raw)<600000,'full lock content must not reappear in nested stage context');
   measurements.push({requestId:body.requestId,kind:body.context.kind,expectedOutput:body.context.expectedOutput??'analysis',bytes:Buffer.byteLength(raw),inventoryFiles:body.paths.length,evidenceFiles:body.evidence.length,evidenceChars:body.evidence.reduce((n:number,e:any)=>n+e.content.length,0),omittedEvidence:body.omittedEvidence});
  }
  assert.ok(measurements.some(m=>m.kind==='analyze'));assert.ok(measurements.some(m=>m.expectedOutput==='plan'));
  const jobs=manifest.assets.filter((a:any)=>a.source.kind==='semantic');if(jobs.length){assert.ok(measurements.some(m=>m.expectedOutput==='content'));assert.ok(measurements.some(m=>m.expectedOutput==='acceptance'));}
  record.requests=measurements;record.usage=before;record.actualModelCalls=counts.calls;record.actualObservedTokens=counts.tokens;record.semanticAssets=jobs.map((a:any)=>a.target);record.sourceProtection={trackedFiles:535,changes:originalChanges,nativeEntriesUnchanged:Object.keys(marker.nativeHashes).length};record.unchangedUpdate={written:0,newModelCalls:0};record.localNoteProtected=true;record.openWikiNativeStateCreated=false;record.status='passed';delete record.reason;
 }catch(error){record.status='failed';record.reason=(error as Error).message;record.usage=await ledgers();throw error;}
 finally{record.finishedAt=new Date().toISOString();await persist();await mkdir(out,{recursive:true});await writeFile(join(out,'bulletproof-semantic-e2e.json'),JSON.stringify(record,null,2)+'\n');}
});
