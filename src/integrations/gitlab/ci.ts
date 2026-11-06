import {readFile} from 'node:fs/promises';
import {parseDocument,isSeq,stringify} from 'yaml';
import type {PreparedAsset} from '../registry.js';
import {targetPath} from '../../installer/ownership.js';
import {digest} from '../../analyzer/evidence.js';
import type {CommandSpec,SetupOptions} from '../../types.js';
import {quoteShell} from '../../shell-command.js';
export async function prepareGitlab(root:string,selection:NonNullable<SetupOptions['quality']>['gitlab'],commands:CommandSpec[]):Promise<{assets:PreparedAsset[];requirements:{integrationId:string;reason:string}[]}>{
 const assets:PreparedAsset[]=[];const requirements:{integrationId:string;reason:string}[]=[];if(!selection)return {assets,requirements};
 let text='';try{text=await readFile(await targetPath(root,'.gitlab-ci.yml'),'utf8');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 const doc=parseDocument(text);if(doc.errors.length){requirements.push({integrationId:'gitlab',reason:'Existing CI YAML is invalid; preserve it and repair manually'});return {assets,requirements};}
 const existing=doc.toJS();const stages=existing?.stages;
 const regularStage=Array.isArray(stages)?stages.find(value=>typeof value==='string'&&value.trim()&&!['.pre','.post'].includes(value)):undefined;
 const includes=existing?.include;
 const otherIncludes=(Array.isArray(includes)?includes:includes===undefined?[]:[includes]).some(value=>value!=='.rigup/gitlab-ci.yml'&&!(value&&typeof value==='object'&&value.local==='.rigup/gitlab-ci.yml'));
 // GitLab does not run pipelines containing only .pre/.post jobs. A root
 // stages declaration wins over includes; standalone CI has default stages.
 // Preserve .pre with external includes whose stage names are not known here.
 const stage=regularStage??(otherIncludes?'.pre':'test');
 if(stages!==undefined&&!regularStage)requirements.push({integrationId:'gitlab',reason:'Existing CI stages need at least one regular stage; preserve and repair the customer stage selection'});
 const add=(logicalId:string,target:string,content:string,ownership:PreparedAsset['ownership']={kind:'file'})=>assets.push({logicalId,target,content,ownership,source:{kind:'gitlab-template',ref:'1',digest:digest(content)}});
 const jobs:Record<string,unknown>={};
 const checkout='test "$(git rev-parse HEAD)" = "$CI_COMMIT_SHA"';
 const variables={GIT_STRATEGY:'clone',GIT_CHECKOUT:'true'};
 if(commands.length)jobs['rigup:checks']={
  stage,variables,script:[checkout,...commands.map(({cwd,executable,args})=>'(cd '+quoteShell(cwd)+' && '+[executable,...args].map(quoteShell).join(' ')+')')],
  ...(selection.reportPaths?.length?{artifacts:{when:'always',paths:selection.reportPaths,reports:{junit:selection.reportPaths}}}:{}),
  rules:[{if:'$CI_PIPELINE_SOURCE == "merge_request_event" || $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH'}]
 };
 if(selection.openwiki){
  const required=selection.openwiki.envRefs.map(name=>{
   if(!/^[A-Z_][A-Z0-9_]*$/.test(name))throw Error('Invalid GitLab environment reference');
   return 'test -n "$'+'{'+name+':-}" || { printf \'%s\\n\' '+quoteShell('Missing OpenWiki environment reference '+name)+' >&2; exit 3; }';
  });
  jobs['rigup:openwiki']={
   stage,variables,timeout:'5m',script:[checkout,...required,'openwiki --update --mode code --print'],artifacts:{when:'always',paths:['openwiki/']},
   rules:[{if:'$RIGUP_WIKI_GENERATED == "1" || $CI_COMMIT_MESSAGE =~ /\\[rigup-wiki\\]/',when:'never'},{if:'$CI_PIPELINE_SOURCE == "push" && $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH',changes:selection.openwiki.sourcePaths},{when:'never'}]
  };
 }
 if(!Object.keys(jobs).length)return {assets,requirements};
 add('gitlab:jobs','.rigup/gitlab-ci.yml',stringify(jobs));
 const value=doc.get('include',true);const rootMarker='# rigup:ci:start';const indented='  # rigup:ci:start';
 if(text.includes(rootMarker)&&!text.includes(indented)||value===undefined){
  add('gitlab:include','.gitlab-ci.yml',rootMarker+'\ninclude:\n  - local: .rigup/gitlab-ci.yml\n# rigup:ci:end\n',{kind:'block',start:rootMarker,end:'# rigup:ci:end'});
 }else if(isSeq(value)&&!value.flow){
  if(!text.includes(indented)&&(value.toJSON() as unknown[]).some(v=>v==='.rigup/gitlab-ci.yml'||v&&typeof v==='object'&&(v as {local?:string}).local==='.rigup/gitlab-ci.yml'))return {assets,requirements};
  add('gitlab:include','.gitlab-ci.yml',indented+'\n  - local: .rigup/gitlab-ci.yml\n  # rigup:ci:end\n',{kind:'block',start:indented,end:'  # rigup:ci:end',insert:{kind:'yaml-sequence',key:'include'}});
 }else requirements.push({integrationId:'gitlab',reason:'Existing include is not a block sequence; normalize manually without removing existing includes'});
 return {assets,requirements};
}
