import type {Agent,SetupOptions} from './types.js';
import {askLine,promptCancelled,type Ask,type PromptIO} from './prompt.js';
import {agents} from './integrations/agents/index.js';

export type OnboardingIO=PromptIO;

export function restrictBindings(options:SetupOptions,explicitTools=false):void{
 const selected=(agents:Agent[])=>agents.filter(agent=>options.agents.includes(agent));
 if(options.tools)options.tools=options.tools.flatMap(tool=>{
  const agents=explicitTools?[...options.agents]:selected(tool.agents);
  return agents.length?[{...tool,agents}]:[];
 });
 if(options.mcp)options.mcp=options.mcp.flatMap(mcp=>{
  if(!mcp.agents)return [mcp];
  const agents=selected(mcp.agents);
  return agents.length?[{...mcp,agents}]:[];
 });
}

export async function onboard(initial:SetupOptions,io:OnboardingIO,settings:{
 configure:boolean;provided?:Partial<Record<'agents'|'sdd'|'tools',boolean>>;ask?:Ask;
 checkWorkflow?:(options:SetupOptions,back:boolean)=>Promise<'ready'|'back'|'stop'>;
 recommendSdd?:(options:SetupOptions)=>Promise<SetupOptions['sdd']>;
}):Promise<SetupOptions|null>{
 const options=structuredClone(initial);
 const ask=settings.ask??(question=>askLine(io,question));
 const stages=(['agents','sdd','native','tools'] as const).filter(stage=>stage==='native'||!settings.provided?.[stage]);
 for(let index=0;index<stages.length;index++){
  const stage=stages[index];
  const previous=stages.slice(0,index).findLastIndex(step=>step!=='native');
  const back=previous>=0;
  if(stage==='native'){
   const result=await settings.checkWorkflow?.(options,back);
   if(result==='stop')return null;
   if(result==='back'&&back)index=previous-1;
   continue;
  }
  if(stage==='agents'){
   const answer=await ask({message:'目标 agents',choices:Object.keys(agents),defaults:options.agents,multiple:true,back});
   if(answer===null)return null;
   if(Array.isArray(answer)&&answer.length)options.agents=answer as Agent[];
   else index--;
   continue;
  }
  if(stage==='sdd'){
   const recommended=await settings.recommendSdd?.(options);
   const answer=await ask({message:'原生 SDD',choices:['superpowers','openspec','spec-kit','none'],defaults:[recommended??options.sdd??'none'],back});
   if(answer===null)return null;
   if(answer==='back'){index=previous-1;continue;}
   if(answer[0]==='none')delete options.sdd;
   else options.sdd=answer[0] as SetupOptions['sdd'];
   continue;
  }
  const answer=await ask({message:'可选工具',choices:['openwiki','codegraph'],defaults:options.tools?.map(tool=>tool.id),multiple:true,empty:true,back});
  if(answer===null)return null;
  if(answer==='back'){index=previous-1;continue;}
  const selected:NonNullable<SetupOptions['tools']>=[];
  for(const id of answer){
   const old=options.tools?.find(tool=>tool.id===id);
   if(old){selected.push(id==='openwiki'?{...old,initialize:false}:old);continue;}
   selected.push({id:id as 'openwiki'|'codegraph',install:true,initialize:id==='codegraph',agents:[...options.agents]});
  }
  if(selected.length||settings.configure||options.tools)options.tools=selected;
 }
 restrictBindings(options,settings.provided?.tools);
 return options;
}

export async function promptNativeCredentials(options:SetupOptions,io:PromptIO,initial:{apiKey?:string;model?:string}|undefined,environment:NodeJS.ProcessEnv){
 const credentials={...initial};
 let model=options.model?.model??credentials.model??environment.RIGUP_MODEL_ID??environment.ANTHROPIC_MODEL;
 while(!model){
  io.write('Anthropic model ID (Esc to cancel)\n');
  const value=await io.read();
  if(promptCancelled(value))return null;
  model=value.trim();
 }
 const apiKeyEnv=options.model?.apiKeyEnv??environment.RIGUP_API_KEY_ENV??'ANTHROPIC_API_KEY';
 while(!credentials.apiKey&&!environment[apiKeyEnv]&&!process.env[apiKeyEnv]){
  io.write('Enter '+apiKeyEnv+' for this run only (Esc to cancel)\n');
  const secret=await io.read(true);
  if(promptCancelled(secret))return null;
  credentials.apiKey=secret.trim();
 }
 options.model={provider:options.model?.provider??'anthropic',model,apiKeyEnv};
 return {...credentials,model};
}
