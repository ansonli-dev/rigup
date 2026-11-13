import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,get} from 'node:http';
import {PassThrough} from 'node:stream';
import {setImmediate as immediate} from 'node:timers/promises';
import {workflowGitHttp} from './workflow-git-http-support.js';
import {listenWorkflowServer,closeWorkflowServer} from './workflow-server-support.js';

for(const timesOut of [false,true])test('workflow Git backend '+(timesOut?'still stops an over-budget process':'accepts a slow successful process'),async t=>{
 let finish!:(code:number)=>void,ready!:()=>void,stopped=false;
 const started=new Promise<void>(resolve=>{ready=resolve;}),completed=new Promise<number>(resolve=>{finish=resolve;});
 const stdout=new PassThrough(),stderr=new PassThrough(),stdin=new PassThrough();
 const backend=workflowGitHttp('.',{},async()=>{
  t.mock.timers.enable({apis:['setTimeout']});
  ready();
  return {stdin,stdout,stderr,completed,async stop(){stopped=true;finish(1);}};
 });
 const server=createServer((req,res)=>{void backend.handle(req,res);});
 t.after(async()=>{t.mock.timers.reset();finish(1);await closeWorkflowServer(server,()=>backend.close(),async()=>{});});
 const url=await listenWorkflowServer(server);
 const response=new Promise<{status:number;body:string}>((resolve,reject)=>{
  get(url+'/origin.git/info/refs?service=git-upload-pack',res=>{
   let body='';res.setEncoding('utf8').on('data',chunk=>{body+=chunk;});
   res.on('end',()=>resolve({status:res.statusCode!,body}));
  }).on('error',reject);
 });
 await started;await immediate();
 // Virtual time models startup/security-hook latency without slowing the suite.
 t.mock.timers.tick(timesOut?60_001:process.platform==='win32'?25_000:5000);
 if(!timesOut){stdout.end('Content-Type: text/plain\r\n\r\nfixture refs');finish(0);}
 const result=await response;
 assert.equal(result.status,timesOut?500:200);
 assert.equal(stopped,timesOut);
 if(timesOut){assert.match(backend.diagnostics(),/"timedOut":true/);assert.match(backend.diagnostics(),/deadline expired|did not complete/);}
 if(!timesOut)assert.equal(result.body,'fixture refs');
});

for(const fault of ['exit','headers','overflow','completion','disconnect'] as const)test('workflow Git backend diagnoses '+fault+' and stops its session',async t=>{
 let finish!:(code:number)=>void,fail!:(error:Error)=>void,ready!:()=>void,stopped=false;
 const started=new Promise<void>(resolve=>{ready=resolve;}),completed=new Promise<number>((resolve,reject)=>{finish=resolve;fail=reject;});
 const stdout=new PassThrough(),stderr=new PassThrough(),stdin=new PassThrough();
 const backend=workflowGitHttp('/private/fixture',{},async()=>{ready();return {stdin,stdout,stderr,completed,async stop(){stopped=true;finish(1);if(fault==='completion')throw Error('shutdown confirmation failed');}};});
 let handled!:()=>void;const finished=new Promise<void>(resolve=>{handled=resolve;});
 const server=createServer((req,res)=>{void backend.handle(req,res).finally(handled);});
 t.after(async()=>{finish(1);await closeWorkflowServer(server,()=>backend.close(),async()=>{});});
 const url=await listenWorkflowServer(server);
 let client:ReturnType<typeof get>;
 const response=new Promise<number>(resolve=>{client=get(url+'/origin.git/info/refs?service=git-upload-pack',res=>{res.resume();res.on('end',()=>resolve(res.statusCode!));});client.on('error',()=>resolve(0));});
 await started;await immediate();stderr.end('fatal fixture backend /private/fixture/config Bearer private-token');
 if(fault==='disconnect')client!.destroy();
 else if(fault==='completion')fail(Error('backend completion failed'));
 else if(fault==='overflow')stdout.end(Buffer.alloc(2_000_001));
 else{stdout.end(fault==='headers'?'missing headers':'Content-Type: text/plain\r\n\r\nbody');finish(fault==='exit'?128:0);}
 assert.equal(await response,fault==='disconnect'?0:500);
 await finished;
 const diagnostic=backend.diagnostics();
 assert.equal(stopped,true);assert.match(diagnostic,/"timedOut":false/);assert.match(diagnostic,/fatal fixture backend/);
 assert.ok(!diagnostic.includes('/private/fixture'));assert.ok(!diagnostic.includes('private-token'));assert.ok(diagnostic.length<=8000);
 assert.match(diagnostic,fault==='exit'?/"exitCode":128/:fault==='headers'?/omitted response headers/:fault==='overflow'?/"overflow":true/:fault==='completion'?/shutdown confirmation failed/:/client disconnected/);
 if(fault==='completion')assert.match(diagnostic,/backend completion failed/);
});

test('workflow Git startup retains pending evidence and stops a session arriving after disconnect',async t=>{
 let ready!:()=>void,release!:(session:any)=>void,finish!:(code:number)=>void,handled!:()=>void,disconnected!:()=>void,stopped=false;
 const started=new Promise<void>(resolve=>{ready=resolve;}),completed=new Promise<number>(resolve=>{finish=resolve;}),finished=new Promise<void>(resolve=>{handled=resolve;}),closed=new Promise<void>(resolve=>{disconnected=resolve;});
 const backend=workflowGitHttp('.',{},async()=>{ready();return new Promise(resolve=>{release=resolve;});});
 const server=createServer((req,res)=>{res.once('close',disconnected);void backend.handle(req,res).finally(handled);});
 t.after(async()=>{finish(1);await closeWorkflowServer(server,()=>backend.close(),async()=>{});});
 const url=await listenWorkflowServer(server),client=get(url+'/origin.git/info/refs?service=git-upload-pack',res=>res.resume());client.on('error',()=>{});
 await started;client.destroy();await closed;
 assert.match(backend.diagnostics(),/"phase":"start"/);assert.match(backend.diagnostics(),/"pending":true/);
 const stdin=new PassThrough();let input=false;stdin.on('data',()=>{input=true;});
 release({stdin,stdout:new PassThrough(),stderr:new PassThrough(),completed,async stop(){stopped=true;finish(1);}});
 await finished;
 assert.equal(stopped,true);assert.equal(input,false,'a disconnected request cannot dispatch late CGI input');
 assert.match(backend.diagnostics(),/"clientDisconnected":true/);assert.match(backend.diagnostics(),/ended during backend startup/);
});
