import type {Server} from 'node:http';
import {once} from 'node:events';

// https://fetch.spec.whatwg.org/#port-blocking (also enforced by Node's fetch).
const blockedPorts=new Set([0,1,7,9,11,13,15,17,19,20,21,22,23,25,37,42,43,53,69,77,79,87,95,101,102,103,104,109,110,111,113,115,117,119,123,135,137,139,143,161,179,389,427,465,512,513,514,515,526,530,531,532,540,548,554,556,563,587,601,636,989,990,993,995,1719,1720,1723,2049,3659,4045,4190,5060,5061,6000,6566,6665,6666,6667,6668,6669,6679,6697,10080]);

function closeServer(server:Server):Promise<void>{
 return new Promise((resolve,reject)=>{
  server.close(error=>{if(error&&(error as NodeJS.ErrnoException).code!=='ERR_SERVER_NOT_RUNNING')reject(error);else resolve();});
  server.closeAllConnections();
 });
}

export async function listenWorkflowServer(server:Server):Promise<string>{
 for(let attempt=0;attempt<20;attempt++){
  // Only a successful bind to a fetch-blocked port is retried. EACCES and
  // other bind failures must remain visible, including excluded port ranges.
  await once(server.listen(0,'127.0.0.1'),'listening');
  const address=server.address();
  if(address&&typeof address!=='string'&&!blockedPorts.has(address.port))return 'http://127.0.0.1:'+address.port;
  await closeServer(server);
  if(!address||typeof address==='string')throw Error('Loopback fixture did not bind');
 }
 throw Error('Could not bind a fetch-compatible loopback port after 20 attempts');
}

export async function closeWorkflowServer(server:Server,closeBackend:()=>Promise<void>,removeFixture:()=>Promise<void>){
 // Stop accepting requests immediately; finish every cleanup even if another
 // rejects. Remove files only after both listener and backend have settled.
 const results=await Promise.allSettled([closeServer(server),Promise.resolve().then(closeBackend)]);
 results.push(...await Promise.allSettled([Promise.resolve().then(removeFixture)]));
 const errors=results.filter(result=>result.status==='rejected').map(result=>result.reason);
 if(errors.length===1)throw errors[0];
 if(errors.length)throw new AggregateError(errors,'Workflow fixture cleanup failed');
}
