import {diagnosticTarget,type Diagnostic} from '../installer/doctor.js';
import type {InstallReport} from '../installer/apply.js';
import {t,translate,type MessageKey} from './index.js';
import {reasonDetail,renderReason} from './reasons.js';

const labels:ReadonlyMap<string,MessageKey>=new Map([
 ['manifest','doctor.label.manifest'],
 ['installation','doctor.label.installation'],
 ['project-rules','doctor.label.project-rules'],
 ['selection','doctor.label.selection'],
 ['rigup:research-launcher','doctor.label.rigup:research-launcher'],
 ['rigup:tool-launcher','doctor.label.rigup:tool-launcher'],
 ['rigup:configuration','doctor.label.rigup:configuration'],
 ['rigup:local-state-ignore','doctor.label.rigup:local-state-ignore'],
 ['rigup:version','doctor.label.rigup:version'],
 ['tools:host-node','doctor.label.tools:host-node'],
 ['runtime-template','doctor.label.runtime-template'],
 ['build','doctor.label.build'],['lint','doctor.label.lint'],['test','doctor.label.test'],
 ['environment','doctor.label.environment'],['eval','doctor.label.eval'],
]);
const products:ReadonlyMap<string,string>=new Map([
 ['claude','Claude Code'],['codex','Codex'],['opencode','OpenCode'],['omp','OMP'],
 ['rigup','Rigup'],['openwiki','OpenWiki'],['codegraph','CodeGraph'],
]);

function label(diagnostic:Diagnostic):string{
 const {id}=diagnostic;
 const key=labels.get(id);
 if(key)return t(key);
 if(id.startsWith('env:'))return id.slice('env:'.length);
 const mcp=/^mcp:(claude|codex|opencode|omp):(.+)$/.exec(id);
 if(mcp)return t('doctor.label.mcp',{agent:products.get(mcp[1])??mcp[1],server:products.get(mcp[2])??mcp[2]});
 const state=/^(claude|codex|opencode|omp|openwiki|codegraph):(binary|load|initialization)$/.exec(id);
 if(state){
  const kind=state[2] as 'binary'|'load'|'initialization';
  return t(`doctor.label.${kind}`,{name:products.get(state[1])??state[1]});
 }
 return diagnostic[diagnosticTarget]??t('doctor.label.unknown');
}

export function formatDoctorLabel(diagnostic:Diagnostic,verbose=false):string{
 const name=label(diagnostic);
 return verbose?name+' ('+diagnostic.id+')':name;
}

export function formatDoctorReason(diagnostic:Diagnostic):string{
 return renderReason(diagnostic[reasonDetail]??diagnostic.reason);
}

export function doctorLegacyLastLine(report:Pick<InstallReport,'checks'|'nextCommand'>&{diagnostics:Diagnostic[]}):string|undefined{
 const check=report.checks.at(-1);
 if(check)return translate('en','doctor.check',{name:check.name,status:check.status,time:check.startedAt??'',commit:check.commit??''});
 const diagnostic=report.diagnostics.at(-1);
 return diagnostic?diagnostic.category+' '+diagnostic.id+': '+diagnostic.state+' — '+diagnostic.reason:report.nextCommand;
}
