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
 if(!timesOut)assert.equal(result.body,'fixture refs');
});
