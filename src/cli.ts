#!/usr/bin/env node
import {readFile,realpath} from 'node:fs/promises';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {homedir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {onboard} from './onboarding.js';
import {terminalReader,promptChoice} from './prompt.js';
import {loadOptions,validateOptions} from './config.js';
import type {SetupOptions} from './types.js';
import {loadManifest} from './installer/baseline.js';
import {loadPreview} from './installer/preview.js';
import {apply} from './installer/apply.js';
import {doctor} from './installer/doctor.js';
import {sessionHandoffRequired} from './installer/session.js';
import {executeLifecycle,loadContinuation,type LifecycleServices,type LifecycleFlags} from './lifecycle.js';
export interface CliIO {cwd:string;isTTY:boolean;write(text:string):void;writeError?(text:string):void;read?(secret?:boolean):Promise<string|null>;services?:LifecycleServices}
const errorMessage=(error:unknown)=>error instanceof SyntaxError?'input/cache: invalid JSON syntax; inspect the local file without exporting its contents':error instanceof Error?error.message:'operation failed';
const help='rigup init [path] [--agents claude,codex,opencode,omp] [--sdd superpowers|openspec|spec-kit|none] [--tools openwiki,codegraph|none]\nrigup update [path] [--configure] [--dry-run|--review] [--apply previewId] [--request private-path|--response path] [--sessions-ended] [--resume]\nrigup doctor [path] [--run-checks build,lint,test,environment,eval]\nOptions: --backend codex|native|host --profile path --model modelId --api-key-env NAME --json\nAdvanced: --retire logicalId,... --continue runId\n';
async function runCliInternal(argv:string[],io:CliIO):Promise<number>{
 const services:LifecycleServices={...io.services};
 const flags:LifecycleFlags={};const overrides:Partial<SetupOptions>={};const positional:string[]=[];let applyId:string|undefined;
 const boolean=new Set(['--dry-run','--configure','--review','--sessions-ended','--resume']);const valued=new Set(['--agents','--sdd','--tools','--backend','--profile','--response','--request','--apply','--model','--api-key-env','--continue','--retire','--run-checks']);const values:Record<string,string>={};
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
 if(command==='doctor'){try{const runChecks=values['--run-checks']?.split(',');if(runChecks?.some(k=>!['build','lint','test','environment','eval'].includes(k))){io.write('run-checks: existing check kinds required\n');return 2;}const report=await doctor(root,{runChecks:runChecks as import('./types.js').CheckKind[],stateRoot:io.services?.stateRoot,signal:io.services?.signal});io.services?.report?.({phase:'doctor',installStatus:'not-applicable',...report});for(const d of report.diagnostics)io.write(d.category+' '+d.id+': '+d.state+' — '+d.reason+'\n');for(const c of report.checks)io.write('check '+c.name+': '+c.status+' '+(c.startedAt??'')+' '+(c.commit??'')+'\n');return report.exitCode;}catch(e){io.write(errorMessage(e)+'\n');return 1;}}
 if(values['--agents'])overrides.agents=values['--agents'].split(',') as SetupOptions['agents'];
 if(values['--sdd']&&values['--sdd']!=='none')overrides.sdd=values['--sdd'] as SetupOptions['sdd'];
 if(values['--backend'])overrides.backend=values['--backend'] as SetupOptions['backend'];
 if(values['--profile'])overrides.profile=values['--profile'];
 flags.dryRun=!!values['--dry-run'];flags.yes=!io.isTTY&&!values['--dry-run']&&!values['--review'];flags.review=!!values['--review'];flags.response=values['--response'];flags.request=values['--request'];flags.configure=!!values['--configure'];if(flags.request){const privateRoot=resolve(io.services?.cacheRoot??join(homedir(),'.cache','rigup'),'host');const rel=relative(privateRoot,resolve(flags.request));if(!isAbsolute(flags.request)||!rel||rel.startsWith('..')||isAbsolute(rel)){io.write('request: use an absolute file path inside '+privateRoot+'\n');return 2;}}if(flags.request&&flags.response){io.write('request/response: choose one\n');return 2;}flags.sessionsEnded=!!values['--sessions-ended'];flags.resume=!!values['--resume'];flags.retireIds=values['--retire']?.split(',');flags.runChecks=values['--run-checks']?.split(',') as import('./types.js').CheckKind[];if(flags.runChecks?.some(k=>!['build','lint','test','environment','eval'].includes(k))){io.write('run-checks: existing kinds required\n');return 2;}applyId=values['--apply'];
 if([flags.dryRun,flags.yes,flags.review].filter(Boolean).length>1){io.write('execution mode: choose one\n');return 2;}
 if(applyId){
  if(await sessionHandoffRequired(root,flags.sessionsEnded)){io.write('End affected sessions and use --sessions-ended from an independent terminal\n');return 3;}
  try{const cacheRoot=join(io.services?.cacheRoot??join(homedir(),'.cache','rigup'),'previews');const prepared=await loadPreview(applyId,cacheRoot);if(prepared.plan.root!==root)throw new Error('preview project root differs from requested path');if(flags.runChecks&&JSON.stringify([...flags.runChecks].sort())!==JSON.stringify([...(prepared.plan.runChecks??[])].sort()))throw new Error('apply checks differ from approved preview; prepare a new preview with --run-checks');const report=await apply(applyId,{cacheRoot,stateRoot:io.services?.stateRoot,recover:flags.resume,signal:io.services?.signal,runChecks:io.services?.runChecks});io.services?.report?.({phase:'apply',installStatus:report.status,...report});io.write('Install '+report.status+'\n');return report.exitCode;}catch(e){io.write(errorMessage(e)+'\n');return 1;}
 }
 let options:SetupOptions;
 try {
  let hasProjectConfig=true;try{await readFile(join(root,'.rigup/config.yaml'));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')hasProjectConfig=false;else throw e;}
  options=await loadOptions(root,!hasProjectConfig&&manifest?{...(manifest.options??{agents:[]}),...overrides}:overrides);
  if(values['--tools']){const ids=values['--tools'].split(',');if(ids.includes('none')&&ids.length!==1)throw Error('tools: none cannot be combined with a tool');if(ids[0]==='none')delete options.tools;else options.tools=[...new Set(ids)].map(id=>({id:id as 'openwiki'|'codegraph',install:true,initialize:id==='codegraph',agents:[...options.agents]}));}
  if(values['--continue']){if(Object.keys(overrides).length||['--tools','--model','--api-key-env','--review','--dry-run','--configure','--retire','--run-checks'].some(k=>values[k]))throw new Error('continuation cannot change explicit selections or execution mode');const continuation=await loadContinuation(root,values['--continue'],io.services);options=continuation.options;Object.assign(flags,{...continuation.flags,response:flags.response,sessionsEnded:flags.sessionsEnded,resume:flags.resume});}
  if(values['--model']||values['--api-key-env']){if(values['--backend']==='codex')throw Error('model/API-key flags select the Anthropic native backend; Codex model overrides are not supported');if(!values['--backend'])options.backend='native';const model=values['--model']??options.model?.model??process.env.ANTHROPIC_MODEL;if(!model)throw new Error('model.model: required when changing the API-key reference');options.model={provider:'anthropic',model,apiKeyEnv:values['--api-key-env']??options.model?.apiKeyEnv??'ANTHROPIC_API_KEY'};}
  if(values['--sdd']==='none')delete options.sdd;
  if((flags.request||flags.response)&&options.backend!=='host')throw new Error('request/response: select the host backend');
  if(!values['--review']&&!values['--dry-run']&&options.executionPolicy?.mode==='review'){flags.review=true;flags.yes=false;}
  validateOptions(options as unknown as Record<string,unknown>);
  if(io.isTTY&&io.read&&!values['--continue']){const setup=await onboard(options,{write:io.write,read:io.read},{configure:!!flags.configure,knownBackend:hasProjectConfig||!!overrides.backend||!!options.profile,credentials:services.credentials});if(!setup)return 130;options=setup.options;services.credentials=setup.credentials;}
  while(!flags.dryRun&&!flags.yes&&!flags.review&&io.isTTY&&io.read){
   io.write('本轮范围：agents='+options.agents.join(',')+'; SDD='+(options.sdd??'none')+'; tools='+(options.tools??[]).map(t=>t.id+(t.install?':pinned install':':registration')).join(',')+'; backend='+options.backend+'; 研究上限 '+(options.researchBudget?.maxCalls??60)+' requests / '+(options.researchBudget?.maxTokens??100000)+' tokens。仅预览内受保护写入；b 返回修改。\n');
   const mode=await promptChoice({write:io.write,read:io.read},['continuous','review','dry-run'],false,[options.executionPolicy?.mode??'continuous']);if(mode===null)return 130;
   if(mode==='back'){const setup=await onboard(options,{write:io.write,read:io.read},{configure:true,knownBackend:true,credentials:services.credentials});if(!setup)return 130;options=setup.options;services.credentials=setup.credentials;continue;}
   if(!Array.isArray(mode)||mode.length!==1)return 2;flags.yes=mode[0]==='continuous';flags.review=mode[0]==='review';flags.dryRun=mode[0]==='dry-run';
  }
  if(flags.configure)options.executionPolicy={mode:flags.review?'review':'continuous'};
  validateOptions(options as unknown as Record<string,unknown>);
 }catch(e){io.write(errorMessage(e)+'\n');return 2;}
 try{return await executeLifecycle(root,options,flags,io.write,{...services,isTTY:io.isTTY});}catch(e){io.write(errorMessage(e)+'\n');return io.services?.signal?.aborted?130:1;}
}
export async function runCli(argv:string[],io:CliIO):Promise<number>{
 if(!argv.includes('--json'))return runCliInternal(argv,io);
 let actual:Record<string,unknown>={};let last='';const report=(value:Record<string,unknown>)=>{actual=value;io.services?.report?.(value);};
 const code=await runCliInternal(argv.filter(a=>a!=='--json'),{...io,isTTY:false,read:undefined,write:text=>{last=text;io.writeError?.(text);},services:{...io.services,report}});
 const result={phase:actual.phase??'preflight',installStatus:actual.installStatus??(code===0?'complete':code===3?'pending':'failed'),checks:[],pending:[],conflicts:[],requiredInput:[],nextCommand:null,...actual,exitCode:code,...((code===1||code===2)?{error:last.trim()}:{} )};io.write(JSON.stringify(result)+'\n');return code;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(await realpath(resolve(process.argv[1]))).href){
 const controller=new AbortController();process.once('SIGINT',()=>controller.abort());
 process.exitCode=await runCli(process.argv.slice(2),{cwd:process.cwd(),isTTY:!!process.stdin.isTTY,write:text=>process.stdout.write(text),writeError:text=>process.stderr.write(text),read:terminalReader(process.stdin),services:{signal:controller.signal}});
}
