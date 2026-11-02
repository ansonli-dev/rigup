import type {SetupOptions,StepResult} from '../types.js';
import {scanRepository,type ProjectProfile} from './repository.js';
// Semantic research is added by the backend task; this is the static discovery phase.
export async function analyze(root:string,options:SetupOptions):Promise<StepResult<ProjectProfile>>{
 return {status:'complete',value:await scanRepository(root,options)};
}
