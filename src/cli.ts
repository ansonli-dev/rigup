#!/usr/bin/env node
import {readFile,realpath} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {homedir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {terminalReader,promptChoice} from './prompt.js';
import {loadOptions,validateOptions} from './config.js';
import type {SetupOptions} from './types.js';
import {loadManifest} from './installer/baseline.js';
import {apply} from './installer/apply.js';
import {executeLifecycle,loadContinuation,type LifecycleServices,type LifecycleFlags} from './lifecycle.js';
export interface CliIO {cwd:string;isTTY:boolean;write(text:string):void;read?(secret?:boolean):Promise<string|null>;services?:LifecycleServices}
const help='rigup init [path] [--agents claude,codex,opencode,omp] [--sdd superpowers|openspec|spec-kit|none]\nrigup update [path] [--dry-run|--yes|--review] [--apply previewId] [--response path] [--sessions-ended] [--resume]\nrigup doctor [path]\nOptions: --backend native|host --profile path --model modelId --api-key-env NAME\n';
export async function runCli(argv:string[],io:CliIO):Promise<number>{
 const flags:LifecycleFlags={};const overrides:Partial<SetupOptions>={};const positional:string[]=[];let applyId:string|undefined;
 const boolean=new Set(['--dry-run','--yes','--review','--sessions-ended','--resume']);const valued=new Set(['--agents','--sdd','--backend','--profile','--response','--apply','--model','--api-key-env','--continue','--retire']);const values:Record<string,string>={};
 for(let i=0;i<argv.length;i++){
  const arg=argv[i];if(boolean.has(arg)){values[arg]='true';continue;}if(valued.has(arg)){if(!argv[i+1]||argv[i+1].startsWith('--')){io.write(arg+': value required\n');return 2;}values[arg]=argv[++i];continue;}
  if(arg==='--help'){io.write(help);return 0;}if(arg==='--version'){io.write('0.1.0\n');return 0;}if(arg.startsWith('-')){io.write('Unknown option\n');return 2;}positional.push(arg);
 }
 if(positional.length>2||positional[0]&&!['init','update','doctor'].includes(positional[0])){io.write(help);return 2;}
 if(!positional.length&&!io.isTTY){io.write(help+'Choose a lifecycle command\n');return 2;}
 let root:string;try{root=await realpath(resolve(io.cwd,positional[1]??'.'));}catch{io.write('path: existing directory required\n');return 2;}
 let manifest:Awaited<ReturnType<typeof loadManifest>>;
 try{manifest=await loadManifest(root);}catch{io.write('manifest: damaged metadata; diagnose before setup\n');return 1;}
 let command=positional[0];
 if(!command){io.write(manifest?'1. update\n2. doctor\n3. exit\n':'1. init\n2. doctor\n3. exit\n');const a=await io.read?.();if(a==null||a==='3')return 130;if(!['1','2'].includes(a))return 2;command=a==='2'?'doctor':manifest?'update':'init';}
 if(command==='init'&&manifest)command='update';
 io.write(command+': '+root+'\n');
 if(command==='doctor'){io.write('doctor: inspection adapter pending implementation\n');return 1;}
 if(values['--agents'])overrides.agents=values['--agents'].split(',') as SetupOptions['agents'];
 if(values['--sdd']&&values['--sdd']!=='none')overrides.sdd=values['--sdd'] as SetupOptions['sdd'];
 if(values['--backend'])overrides.backend=values['--backend'] as SetupOptions['backend'];
 if(values['--profile'])overrides.profile=values['--profile'];
 if(values['--model'])overrides.model={provider:'anthropic',model:values['--model'],apiKeyEnv:values['--api-key-env']??'ANTHROPIC_API_KEY'};
 flags.dryRun=!!values['--dry-run'];flags.yes=!!values['--yes'];flags.review=!!values['--review'];flags.response=values['--response'];flags.sessionsEnded=!!values['--sessions-ended'];flags.resume=!!values['--resume'];flags.retireIds=values['--retire']?.split(',');applyId=values['--apply'];
 if([flags.dryRun,flags.yes,flags.review].filter(Boolean).length>1){io.write('execution mode: choose one\n');return 2;}
 if(applyId){
  if((process.env.CODEX_THREAD_ID||process.env.CLAUDECODE||process.env.OPENCODE)&&!flags.sessionsEnded){io.write('End affected sessions and use --sessions-ended from an independent terminal\n');return 3;}
  try{const report=await apply(applyId,{cacheRoot:join(io.services?.cacheRoot??join(homedir(),'.cache','rigup'),'previews'),stateRoot:io.services?.stateRoot,recover:flags.resume,signal:io.services?.signal,runChecks:io.services?.runChecks});io.write('Install '+report.status+'\n');return report.exitCode;}catch(e){io.write((e as Error).message+'\n');return 1;}
 }
 let options:SetupOptions;
 try {
  let hasProjectConfig=true;try{await readFile(join(root,'.rigup/config.yaml'));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')hasProjectConfig=false;else throw e;}
  options=await loadOptions(root,!hasProjectConfig&&manifest?.options?{...manifest.options,...overrides}:overrides);
  if(values['--continue']){if(Object.keys(overrides).length)throw new Error('continuation cannot change explicit selections');const continuation=await loadContinuation(root,values['--continue'],io.services);options=continuation.options;Object.assign(flags,{...continuation.flags,response:flags.response,sessionsEnded:flags.sessionsEnded,resume:flags.resume});}
  if(values['--sdd']==='none')delete options.sdd;
  validateOptions(options as unknown as Record<string,unknown>);
  if(!options.agents.length&&io.isTTY&&io.read){const chosen=await promptChoice({write:io.write,read:io.read},['claude','codex','opencode','omp']);if(chosen===null)return 130;options.agents=chosen as SetupOptions['agents'];const sdd=await promptChoice({write:io.write,read:io.read},['superpowers','openspec','spec-kit','none']);if(sdd===null)return 130;if(Array.isArray(sdd)&&sdd.length===1&&sdd[0]!=='none')options.sdd=sdd[0] as SetupOptions['sdd'];}
  if(!flags.dryRun&&!flags.yes&&!flags.review&&io.isTTY&&io.read){const mode=await promptChoice({write:io.write,read:io.read},['continuous','review','dry-run']);if(mode===null)return 130;if(!Array.isArray(mode)||mode.length!==1)return 2;flags.yes=mode[0]==='continuous';flags.review=mode[0]==='review';flags.dryRun=mode[0]==='dry-run';}
 }catch(e){io.write((e as Error).message+'\n');return 2;}
 try{return await executeLifecycle(root,options,flags,io.write,io.services);}catch(e){io.write((e as Error).message+'\n');return io.services?.signal?.aborted?130:1;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const controller=new AbortController();process.once('SIGINT',()=>controller.abort());
 process.exitCode=await runCli(process.argv.slice(2),{cwd:process.cwd(),isTTY:!!process.stdin.isTTY,write:text=>process.stdout.write(text),read:terminalReader(process.stdin),services:{signal:controller.signal}});
}
