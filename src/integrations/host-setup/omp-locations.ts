import {stat} from 'node:fs/promises';
import {join,resolve} from 'node:path';

const profile=(value:string|undefined)=>{
 const name=value?.trim();
 return name&&name!=='default'&&/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)&&!name.endsWith('.')&&!/^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/i.test(name)?name:undefined;
};

export async function ompLocations(home:string,env:NodeJS.ProcessEnv){
 const configDir=env.PI_CONFIG_DIR||'.omp';
 const named=profile(env.OMP_PROFILE??env.PI_PROFILE),legacy=profile(env.PI_PROFILE);
 const base=join(home,configDir,...(named?['profiles',named]:[])),defaultAgent=join(base,'agent');
 const override=env.PI_CODING_AGENT_DIR;
 const agent=(!named&&override&&(!legacy||override!==join(home,configDir,'profiles',legacy,'agent')))?resolve(override):defaultAgent;
 const select=async (value:string|undefined)=>{
  if(!value||agent!==defaultAgent||!['linux','darwin'].includes(process.platform))return base;
  const xdg=join(value,'omp',...(named?['profiles',named]:[]));
  return await stat(xdg).catch(()=>undefined)?xdg:base;
 };
 const [data,state,cache]=await Promise.all([env.XDG_DATA_HOME,env.XDG_STATE_HOME,env.XDG_CACHE_HOME].map(select));
 return {configDir,base,agent,plugins:join(data,'plugins'),state,cache};
}
