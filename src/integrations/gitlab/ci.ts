import {readFile} from 'node:fs/promises';
import {parseDocument,isSeq,stringify} from 'yaml';
import type {PreparedAsset} from '../registry.js';
import {targetPath} from '../../installer/ownership.js';
import {digest} from '../../analyzer/evidence.js';
export async function prepareGitlab(root:string,selection:NonNullable<import('../../types.js').SetupOptions['quality']>['gitlab']):Promise<{assets:PreparedAsset[];requirements:{integrationId:string;reason:string}[]}>{
 const assets:PreparedAsset[]=[];const requirements:{integrationId:string;reason:string}[]=[];if(!selection)return {assets,requirements};
 const add=(logicalId:string,target:string,content:string,ownership:PreparedAsset['ownership']={kind:'file'})=>assets.push({logicalId,target,content,ownership,source:{kind:'gitlab-template',ref:'1',digest:digest(content)}});
 const jobs:Record<string,unknown>={};
 if(selection.checks.length)jobs['rigup:checks']={stage:'.pre',script:['node .rigup/scripts/check-snapshot.mjs ci .rigup/checks.json'],artifacts:{when:'always',paths:['rigup-reports/'],...(selection.reportPaths?.length?{reports:{junit:selection.reportPaths.map(p=>'rigup-reports/**/'+p)}}:{})},rules:[{if:'$CI_PIPELINE_SOURCE == "merge_request_event" || $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH'}]};
 if(selection.openwiki){
  jobs['rigup:openwiki']={stage:'.pre',script:['node .rigup/scripts/openwiki-ci-update.mjs .rigup/openwiki-ci.json'],artifacts:{when:'always',paths:['openwiki/','rigup-reports/openwiki.json']},rules:[{if:'$RIGUP_WIKI_GENERATED == "1" || $CI_COMMIT_MESSAGE =~ /\\[rigup-wiki\\]/',when:'never'},{if:'$CI_PIPELINE_SOURCE == "push" && $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH',changes:selection.openwiki.sourcePaths},{when:'never'}]};
  add('gitlab:openwiki-config','.rigup/openwiki-ci.json',JSON.stringify({envRefs:selection.openwiki.envRefs,command:{executable:'.rigup/tools/openwiki/node_modules/.bin/openwiki',args:['--update','--mode','code','--print'],cwd:'.',envRefs:selection.openwiki.envRefs},packageJson:'.rigup/tools/openwiki/node_modules/openwiki/package.json',version:'0.7.3'},null,2)+'\n');
  add('gitlab:openwiki-script','.rigup/scripts/openwiki-ci-update.mjs',await readFile(new URL('../../../templates/scripts/openwiki-ci-update.mjs',import.meta.url),'utf8'));
 }
 add('gitlab:jobs','.rigup/gitlab-ci.yml',stringify(jobs));
 let text='';try{text=await readFile(await targetPath(root,'.gitlab-ci.yml'),'utf8');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 const doc=parseDocument(text);if(doc.errors.length){requirements.push({integrationId:'gitlab',reason:'Existing CI YAML is invalid; preserve it and repair manually'});return {assets,requirements};}
 const value=doc.get('include',true);const rootMarker='# rigup:ci:start';const indented='  # rigup:ci:start';
 if(text.includes(rootMarker)&&!text.includes(indented)||value===undefined){
  add('gitlab:include','.gitlab-ci.yml',rootMarker+'\ninclude:\n  - local: .rigup/gitlab-ci.yml\n# rigup:ci:end\n',{kind:'block',start:rootMarker,end:'# rigup:ci:end'});
 }else if(isSeq(value)&&!value.flow){
  if(!text.includes(indented)&&(value.toJSON() as unknown[]).some(v=>v==='.rigup/gitlab-ci.yml'||v&&typeof v==='object'&&(v as {local?:string}).local==='.rigup/gitlab-ci.yml'))return {assets,requirements};
  add('gitlab:include','.gitlab-ci.yml',indented+'\n  - local: .rigup/gitlab-ci.yml\n  # rigup:ci:end\n',{kind:'block',start:indented,end:'  # rigup:ci:end',insert:{kind:'yaml-sequence',key:'include'}});
 }else requirements.push({integrationId:'gitlab',reason:'Existing include is not a block sequence; normalize manually without removing existing includes'});
 return {assets,requirements};
}
