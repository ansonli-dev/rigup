import type {SetupOptions} from '../types.js';
import {ResearchFailure} from './backend.js';

export function researchBudget(options:SetupOptions):NonNullable<SetupOptions['researchBudget']> {
 return options.researchBudget??{maxCalls:60,maxTokens:options.backend==='codex'?1_200_000:100_000};
}

export class CodexTokenLimit extends ResearchFailure {
 readonly suggestedLimit:number;
 constructor(readonly spent:number,readonly limit:number,readonly estimatedNext?:number){
  super(estimatedNext===undefined
   ?'Codex observed token usage '+spent+' exceeds the research budget of '+limit
   :'Codex estimated '+estimatedNext+' tokens for the next request; remaining budget '+Math.max(0,limit-spent)+' ('+spent+' used of '+limit+'). Request was not sent.');
  this.suggestedLimit=Math.min(Number.MAX_SAFE_INTEGER,Math.max(spent+(estimatedNext??0),2*limit));
 }
}
