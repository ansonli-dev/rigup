import {isAbsolute} from 'node:path';
import type {ProjectProfile} from '../../analyzer/repository.js';
import {resolveSkillSource} from '../sdd/binding.js';
import {superpowersReadiness} from './manual.js';
import {withinPath} from './host-files.js';
import type {SetupHost} from './runtime.js';

export function bindingFrom(profile:ProjectProfile,host:SetupHost,path:string,packageName:string){
 const ready=superpowersReadiness(profile,host);
 if(ready.status!=='ready')return false;
 try{
  return [...ready.binding.prepare,...ready.binding.deliver].every(name=>{
   const source=resolveSkillSource(name,profile.skillSources?.[host]??[]);
   return source.origin==='plugin'&&source.packageName===packageName&&isAbsolute(source.identity)&&withinPath(path,source.identity);
  });
 }catch{return false;}
}
