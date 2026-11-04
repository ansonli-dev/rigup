import {mkdtemp,realpath,writeFile,readFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import type {Agent} from '../src/types.js';
import {scanRepository} from '../src/analyzer/repository.js';
import {generate} from '../src/generator/generate.js';
import {preview} from '../src/installer/preview.js';
import {apply} from '../src/installer/apply.js';
const exec=promisify(execFile);
export const live=process.env.RIGUP_LIVE==='1';
export const evidenceRoot=resolve(process.env.RIGUP_LIVE_EVIDENCE_DIR??'docs/compatibility/evidence/2026-11-04-live');
export async function record(name:string,value:unknown){await mkdir(evidenceRoot,{recursive:true});await writeFile(join(evidenceRoot,name+'.json'),JSON.stringify(value,null,2)+'\n');}
export async function disposable(prefix:string){return realpath(await mkdtemp(join(tmpdir(),prefix)));}
export async function nativeCanary(agent:Agent){
 const root=await disposable('rigup-native-'+agent+'-');const control=await disposable('rigup-native-control-');const startedAt=new Date().toISOString();
 const source=join(control,'canary-skill');await mkdir(source+'/references',{recursive:true});await writeFile(source+'/SKILL.md','---\nname: rigup-live-canary\ndescription: Read-only fixture skill used to validate native discovery.\n---\nRead [fixture guidance](references/guide.md). Report its exact fixture marker and, when requested, use the configured read-only rigup_echo tool with the same marker.\n');await writeFile(source+'/references/guide.md','Fixture scope only. Preserve human approval gates.\nMarker: RIGUP_REFERENCE_LOADED_20261104\n');
 const server=`import {appendFileSync} from 'node:fs';import readline from 'node:readline';const trace=process.argv[2];const lines=readline.createInterface({input:process.stdin});for await(const line of lines){let r;try{r=JSON.parse(line)}catch{continue}if(!('id' in r))continue;if(trace)appendFileSync(trace,JSON.stringify({method:r.method,tool:r.params?.name})+'\\n');let result;if(r.method==='initialize')result={protocolVersion:r.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'rigup-live-canary',version:'1.0.0'}};else if(r.method==='tools/list')result={tools:[{name:'rigup_echo',description:'Read-only fixture echo',inputSchema:{type:'object',properties:{message:{type:'string'}},required:['message']},annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}}]};else if(r.method==='tools/call')result={content:[{type:'text',text:r.params.arguments.message}]};else if(['resources/list','resources/templates/list','prompts/list'].includes(r.method))result={resources:[],resourceTemplates:[],prompts:[]};else result={};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');}`;
 await writeFile(root+'/canary-server.mjs',server);
 const options={agents:[agent],backend:'host' as const,customSkills:[{source}],mcp:[{id:'rigup-live-canary',agents:[agent],command:{executable:process.execPath,args:['canary-server.mjs',control+'/server-trace.jsonl'],cwd:'.',envRefs:[]}}]};
 const generated=await generate(await scanRepository(root,options),options,{run:async()=>{throw Error('Deterministic native canary must not call a model')}},[],{cacheRoot:control+'/generation'});if(generated.status!=='complete')throw Error('canary generation incomplete');
 const p=await preview(generated.value,[],{cacheRoot:control+'/previews'});const installed=await apply(p.previewId,{cacheRoot:control+'/previews',stateRoot:control+'/state'});if(installed.exitCode!==0)throw Error('canary installation incomplete');
 return {root,control,startedAt,source,server,installed};
}
export async function nativeCodexProbe(prepared?:Awaited<ReturnType<typeof nativeCanary>>){
 const {root,control,startedAt,server,installed}=prepared??await nativeCanary('codex');
 const home=control+'/client-home';await mkdir(home,{mode:0o700});await writeFile(home+'/config.toml','model = \"gpt-6.1-sol\"\nsandbox_mode = \"read-only\"\napproval_policy = \"never\"\n[projects.'+JSON.stringify(root)+']\ntrust_level = \"trusted\"\n');
 let child:ReturnType<typeof spawn>|undefined;const pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();let next=1,buffer='',stderr='';
 try{
  const version=(await exec('codex',['--version'])).stdout.trim();child=spawn('codex',['app-server'],{cwd:root,env:{PATH:process.env.PATH,HOME:home,CODEX_HOME:home,NO_COLOR:'1',LANG:'en_US.UTF-8'},detached:true,stdio:['pipe','pipe','pipe']});
  child.stdout!.on('data',chunk=>{buffer+=chunk;let index;while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);try{const message=JSON.parse(line);const item=pending.get(message.id);if(item){clearTimeout(item.timer);pending.delete(message.id);message.error?item.reject(Error(JSON.stringify(message.error))):item.resolve(message.result);}}catch{}}});
  child.stderr!.on('data',chunk=>stderr+=chunk);
  const request=(method:string,params:unknown):Promise<any>=>new Promise((done,reject)=>{const id=next++;const timer=setTimeout(()=>{pending.delete(id);reject(Error('Native client timeout: '+method));},30000);pending.set(id,{resolve:done,reject,timer});child!.stdin!.write(JSON.stringify({id,method,params})+'\n');});
  const initialized=await request('initialize',{clientInfo:{name:'rigup-live-acceptance',version:'0.1.0'},capabilities:{experimentalApi:true}});child.stdin!.write(JSON.stringify({method:'initialized',params:{}})+'\n');
  const skills=await request('skills/list',{cwds:[root],forceReload:true});const entry=skills.data?.find((d:any)=>d.cwd===root)??skills.data?.[0];const found=entry?.skills?.find((s:any)=>s.name==='rigup-live-canary');
  const thread=await request('thread/start',{cwd:root,ephemeral:true,approvalPolicy:'never',sandbox:'read-only',model:'gpt-6.1-sol'});const threadId=thread.thread?.id;
  const servers=await request('mcpServerStatus/list',{threadId,serverName:'rigup-live-canary'});const target=servers.data?.find((s:any)=>s.name==='rigup-live-canary');
  const called=await request('mcpServer/tool/call',{threadId,server:'rigup-live-canary',tool:'rigup_echo',arguments:{message:'rigup-native-canary-20261104'}});
  const echoed=JSON.stringify(called).includes('rigup-native-canary-20261104');
  return {caseId:'codex/none/customer-mcp',status:found&&target&&echoed?'passed':'failed',startedAt,finishedAt:new Date().toISOString(),version,fixture:root,fixtureDigest:createHash('sha256').update(server).digest('hex'),configuredByRigup:installed.status,skill:found?{name:found.name,path:found.path,scope:found.scope}:null,server:target?{name:target.name,toolNames:Object.keys(target.tools??{}),authStatus:target.authStatus}:null,echoed,scope:'Native app-server discovery, actual MCP initialization/list/call; no model or SDD gate inference',initialized:!!initialized};
 }catch(error){return {caseId:'codex/none/customer-mcp',status:'failed',startedAt,finishedAt:new Date().toISOString(),fixture:root,reason:(error as Error).message.slice(0,1000),stderr:stderr.slice(-2000)};}
 finally{for(const item of pending.values()){clearTimeout(item.timer);item.reject(Error('Native probe finished'));}if(child?.pid){try{process.kill(-child.pid,'SIGTERM')}catch{}}}
}

export async function nativeOpenCodeProbe(){
 const {root,control,startedAt,server,installed}=await nativeCanary('opencode');const home=control+'/client-home';await mkdir(home,{mode:0o700});const env={PATH:process.env.PATH,HOME:home,XDG_CONFIG_HOME:home+'/config',XDG_DATA_HOME:home+'/data',XDG_STATE_HOME:home+'/state',XDG_CACHE_HOME:home+'/cache',NO_COLOR:'1',LANG:'en_US.UTF-8'};
 try{
  const version=(await exec('opencode',['--version'])).stdout.trim();const skills=(await exec('opencode',['debug','skill'],{cwd:root,env,timeout:30000,maxBuffer:2_000_000})).stdout;const mcp=(await exec('opencode',['mcp','list'],{cwd:root,env,timeout:30000,maxBuffer:1_000_000})).stdout;
  let calls:any[]=[];try{calls=(await readFile(control+'/server-trace.jsonl','utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(line));}catch{}
  const discovered=skills.includes('rigup-live-canary')&&skills.includes(root+'/.opencode/skills/');const connected=calls.some(c=>c.method==='initialize')&&calls.some(c=>c.method==='tools/list');
  return {caseId:'opencode/none/customer-mcp',status:discovered&&connected?'passed':'failed',startedAt,finishedAt:new Date().toISOString(),version,fixture:root,fixtureDigest:createHash('sha256').update(server).digest('hex'),configuredByRigup:installed.status,skillDiscovered:discovered,mcpConnected:connected,mcpMethods:calls.map(c=>c.method),commands:[{executable:'opencode',args:['debug','skill'],cwd:root},{executable:'opencode',args:['mcp','list'],cwd:root}],clientOutput:mcp.replace(/\x1b\[[0-9;]*m/g,'').slice(0,1000),scope:'Actual OpenCode native discovery and MCP initialize/list. No model or SDD gate inference'};
 }catch(error){return {caseId:'opencode/none/customer-mcp',status:'failed',startedAt,finishedAt:new Date().toISOString(),fixture:root,reason:(error as Error).message.slice(0,1200)};}
}
export async function nativeOmpProbe(){
 const {root,control,startedAt,installed}=await nativeCanary('omp');const home=control+'/client-home';await mkdir(home,{mode:0o700});let child:ReturnType<typeof spawn>|undefined,stderr='',buffer='',next=1;const pending=new Map<string,{resolve:(value:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
 try{
  const version=(await exec('omp',['--version'])).stdout.trim();child=spawn('omp',['--mode','rpc','--no-session','--approval-mode','always-ask'],{cwd:root,env:{PATH:process.env.PATH,HOME:home,PI_CODING_AGENT_DIR:home+'/agent',NO_COLOR:'1',LANG:'en_US.UTF-8'},detached:true,stdio:['pipe','pipe','pipe']});
  child.stdout!.on('data',chunk=>{buffer+=chunk;let index;while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);try{const message=JSON.parse(line);const item=pending.get(message.id);if(item){clearTimeout(item.timer);pending.delete(message.id);message.success?item.resolve(message.data):item.reject(Error(message.error??'RPC failed'));}}catch{}}});child.stderr!.on('data',chunk=>stderr+=chunk);
  const request=(type:string):Promise<any>=>new Promise((done,reject)=>{const id=String(next++);const timer=setTimeout(()=>{pending.delete(id);reject(Error('OMP native RPC timeout: '+type));},30000);pending.set(id,{resolve:done,reject,timer});child!.stdin!.write(JSON.stringify({id,type})+'\n');});
  const commands=await request('get_available_commands');const state=await request('get_state');const skill=commands.commands?.find((c:any)=>JSON.stringify(c).includes('rigup-live-canary'));let calls:any[]=[];try{calls=(await readFile(control+'/server-trace.jsonl','utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(line));}catch{}
  const connected=calls.some(c=>c.method==='initialize')&&calls.some(c=>c.method==='tools/list');
  return {caseId:'omp/none/customer-mcp',status:skill&&connected?'passed':'failed',startedAt,finishedAt:new Date().toISOString(),version,fixture:root,configuredByRigup:installed.status,skill:skill?{name:skill.name,source:skill.source}:null,mcpConnected:connected,mcpMethods:calls.map(c=>c.method),toolNames:state.dumpTools?.map((t:any)=>t.name),commands:[{executable:'omp',args:['--mode','rpc','--no-session','--approval-mode','always-ask'],cwd:root}],scope:'Actual OMP session RPC; no model request or SDD gate inference'};
 }catch(error){return {caseId:'omp/none/customer-mcp',status:'pending',startedAt,finishedAt:new Date().toISOString(),fixture:root,reason:(error as Error).message.slice(0,1000),stderr:stderr.slice(-2000),scope:'Session startup/RPC unavailable under isolated configuration; no discovery pass inferred'};}
 finally{for(const item of pending.values()){clearTimeout(item.timer);item.reject(Error('Native probe finished'));}if(child?.pid)try{process.kill(-child.pid,'SIGTERM')}catch{}}
}
export async function nativeClaudeProbe(){
 const checkedAt=new Date().toISOString();let version:string|undefined;
 try{version=(await exec('claude',['--version'])).stdout.trim();let text='';try{text=(await exec('claude',['auth','status'],{timeout:15000})).stdout;}catch(error){text=(error as any).stdout??'';}let auth:any;try{auth=JSON.parse(text);}catch{}
  if(auth?.loggedIn!==true)return {caseId:'claude/none/customer-mcp',status:'pending',checkedAt,version,loggedIn:auth?.loggedIn,reason:'Claude authentication unavailable; native session discovery and MCP were not run'};
  const fixture=await nativeCanary('claude');await exec('git',['-C',fixture.root,'init','-q']);const args=['--print','/rigup-live-canary\nRead the installed skill and its referenced fixture guidance. Report the exact fixture marker and call the configured read-only rigup_echo with it. Do not edit files or run commands.','--setting-sources','user,project','--settings',JSON.stringify({disableAllHooks:true}),'--permission-mode','dontAsk','--permission-prompts','none','--tools','Read,Skill,ToolSearch','--allowedTools','Read,Skill,mcp__rigup-live-canary__rigup_echo','--strict-mcp-config','--mcp-config',fixture.root+'/.mcp.json','--no-session-persistence','--no-chrome','--max-budget-usd','1','--output-format','json'];
  const child=spawn('claude',args,{cwd:fixture.root,env:process.env,detached:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);const timer=setTimeout(()=>{if(child.pid)try{process.kill(-child.pid,'SIGTERM')}catch{}},90000);const exit=await new Promise<number|null>(done=>{child.once('error',()=>done(1));child.once('close',done)});clearTimeout(timer);
  await writeFile(fixture.control+'/claude-private.json',JSON.stringify({stdout,stderr}),{mode:0o600});let data:any;try{data=JSON.parse(stdout);}catch{}let calls:any[]=[];try{calls=(await readFile(fixture.control+'/server-trace.jsonl','utf8')).trim().split('\n').map(v=>JSON.parse(v));}catch{}
  const loaded=typeof data?.result==='string'&&data.result.includes('RIGUP_REFERENCE_LOADED_20261104');const connected=calls.some(c=>c.method==='initialize')&&calls.some(c=>c.method==='tools/list');const called=calls.some(c=>c.method==='tools/call'&&c.tool==='rigup_echo');
  return {caseId:'claude/none/customer-mcp',status:exit===0&&loaded&&connected&&called?'passed':'pending',checkedAt,finishedAt:new Date().toISOString(),version,loggedIn:true,fixture:fixture.root,commands:[{executable:'claude',args,cwd:fixture.root}],budget:{maxUsd:1,maxWallMs:90000},exit,loadedReferenceMarker:loaded,mcpConnected:connected,echoCalled:called,mcpMethods:calls,apiErrorStatus:data?.api_error_status,terminalReason:data?.terminal_reason,modelUsage:data?.modelUsage,totalCostUsd:data?.total_cost_usd,resultDigest:createHash('sha256').update(String(data?.result??'')).digest('hex'),reason:loaded&&connected&&called?undefined:'Native bounded session did not establish every discovery/reference/MCP claim; inspect fixture-local private transport evidence',scope:'Actual native skill/reference use with existing user authentication settings, hooks disabled and only Read/Skill/ToolSearch builtins and read-only customer MCP; no SDD gate inference'};
 }catch(error){return {caseId:'claude/none/customer-mcp',status:'pending',checkedAt,version,reason:'Native probe unavailable: '+(error as Error).message.slice(0,400)};}
}
