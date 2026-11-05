import type {SetupOptions} from './types.js';
import {promptChoice} from './prompt.js';
export interface OnboardingIO {write(text:string):void;read(secret?:boolean):Promise<string|null>}
export async function onboard(initial:SetupOptions,io:OnboardingIO,settings:{configure:boolean;knownBackend:boolean;apiKeyEnv?:string;provided?:Partial<Record<'agents'|'sdd'|'tools'|'model',boolean>>;credentials?:{apiKey?:string;model?:string}}):Promise<{options:SetupOptions;credentials:{apiKey?:string;model?:string}}|null>{
 const options=structuredClone(initial);let credentials={...settings.credentials};let stage=!options.agents.length||settings.configure||!settings.knownBackend||settings.provided?0:4;
 const provided=settings.configure?{}:{...settings.provided};let knownBackend=settings.knownBackend;
 const goBack=(previous:number)=>{stage=previous;for(const key of (['agents','sdd','tools','model'] as const).filter((_,i)=>i>=previous))delete provided[key];if(previous<=3)knownBackend=false;};
 const list=async(title:string,choices:string[],defaults:string[]=[])=>{io.write(title+(defaults.length?' [Enter: '+defaults.join(', ')+']':'')+'; b 返回，Esc/EOF 取消\n');return promptChoice(io,choices,false,defaults);};
 while(stage<5){
  if(stage===0){if(provided.agents){stage++;continue;}const answer=await list('目标 agents（可多选）',['claude','codex','opencode','omp'],options.agents);if(answer===null)return null;if(answer==='back')return null;if(!Array.isArray(answer)||!answer.length)continue;
   if(JSON.stringify(answer)!==JSON.stringify(options.agents)){if(!provided.sdd)delete options.sdd;if(!provided.model){delete options.model;credentials={};}options.tools=options.tools?.map(t=>({...t,agents:settings.provided?.tools&&!settings.configure?[...answer] as SetupOptions['agents']:t.agents.filter(a=>answer.includes(a))}));options.mcp=options.mcp?.map(m=>({...m,agents:m.agents.filter(a=>answer.includes(a))})).filter(m=>m.agents.length);}
   options.agents=answer as SetupOptions['agents'];stage++;continue;
  }
  if(stage===1){if(provided.sdd){stage++;continue;}const answer=await list('原生 SDD；缺入口会报告待办，不伪造流程',['superpowers','openspec','spec-kit','none'],[options.sdd??'none']);if(answer===null)return null;if(answer==='back'){goBack(0);continue;}if(!Array.isArray(answer)||answer.length!==1)continue;if(answer[0]==='none')delete options.sdd;else options.sdd=answer[0] as SetupOptions['sdd'];stage++;continue;}
  if(stage===2){if(provided.tools){stage++;continue;}const answer=await list('可选工具；OpenWiki 安装接线后单独初始化，CodeGraph 项目安装包含受保护索引',['openwiki','codegraph','none'],options.tools?.length?options.tools.map(t=>t.id):['none']);if(answer===null)return null;if(answer==='back'){goBack(1);continue;}if(!Array.isArray(answer)||answer.includes('none')&&answer.length>1)continue;
   const selected:NonNullable<SetupOptions['tools']>=[];let back=false;
   for(const id of answer.filter(x=>x!=='none')){const old=options.tools?.find(t=>t.id===id);if(old){selected.push({...old,agents:old.agents.length?old.agents:[...options.agents],...(id==='openwiki'?{initialize:false}:{})});continue;}const mode=await list(id+'：作用于当前所选 agents',['pinned-project-install','register-existing-binary'],['pinned-project-install']);if(mode===null)return null;if(mode==='back'){back=true;break;}if(!Array.isArray(mode)||mode.length!==1){back=true;break;}selected.push({id:id as 'openwiki'|'codegraph',install:mode[0]==='pinned-project-install',initialize:id==='codegraph'&&mode[0]==='pinned-project-install',agents:[...options.agents]});}
   if(back)continue;options.tools=selected.length?selected:undefined;stage++;continue;
  }
  if(stage===3){if(!options.sdd||knownBackend&&!settings.configure){stage++;continue;}const answer=await list('语义研究后端：codex 使用本机登录；native 使用 Anthropic；host 交换请求文件',['codex','native','host'],[options.backend]);if(answer===null)return null;if(answer==='back'){goBack(2);continue;}if(!Array.isArray(answer)||answer.length!==1)continue;if(options.backend!==answer[0]){delete options.model;credentials={};}options.backend=answer[0] as SetupOptions['backend'];stage++;continue;}
  if(!options.sdd||options.backend!=='native'){stage++;continue;}
  let model=options.model?.model??credentials.model??process.env.ANTHROPIC_MODEL;
  if(!model){io.write('Anthropic model ID（非密钥；b 返回）\n');const value=await io.read();if(value===null||value==='\x1b')return null;if(value==='b'||value==='back'){goBack(3);continue;}if(!value.trim())continue;model=value.trim();}
  const apiKeyEnv=settings.apiKeyEnv??options.model?.apiKeyEnv??'ANTHROPIC_API_KEY';options.model={provider:'anthropic',model,apiKeyEnv};
  if(!credentials.apiKey&&!process.env[apiKeyEnv]){io.write('缺少 '+apiKeyEnv+'；输入隐藏密钥仅供本轮使用，不保存值（Esc/EOF 取消）\n');const secret=await io.read(true);if(secret===null||secret==='\x1b')return null;if(!secret)continue;credentials.apiKey=secret;}
  credentials.model=model;stage++;
 }
 return {options,credentials};
}
