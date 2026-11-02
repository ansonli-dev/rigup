import type {SetupOptions,StepResult} from '../types.js';
import {scanRepository,repositoryReader,type ProjectProfile} from './repository.js';
import type {AnalysisBackend,ResearchRequest,ResearchResult} from './backend.js';
export async function analyze(root:string,options:SetupOptions,backend:AnalysisBackend,context:ResearchRequest):Promise<StepResult<ProjectProfile & {research:ResearchResult}>>{
 const profile=await scanRepository(root,options);
 const reader=await repositoryReader(root,options);
 const result=await backend.run({...context,kind:'analyze',root:profile.root,fingerprint:profile.fingerprint,options},reader);
 if(result.status === 'pending-host') return result;
 return {status:'complete',value:{...profile,research:result.value}};
}
