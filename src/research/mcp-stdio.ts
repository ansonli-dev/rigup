import {once} from 'node:events';
import type {Readable,Writable} from 'node:stream';
import {resolve} from 'node:path';
import {readFile} from 'node:fs/promises';
import {isRecord} from '../private-record.js';
import {openResearchMcp} from './mcp-workflow.js';
import type {Agent} from '../types.js';

const hosts:readonly string[]=['claude','codex','opencode','omp'];
const versions=['2025-11-25','2025-06-18','2025-03-26','2024-11-05'];
const maxMessageBytes=300_000;
const string={type:'string'};
const runId={runId:string};
const submission={...runId,jobId:string,data:{type:'object'}};
const schema=(properties:Record<string,unknown>,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
const tools=[
 {name:'rigup_begin',description:'Start or resume research for the installed project. Use the returned job and its instructions.',inputSchema:schema({root:string,mode:{type:'string',enum:['init','update']},language:string},['root','mode'])},
 {name:'rigup_submit_plan',description:'Submit the analysis or plan JSON for the matching planning job. Cite paths and exact line ranges.',inputSchema:schema(submission)},
 {name:'rigup_next_page',description:'Read the current job or determine whether research is ready to finish.',inputSchema:schema(runId)},
 {name:'rigup_submit_page',description:'Submit document, rulebook or independent acceptance JSON for the matching job.',inputSchema:schema(submission)},
 {name:'rigup_finish',description:'Get the preview and terminal handoff. Review any proposed removals before including their IDs. The tool only prepares a preview.',inputSchema:schema({...runId,retireIds:{type:'array',items:string,maxItems:128}},['runId'])},
];

async function* messages(input:Readable){
 let parts:Buffer[]=[],length=0,overLimit=false;
 for await(const data of input){
  const chunk=Buffer.isBuffer(data)?data:Buffer.from(data);
  let offset=0;
  for(let end=chunk.indexOf(10,offset);end!==-1;end=chunk.indexOf(10,offset)){
   const tail=chunk.subarray(offset,end);
   if(overLimit||length+tail.length>maxMessageBytes)yield undefined;
   else yield Buffer.concat([...parts,tail]).toString('utf8');
   parts=[];length=0;overLimit=false;offset=end+1;
  }
  if(offset===chunk.length||overLimit)continue;
  const tail=chunk.subarray(offset);
  length+=tail.length;
  if(length>maxMessageBytes){parts=[];overLimit=true;}
  else parts.push(tail);
 }
}

export async function serveResearchMcp(args:string[],io:{cwd:string;input:Readable;output:Writable}):Promise<void>{
 const index=args.indexOf('--host');
 const host=args[index+1];
 if((index!==0&&index!==1)||index!==args.length-2||!hosts.includes(host))throw Error('Usage: rigup mcp [project] --host claude|codex|opencode|omp');
 const root=resolve(io.cwd,index===1?args[0]:'.');
 const workflow=await openResearchMcp(root,host as Agent);
 const {version}=JSON.parse(await readFile(new URL('../../package.json',import.meta.url),'utf8'));
 const send=async(value:object)=>{
  if(!io.output.write(JSON.stringify({jsonrpc:'2.0',...value})+'\n'))await once(io.output,'drain');
 };
 const failure=(id:string|number|null,code:number,message:string)=>send({id,error:{code,message}});
 let negotiated=false,initialized=false;
 for await(const line of messages(io.input)){
  if(line===undefined){await failure(null,-32600,'Message is too large');continue;}
  let request:unknown;
  try{request=JSON.parse(line);}catch{await failure(null,-32700,'Invalid JSON');continue;}
  if(!isRecord(request)||request.jsonrpc!=='2.0'||typeof request.method!=='string'){
   await failure(null,-32600,'Invalid request');continue;
  }
  const {id,method,params}=request;
  if(id===undefined){if(method==='notifications/initialized'&&negotiated)initialized=true;continue;}
  if(typeof id!=='string'&&typeof id!=='number'){await failure(null,-32600,'Invalid request ID');continue;}
  const respond=(result:unknown)=>send({id,result});
  if(method==='initialize'){
   if(negotiated||!isRecord(params)||typeof params.protocolVersion!=='string'){await failure(id,-32602,'Invalid initialize request');continue;}
   negotiated=true;
   await respond({protocolVersion:versions.includes(params.protocolVersion)?params.protocolVersion:versions[0],capabilities:{tools:{}},serverInfo:{name:'rigup',version}});
  }else if(method==='ping')await respond({});
  else if(!initialized)await failure(id,-32002,'Rigup MCP is not initialized');
  else if(method==='tools/list')await respond({tools});
  else if(method==='tools/call'){
   if(!isRecord(params)||typeof params.name!=='string'){await failure(id,-32602,'Invalid tool call');continue;}
   const tool=tools.find(tool=>tool.name===params.name);
   const args=params.arguments??{};
   if(!tool||!isRecord(args)||Object.keys(args).some(key=>!Object.hasOwn(tool.inputSchema.properties,key))||tool.inputSchema.required.some(key=>!Object.hasOwn(args,key))){
    await failure(id,-32602,'Invalid Rigup tool or arguments');continue;
   }
   try{
    const result=await workflow.call(params.name,args);
    await respond({content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result});
   }catch(error){
    const message=error instanceof Error?error.message.slice(0,750):'Rigup research failed';
    await respond({content:[{type:'text',text:message}],isError:true});
   }
  }else await failure(id,-32601,'Method not found');
 }
}
