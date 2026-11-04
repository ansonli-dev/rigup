import type {SetupOptions} from './types.js';
import {promptChoice} from './prompt.js';
export interface OnboardingIO {write(text:string):void;read(secret?:boolean):Promise<string|null>}
export async function onboard(initial:SetupOptions,io:OnboardingIO,settings:{configure:boolean;knownBackend:boolean;credentials?:{apiKey?:string;model?:string}}):Promise<{options:SetupOptions;credentials:{apiKey?:string;model?:string}}|null>{
 const options=structuredClone(initial);let credentials={...settings.credentials};let stage=!options.agents.length||settings.configure||!settings.knownBackend?0:4;
 const list=async(title:string,choices:string[],defaults:string[]=[])=>{io.write(title+(defaults.length?' [Enter: '+defaults.join(', ')+']':'')+'; b 返回，Esc/EOF 取消\n');return promptChoice(io,choices,false,defaults);};
 while(stage<5){
  if(stage===0){const answer=await list('目标 agents（可多选）',['claude','codex','opencode','omp'],options.agents);if(answer===null)return null;if(answer==='back')return null;if(!Array.isArray(answer)||!answer.length)continue;
   if(JSON.stringify(answer)!==JSON.stringify(options.agents)){delete options.sdd;delete options.model;credentials={};options.tools=options.tools?.map(t=>({...t,agents:t.agents.filter(a=>answer.includes(a))}));options.mcp=options.mcp?.map(m=>({...m,agents:m.agents.filter(a=>answer.includes(a))})).filter(m=>m.agents.length);}
   options.agents=answer as SetupOptions['agents'];stage++;continue;
  }
  if(stage===1){const answer=await list('原生 SDD；缺入口会报告待办，不伪造流程',['superpowers','openspec','spec-kit','none'],[options.sdd??'none']);if(answer===null)return null;if(answer==='back'){stage--;continue;}if(!Array.isArray(answer)||answer.length!==1)continue;if(answer[0]==='none')delete options.sdd;else options.sdd=answer[0] as SetupOptions['sdd'];stage++;continue;}
  if(stage===2){const answer=await list('可选工具；固定版本项目安装包含受保护初始化',['openwiki','codegraph','none'],options.tools?.length?options.tools.map(t=>t.id):['none']);if(answer===null)return null;if(answer==='back'){stage--;continue;}if(!Array.isArray(answer)||answer.includes('none')&&answer.length>1)continue;
   const selected:NonNullable<SetupOptions['tools']>=[];let back=false;
   for(const id of answer.filter(x=>x!=='none')){const old=options.tools?.find(t=>t.id===id);if(old){selected.push(old);continue;}const mode=await list(id+'：作用于当前所选 agents',['pinned-project-install','register-existing-binary'],['pinned-project-install']);if(mode===null)return null;if(mode==='back'){back=true;break;}if(!Array.isArray(mode)||mode.length!==1){back=true;break;}selected.push({id:id as 'openwiki'|'codegraph',install:mode[0]==='pinned-project-install',initialize:mode[0]==='pinned-project-install',agents:[...options.agents]});}
   if(back)continue;options.tools=selected.length?selected:undefined;stage++;continue;
  }
  if(stage===3){if(!options.sdd||settings.knownBackend&&!settings.configure){stage++;continue;}const answer=await list('语义研究后端（与目标 agent 独立）',['native','host'],[options.backend]);if(answer===null)return null;if(answer==='back'){stage--;continue;}if(!Array.isArray(answer)||answer.length!==1)continue;if(options.backend!==answer[0]){delete options.model;credentials={};}options.backend=answer[0] as SetupOptions['backend'];stage++;continue;}
  if(!options.sdd||options.backend!=='native'){stage++;continue;}
  let model=options.model?.model??credentials.model??process.env.ANTHROPIC_MODEL;
  if(!model){io.write('Anthropic model ID（非密钥；b 返回）\n');const value=await io.read();if(value===null||value==='\x1b')return null;if(value==='b'||value==='back'){stage=3;continue;}if(!value.trim())continue;model=value.trim();}
  const apiKeyEnv=options.model?.apiKeyEnv??'ANTHROPIC_API_KEY';options.model={provider:'anthropic',model,apiKeyEnv};
  if(!credentials.apiKey&&!process.env[apiKeyEnv]){io.write('缺少 '+apiKeyEnv+'；输入隐藏密钥仅供本轮使用，不保存值（Esc/EOF 取消）\n');const secret=await io.read(true);if(secret===null||secret==='\x1b')return null;if(!secret)continue;credentials.apiKey=secret;}
  credentials.model=model;stage++;
 }
 return {options,credentials};
}
