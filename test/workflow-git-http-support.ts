import {workflowGitBackendTimeoutMs} from './workflow-timeouts.js';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {startLiveSession,type LiveSession} from './live-process-support.js';
import {fixtureDiagnostic,fixtureError} from './fixture-diagnostics.js';

// One disposable repository, served on the fixture's existing loopback listener.
// Native Windows MXC cannot run the MSYS shell used by Git's local-path transport.
export function workflowGitHttp(control:string,env:NodeJS.ProcessEnv,startSession=startLiveSession){
 const sessions=new Set<LiveSession>(),requests=new Set<Promise<void>>();let closing=false;
 const failures:string[]=[];
 const active=new Map<object,()=>string>();
 const reject=(res:ServerResponse,status:number)=>{if(!res.destroyed){res.writeHead(status);res.end('Local Git fixture request rejected');}};
 async function serve(req:IncomingMessage,res:ServerResponse,url:URL){
  const started=performance.now(),info={method:req.method,path:url.pathname,phase:'request-body',timeoutMs:workflowGitBackendTimeoutMs,timedOut:false,overflow:false,clientDisconnected:false,exitCode:null as number|null,httpStatus:null as number|null,stdoutBytes:0,stderrBytes:0,stderr:''};
  let session:LiveSession|undefined,timer:ReturnType<typeof setTimeout>|undefined,stop:Promise<void>|undefined;
  const interrupt=()=>{if(session&&!stop){stop=session.stop();void stop.catch(()=>{});}};
  const record=(error:unknown,cleanup?:unknown)=>{
   failures.push(fixtureDiagnostic({...info,stderr:fixtureDiagnostic(info.stderr,[control]).slice(0,1024),elapsedMs:Math.round(performance.now()-started),error:fixtureError(error,[control]).slice(0,1000),...(cleanup?{stopError:fixtureError(cleanup,[control]).slice(0,1000)}:{})},[control]));
   if(failures.length>8)failures.shift();
  };
  active.set(info,()=>fixtureDiagnostic({...info,stderr:fixtureDiagnostic(info.stderr,[control]).slice(0,1024),elapsedMs:Math.round(performance.now()-started),pending:true},[control]));
  try{
  const chunks:Buffer[]=[];let size=0;
  for await(const chunk of req){size+=chunk.length;if(size>2_000_000){info.httpStatus=413;record(Error('Local Git request input exceeded its limit'));reject(res,413);return;}chunks.push(Buffer.from(chunk));}
  if(closing){reject(res,503);return;}
  info.phase='start';
  const input=Buffer.concat(chunks);session=await startSession('git',['http-backend'],{cwd:control,env:{...env,
   GIT_PROJECT_ROOT:control.replaceAll('\\','/'),GIT_HTTP_EXPORT_ALL:'1',REQUEST_METHOD:req.method,
   PATH_INFO:url.pathname,QUERY_STRING:url.search.slice(1),CONTENT_TYPE:req.headers['content-type']??'',CONTENT_LENGTH:String(input.length),
   REMOTE_ADDR:'127.0.0.1',REMOTE_USER:'rigup-local-fixture',SERVER_PROTOCOL:'HTTP/1.1',GATEWAY_INTERFACE:'CGI/1.1',
   HTTP_GIT_PROTOCOL:req.headers['git-protocol']==='version=2'?'version=2':'',
  }});
  sessions.add(session);
  if(closing||res.destroyed){info.clientDisconnected=res.destroyed;throw Error('Local Git request ended during backend startup');}
  info.phase='backend';const output:Buffer[]=[];
  const interrupted=new Promise<never>((_,reject)=>{
   timer=setTimeout(()=>{info.timedOut=true;interrupt();reject(Error('Local Git backend deadline expired'));},workflowGitBackendTimeoutMs);
   session!.stdout.on('data',(chunk:Buffer)=>{info.stdoutBytes+=chunk.length;if(info.stdoutBytes>2_000_000){info.overflow=true;interrupt();reject(Error('Local Git backend output exceeded its limit'));}else output.push(Buffer.from(chunk));});
   session!.stderr.on('data',(chunk:Buffer)=>{info.stderrBytes+=chunk.length;info.stderr+=(chunk.toString()).slice(0,2048-info.stderr.length);});
   res.once('close',()=>{if(!res.writableEnded){info.clientDisconnected=true;interrupt();reject(Error('Local Git client disconnected'));}});
  });
   session.stdin.end(input);info.exitCode=await Promise.race([session.completed,interrupted]);
   if(stop)await stop;
   if(info.clientDisconnected)throw Error('Local Git client disconnected');
   if(info.exitCode!==0||info.overflow||info.timedOut)throw Error('Local Git backend did not complete');
   info.phase='cgi';
   const data=Buffer.concat(output);let end=data.indexOf('\r\n\r\n'),separator=4;if(end<0){end=data.indexOf('\n\n');separator=2;}
   if(end<0)throw Error('Local Git backend omitted response headers');
   let status=200;const headers:Record<string,string>={};
   for(const line of data.subarray(0,end).toString().split(/\r?\n/)){
    const colon=line.indexOf(':');if(colon<1)continue;const name=line.slice(0,colon),value=line.slice(colon+1).trim();
    if(name.toLowerCase()==='status')status=Number(value.slice(0,3));else headers[name]=value;
   }
   info.httpStatus=status;if(status>=400)record(Error('Local Git CGI response HTTP '+status));
   info.phase='response';if(!res.destroyed){res.writeHead(status,headers);res.end(data.subarray(end+separator));}
  }catch(error){
   interrupt();let cleanup:unknown;
   try{await stop;}catch(failure){cleanup=failure;}
   record(error,cleanup);throw error;
  }finally{clearTimeout(timer);active.delete(info);if(session)sessions.delete(session);}
 }
 return {
  diagnostics:()=>[...failures,...[...active.values()].map(read=>read())].slice(-8).join('\n'),
  async handle(req:IncomingMessage,res:ServerResponse){
   const url=new URL(req.url??'/','http://127.0.0.1');
   if(url.pathname!=='/origin.git'&&!url.pathname.startsWith('/origin.git/'))return false;
   const allowed=req.method==='GET'&&url.pathname==='/origin.git/info/refs'&&['service=git-receive-pack','service=git-upload-pack'].includes(url.search.slice(1))||
    req.method==='POST'&&['/origin.git/git-receive-pack','/origin.git/git-upload-pack'].includes(url.pathname)&&!url.search;
   if(!allowed){reject(res,404);return true;}
   if(closing){reject(res,503);return true;}
   const work=serve(req,res,url).catch(()=>reject(res,500));requests.add(work);
   try{await work;}finally{requests.delete(work);}return true;
  },
  async close(){closing=true;await Promise.all([...sessions].map(session=>session.stop()));await Promise.all(requests);},
 };
}
