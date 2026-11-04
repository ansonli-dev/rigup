import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,writeFile} from 'node:fs/promises';
const exec=promisify(execFile);
export async function codexNativeTools(root:string,control:string){
 const home=control+'/codex-home';await mkdir(home,{mode:0o700});await writeFile(home+'/config.toml','approval_policy = "never"\nsandbox_mode = "workspace-write"\n[projects.'+JSON.stringify(root)+']\ntrust_level = "trusted"\n');
 const version=(await exec('codex',['--version'])).stdout.trim();
 const child=spawn('codex',['app-server'],{cwd:root,env:{PATH:process.env.PATH,HOME:home,CODEX_HOME:home,XDG_CONFIG_HOME:home,NO_COLOR:'1',LANG:'en_US.UTF-8',DO_NOT_TRACK:'1',OPENWIKI_TELEMETRY_DISABLED:'1',CODEGRAPH_NO_DAEMON:'1',CODEGRAPH_NO_DOWNLOAD:'1'},detached:true,stdio:['pipe','pipe','pipe']});
 const pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();let id=0,buffer='',stderr='';
 const exited=new Promise<void>(done=>{child.once('exit',()=>done());child.once('error',()=>done());});
 child.stdout.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);try{const message=JSON.parse(line);const item=pending.get(message.id);if(item){clearTimeout(item.timer);pending.delete(message.id);message.error?item.reject(Error(JSON.stringify(message.error))):item.resolve(message.result);}}catch{}}});
 child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-5000);});
 const request=(method:string,params:unknown):Promise<any>=>new Promise((resolve,reject)=>{const n=++id;const timer=setTimeout(()=>{pending.delete(n);reject(Error('Codex RPC timeout: '+method));},45000);pending.set(n,{resolve,reject,timer});child.stdin.write(JSON.stringify({id:n,method,params})+'\n');});
 try{
  await request('initialize',{clientInfo:{name:'rigup-native-tools-acceptance',version:'0.1.0'},capabilities:{experimentalApi:true}});child.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');
  // No turn is started and no model is selected or invoked.
  const thread=await request('thread/start',{cwd:root,ephemeral:true,approvalPolicy:'never',sandbox:'workspace-write'});const threadId=thread.thread.id;
  const servers=await request('mcpServerStatus/list',{threadId});
  const names=servers.data.map((s:any)=>({name:s.name,tools:Object.keys(s.tools??{})}));
  const search=await request('mcpServer/tool/call',{threadId,server:'codegraph',tool:'codegraph_explore',arguments:{query:'createOrder',projectPath:root}});
  const begin=await request('mcpServer/tool/call',{threadId,server:'openwiki',tool:'openwiki_begin',arguments:{root,mode:'init'}});
  return {version,servers:names,search,begin,modelCalls:0};
 }catch(error){throw Error((error as Error).message+'; Codex stderr: '+stderr);}
 finally{
  for(const item of pending.values()){clearTimeout(item.timer);item.reject(Error('Codex fixture closed'));}pending.clear();
  if(child.pid){try{process.kill(-child.pid,'SIGTERM');}catch{}}
  const force=setTimeout(()=>{if(child.pid)try{process.kill(-child.pid,'SIGKILL');}catch{}},3000);await exited;clearTimeout(force);
 }
}
