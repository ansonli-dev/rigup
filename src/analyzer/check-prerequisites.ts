import {posix} from 'node:path';
import type {CommandSpec} from '../types.js';

export interface SpecializedCheck {
 command:CommandSpec;
 source:string;
 tools?:('yarn'|'pm2'|'playwright')[];
 postgres?:{config:string;migration?:'migration:up:tests';guard?:string;runInBand?:true};
}

export function checkPrerequisites(script:string,manifest:{scripts?:Record<string,unknown>;dependencies?:Record<string,unknown>;devDependencies?:Record<string,unknown>},cwd:string):Pick<SpecializedCheck,'tools'|'postgres'> {
 const tools:NonNullable<SpecializedCheck['tools']>=[];
 if(/(?:^|[;&|]\s*|pm2\s+start\s+["'])\s*yarn(?:\s|$)/.test(script))tools.push('yarn');
 if(/(?:^|[;&|]\s*)\s*pm2\s+start(?:\s|$)/.test(script))tools.push('pm2');
 if(/(?:^|[;&|]\s*|yarn\s+)\s*playwright\s+test(?:\s|$)/.test(script))tools.push('playwright');
 const singleJest=/^[ \t]*jest[ \t]+[\w./= \t-]+$/.test(script);
 const config=singleJest?/[ \t]--config(?:=|[ \t]+)([\w./-]+\.json)(?=[ \t]|$)/.exec(script)?.[1]:undefined;
 const postgres=config&&!config.startsWith('/')&&!config.split('/').includes('..')&&['pg','postgres','slonik','nestjs-slonik'].some(name=>Object.hasOwn(manifest.dependencies??{},name)||Object.hasOwn(manifest.devDependencies??{},name))
  ?{config:posix.join(cwd,config),
    ...(/^NODE_ENV=test\s+/.test(String(manifest.scripts?.['migration:up:tests']??''))?{migration:'migration:up:tests' as const}:{}),
    ...(!/\s(?:-i|--runInBand|-w|--maxWorkers)(?=\s|=|$)/.test(script)?{runInBand:true as const}:{})}:undefined;
 return {...(tools.length?{tools}:{}),...(postgres?{postgres}:{})};
}

export function hasTestDatabaseGuard(source:string):boolean {
 const withoutBlockComments=source.replace(/\/\*[\s\S]*?\*\//g,'');
 return /^\s*if\s*\(\s*!\s*(?:databaseConfig\.)?database\.includes\(\s*(['"])test\1\s*\)\s*\)\s*\{?\s*throw\b/m.test(withoutBlockComments);
}

export function linkDatabaseGuards(checks:SpecializedCheck[],jestSetups:Map<string,string>,testGuards:Set<string>):SpecializedCheck[] {
 for(const check of checks){
  if(!check.postgres)continue;
  const guard=jestSetups.get(check.postgres.config);
  if(guard&&testGuards.has(guard)){
   check.postgres.guard=guard;
   if(check.postgres.runInBand)check.command.args.push('--','--runInBand');
  }else delete check.postgres;
 }
 return checks.filter(check=>check.command.args[1]!=='test'||check.postgres);
}
