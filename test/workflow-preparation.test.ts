import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {openspecFixturePath,project} from './helpers.js';
import {inspectPreparedArtifacts,prepareFeedbackProbe} from './live-workflow-prepare-support.js';
import {createWorkflowFixture} from './workflow-fixture-support.js';

for(const defect of ['native-incomplete','other-change-link','stale-design','missing-verification','superseded-history','stale-after-history','historical-preservation','scenario-titles','spaces-only','none'] as const)test('prepared artifact oracle checks coordinated native requirements and evidence: '+defect,()=>project(async root=>{
 const base='openspec/changes/greeting',skillRoot='.agents/skills';
 const blank=defect==='scenario-titles'?'empty, spaces-only and tab/newline inputs':defect==='spaces-only'?'empty and spaces-only inputs':'empty and whitespace-only inputs';
 const body='REQ-BLANK: Reject '+blank+' with TypeError.\nREQ-PRESERVE: Preserve " Ada Lovelace " as "Hello, Ada Lovelace" and keep internal spaces.\nVerification: npm test at repository root.\n';
 const paths=['proposal.md','design.md','tasks.md','specs/greeting/spec.md','specs/preservation/spec.md'];
 for(const path of paths){await mkdir(dirname(join(root,base,path)),{recursive:true});await writeFile(join(root,base,path),body);}
 const context=skillRoot+'/'+(defect==='scenario-titles'?'change-prepare':'change-deliver')+'/references/project.md';
 for(const path of [skillRoot+'/openspec-apply-change/SKILL.md',skillRoot+'/change-deliver/SKILL.md',context,'CONTRIBUTING.md']){await mkdir(dirname(join(root,path)),{recursive:true});await writeFile(join(root,path),'Fixture guidance\n');}
 const goal=body+paths.map(path=>`[${path}](${path})`).join('\n')+'\n[native](../../../.agents/skills/openspec-apply-change/SKILL.md)\n[delivery](../../../.agents/skills/change-deliver/SKILL.md)\n[context](../../../'+context+')\n[guidance](../../../CONTRIBUTING.md)\n';
 await writeFile(join(root,base,'GOAL.md'),defect==='other-change-link'?goal.replace('(design.md)','(../other/design.md)'):goal);
 if(defect==='other-change-link'){await mkdir(join(root,'openspec/changes/other'));await writeFile(join(root,'openspec/changes/other/design.md'),body);}
 if(defect==='stale-design')await writeFile(join(root,base,'design.md'),body.replaceAll('TypeError','RangeError'));
 if(defect==='superseded-history'||defect==='stale-after-history'){
  const history='\n## Superseded draft history\nThe old RangeError requirement is obsolete; the developer replaced it with TypeError.\n';
  await writeFile(join(root,base,'design.md'),body+history+(defect==='stale-after-history'?'\n## Current implementation decision\nREQ-BLANK: Empty and whitespace-only names must throw RangeError.\n':''));
 }
 if(defect==='missing-verification')await writeFile(join(root,base,'tasks.md'),body.replace('npm test at repository root','unspecified'));
 if(defect==='historical-preservation')await writeFile(join(root,base,'design.md'),body.replace(/REQ-PRESERVE:.*\n/,'')+'\n## Superseded draft history\n'+body.match(/REQ-PRESERVE:.*\n/)![0]);
 const nativeState={status:{changeName:'greeting',isPlanningComplete:defect!=='native-incomplete',artifacts:paths.map(path=>({id:path,status:'done'}))},apply:{changeName:'greeting',state:'ready',missingPrerequisites:defect==='native-incomplete'?['design']:[],contextFiles:{proposal:[join(root,base,'proposal.md')],design:[join(root,base,'design.md')],tasks:[join(root,base,'tasks.md')],specs:[join(root,base,'specs/greeting/spec.md'),join(root,base,'specs/preservation/spec.md')]}}};
 assert.equal((await inspectPreparedArtifacts(root,nativeState,'TypeError',skillRoot)).passed,['none','superseded-history','scenario-titles'].includes(defect));
}));

// Scripted unit driver tests the harness state machine only; it is never native-host acceptance.
for(const defect of ['unknown-usage','partial-usage','over-budget','configuration-edit','outside-directory','invented-approval','stale-feedback','ready-edit','failed-artifact-read','numbered-read-output','none'] as const)test('preparation phase accounting and actual-prompt approval stop safely: '+defect,async()=>{
 const fixture=await createWorkflowFixture();
 try{
  const {root,control}=fixture,base='openspec/changes/greeting',skillRoot='.agents/skills',paths=['proposal.md','design.md','tasks.md','specs/greeting/spec.md','specs/preservation/spec.md'];
  const env={...process.env,PATH:await openspecFixturePath(root,control),HOME:join(control,'home')};
  for(const name of ['openspec-propose','openspec-apply-change','openspec-archive-change']){await mkdir(join(root,skillRoot,name),{recursive:true});await writeFile(join(root,skillRoot,name,'SKILL.md'),'---\nname: '+name+'\ndescription: Unit native entry\n---\n');}
  const state={status:{changeName:'greeting',isPlanningComplete:true,artifacts:paths.map(id=>({id,status:'done'}))},apply:{changeName:'greeting',state:'ready',tasks:[],contextFiles:{proposal:[join(root,base,paths[0])],design:[join(root,base,paths[1])],tasks:[join(root,base,paths[2])],specs:paths.slice(3).map(path=>join(root,base,path))}}};
  const native=async(args:string[])=>({stdout:JSON.stringify(args[0]==='status'?state.status:state.apply)}),calls:{prompt:string;stem:string}[]=[];
  const result=await prepareFeedbackProbe({host:'codex',fixture,env,native,runTurn:async(prompt,budget,stem)=>{
   calls.push({prompt,stem});const phase=stem.slice('prepare-'.length),preparing=phase==='prepare'||phase==='feedback';
   if(preparing){
    const kind=phase==='feedback'&&defect!=='stale-feedback'?'TypeError':'RangeError';
    const body='REQ-BLANK: Reject empty and whitespace-only inputs with '+kind+'.\nREQ-PRESERVE: Preserve " Ada Lovelace " as "Hello, Ada Lovelace" and keep internal spaces.\nVerification: npm test at repository root.\n';
    for(const path of paths){await mkdir(dirname(join(root,base,path)),{recursive:true});await writeFile(join(root,base,path),body);}
    await writeFile(join(root,base,'GOAL.md'),body+'Implementation approval: pending.\n'+paths.map(path=>`[${path}](${path})`).join('\n')+'\n[native](../../../.agents/skills/openspec-apply-change/SKILL.md)\n[delivery](../../../.agents/skills/change-deliver/SKILL.md)\n[context](../../../.agents/skills/change-deliver/references/project.md)\n[guidance](../../../CONTRIBUTING.md)\n');
   }
   if(defect==='configuration-edit')await writeFile(join(root,'package.json'),'{}\n');
   if(defect==='outside-directory')await mkdir(join(root,'unapproved-directory'),{recursive:true});
   if(defect==='invented-approval')await writeFile(join(root,base,'approval.md'),'Approved by a fabricated developer\n');
   if(defect==='ready-edit'&&phase==='ready-unapproved')await writeFile(join(root,base,'tasks.md'),'Changed by read-only readiness\n');
   const skill=preparing?'change-prepare':'change-ready';
   const readPaths=[skillRoot+'/'+skill+'/SKILL.md',skillRoot+'/'+skill+'/references/project.md',skillRoot+'/change-prepare/references/GOAL.md',...paths.map(path=>base+'/'+path),base+'/GOAL.md'];
   let payload=(await Promise.all(readPaths.map(path=>readFile(join(root,path),'utf8')))).join('\n')+'\n'+JSON.stringify(state.status)+'\n'+JSON.stringify(state.apply);
   if(defect==='numbered-read-output')payload=payload.split('\n').map((line,index)=>(index+1)+': '+line).join('\n');
   const answer=phase==='ready-unapproved'?'Blocked: implementation approval is missing. Obtain developer approval and rerun readiness.':phase==='ready-approved'?'Ready for implementation\n/goal Implement the reviewed change in "openspec/changes/greeting/GOAL.md" and verify every completion criterion in that file.':'Prepared; implementation approval remains pending.';
   const command='cat artifacts; openspec status --change greeting --json; openspec instructions apply --change greeting --json';
   const tools:any[]=defect==='failed-artifact-read'?[{type:'command_execution',command,aggregated_output:(await Promise.all(readPaths.slice(0,2).map(path=>readFile(join(root,path),'utf8')))).join('\n')+'\n'+JSON.stringify(state.status)+'\n'+JSON.stringify(state.apply),exit_code:0},{tool:'shell',state:{status:'completed',input:{command},output:payload,metadata:{exit:17}}}]:[{type:'command_execution',command,aggregated_output:payload,exit_code:0}];
   const usageComplete=defect!=='unknown-usage'&&defect!=='partial-usage',observedUsage=defect==='unknown-usage'?{input:0,output:0,total:0}:{input:5,output:3,total:defect==='over-budget'?budget.maxObservedTokens+1:8};
   return {command:{unitDriver:true},transport:{code:0,timedOut:false},privateEvidence:'unit-driver',observation:{answer,tools,usageComplete,observedUsage,usage:usageComplete?observedUsage:undefined}};
  }});
  const valid=defect==='none'||defect==='numbered-read-output',expected=valid?4:defect==='stale-feedback'?3:defect==='ready-edit'?2:1;
  assert.equal(calls.length,expected);assert.equal(result.phases.length,expected);assert.equal(result.status,valid?'passed':'failed',result.reason);
  assert.ok(calls.slice(0,3).every(call=>!call.prompt.includes('As developer, I approve')),'the first preparation cannot pre-populate approval');
  assert.equal(result.cumulative.total,defect==='unknown-usage'?0:defect==='over-budget'?600001:8*expected);
  assert.equal(result.cumulative.usageComplete,defect!=='unknown-usage'&&defect!=='partial-usage','known subtotals must not present unknown usage as zero');
  for(const phase of result.phases){assert.deepEqual(JSON.parse(await readFile(join(control,'prepare-'+phase.id+'.result.json'),'utf8')),phase);assert.ok(phase.budget.maxWallMs>0);assert.ok(phase.after,'retain actual post-attempt bytes even after unknown or excessive usage');}
  if(valid){
   assert.match(calls[3].prompt,/As developer, I approve the current greeting scope/);assert.match(calls[3].prompt,/GOAL SHA256 [a-f0-9]{64}/);
   assert.equal(result.phases[0].artifacts.documents[base+'/design.md'].includes('RangeError'),true);
   assert.equal(result.phases[2].artifacts.documents[base+'/design.md'].includes('TypeError'),true);
   assert.deepEqual(result.phases[1].before,result.phases[1].after);assert.deepEqual(result.phases[3].before,result.phases[3].after);
  }
 }finally{await fixture.close();}
});
