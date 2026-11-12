import type {IncomingMessage,ServerResponse} from 'node:http';
import {startLiveSession,type LiveSession} from './live-process-support.js';

// One disposable repository, served on the fixture's existing loopback listener.
// Native Windows MXC cannot run the MSYS shell used by Git's local-path transport.
export function workflowGitHttp(control:string,env:NodeJS.ProcessEnv){
 const sessions=new Set<LiveSession>(),requests=new Set<Promise<void>>();let closing=false;
 const reject=(res:ServerResponse,status:number)=>{if(!res.destroyed){res.writeHead(status);res.end('Local Git fixture request rejected');}};
 async function serve(req:IncomingMessage,res:ServerResponse,url:URL){
  const chunks:Buffer[]=[];let size=0;
  for await(const chunk of req){size+=chunk.length;if(size>2_000_000){reject(res,413);return;}chunks.push(Buffer.from(chunk));}
  if(closing){reject(res,503);return;}
  const input=Buffer.concat(chunks),session=await startLiveSession('git',['http-backend'],{cwd:control,env:{...env,
   GIT_PROJECT_ROOT:control.replaceAll('\\','/'),GIT_HTTP_EXPORT_ALL:'1',REQUEST_METHOD:req.method,
   PATH_INFO:url.pathname,QUERY_STRING:url.search.slice(1),CONTENT_TYPE:req.headers['content-type']??'',CONTENT_LENGTH:String(input.length),
   REMOTE_ADDR:'127.0.0.1',REMOTE_USER:'rigup-local-fixture',SERVER_PROTOCOL:'HTTP/1.1',GATEWAY_INTERFACE:'CGI/1.1',
   HTTP_GIT_PROTOCOL:req.headers['git-protocol']==='version=2'?'version=2':'',
  }});
  sessions.add(session);const output:Buffer[]=[];let bytes=0,overflow=false,timedOut=false;
  const timer=setTimeout(()=>{timedOut=true;void session.stop().catch(()=>{});},10000);
  session.stdout.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>2_000_000){overflow=true;void session.stop().catch(()=>{});}else output.push(Buffer.from(chunk));});
  session.stderr.resume();
  try{
   session.stdin.end(input);const code=await session.completed;
   if(code!==0||overflow||timedOut)throw Error('Local Git backend did not complete');
   const data=Buffer.concat(output);let end=data.indexOf('\r\n\r\n'),separator=4;if(end<0){end=data.indexOf('\n\n');separator=2;}
   if(end<0)throw Error('Local Git backend omitted response headers');
   let status=200;const headers:Record<string,string>={};
   for(const line of data.subarray(0,end).toString().split(/\r?\n/)){
    const colon=line.indexOf(':');if(colon<1)continue;const name=line.slice(0,colon),value=line.slice(colon+1).trim();
    if(name.toLowerCase()==='status')status=Number(value.slice(0,3));else headers[name]=value;
   }
   if(!res.destroyed){res.writeHead(status,headers);res.end(data.subarray(end+separator));}
  }finally{clearTimeout(timer);sessions.delete(session);}
 }
 return {
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
