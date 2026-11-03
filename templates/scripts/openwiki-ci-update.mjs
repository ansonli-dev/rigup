import {spawn} from 'node:child_process';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
export async function runOpenWikiCI(config,{env=process.env,root=process.cwd()}={}){
 const startedAt=new Date().toISOString();const evidence={startedAt,commit:env.CI_COMMIT_SHA??'unknown',environment:{node:process.version,platform:process.platform}};
 if(env.RIGUP_WIKI_GENERATED==='1'||/\[rigup-wiki\]/i.test(env.CI_COMMIT_MESSAGE??'')||env.CI_PIPELINE_SOURCE!=='push'||env.CI_COMMIT_BRANCH!==env.CI_DEFAULT_BRANCH)return {...evidence,status:'skipped',exitCode:0,reason:'Not an eligible source push; generated updates cannot self-trigger'};
 const missing=(config.envRefs??[]).filter(key=>!env[key]);if(missing.length)return {...evidence,status:'pending',exitCode:3,reason:'Missing environment references: '+missing.join(', ')};
 let pkg;try{pkg=JSON.parse(await readFile(resolve(root,config.packageJson),'utf8'));}catch{return {...evidence,status:'pending',exitCode:3,reason:'Provision pinned OpenWiki in CI before this update job; no hidden installation or initialization'};}
 if(pkg.name!=='openwiki'||pkg.version!==config.version)return {...evidence,status:'pending',exitCode:3,reason:'OpenWiki version mismatch'};
 const result=await new Promise(done=>{const child=spawn(resolve(root,config.command.executable),config.command.args,{cwd:root,env,shell:false,stdio:'ignore'});const timeout=setTimeout(()=>{child.kill('SIGKILL');},300000);child.once('error',()=>{clearTimeout(timeout);done(1)});child.once('exit',code=>{clearTimeout(timeout);done(code??1)});});
 return {...evidence,finishedAt:new Date().toISOString(),status:result===0?'passed':'failed',exitCode:result};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){try{const config=JSON.parse(await readFile(process.argv[2],'utf8'));const report=await runOpenWikiCI(config);await mkdir('rigup-reports',{recursive:true});await writeFile(join('rigup-reports','openwiki.json'),JSON.stringify(report,null,2)+'\n');process.stdout.write(JSON.stringify(report)+'\n');process.exitCode=report.exitCode;}catch{process.stderr.write('OpenWiki CI update failed; inspect provisioning and declared environment references\n');process.exitCode=1;}}
