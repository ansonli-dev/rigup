import type {CommandSpec} from '../types.js';

export interface SpecializedCheck {
 command:CommandSpec;
 source:string;
 tools?:('yarn'|'pm2'|'playwright')[];
 postgres?:{config:string;migration?:'migration:up:tests';guard?:string;runInBand?:true};
}

export const {checkPrerequisites,hasTestDatabaseGuard,jestSetupPath}=await import(new URL('../integrations/tools/project-check.mjs',import.meta.url).href) as {
 checkPrerequisites(script:string,manifest:unknown,cwd:string):Pick<SpecializedCheck,'tools'|'postgres'>;
 hasTestDatabaseGuard(source:string):boolean;
 jestSetupPath(config:string,setup:unknown):string|undefined;
};

export function linkDatabaseGuards(checks:SpecializedCheck[],jestSetups:Map<string,string>,testGuards:Set<string>):SpecializedCheck[] {
 for(const check of checks){
  if(!check.postgres)continue;
  const guard=jestSetups.get(check.postgres.config);
  if(guard&&testGuards.has(guard)){
   check.postgres.guard=guard;
   if(check.postgres.runInBand)check.command.args.push('--','--runInBand');
  }else check.postgres={config:check.postgres.config};
 }
 return checks.filter(check=>check.command.args[1]!=='test'||check.postgres||check.tools?.length);
}
