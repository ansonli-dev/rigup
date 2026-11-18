import type {Agent} from '../../types.js';

type Details={evidence?:string[];suggest?:string[];agentCanDraft?:boolean};
export interface Blocker {
 code:string;
 host:Agent;
 reason:string;
 evidence:string[];
 suggest:string[];
 agent_can_draft:boolean;
}

export class NativeBlocker extends Error {
 constructor(readonly code:string,message:string,readonly details:Details={}){super(message);}
}

export function toBlocker(host:Agent,error:unknown,details:Details={}):Blocker {
 const known=error instanceof NativeBlocker?error:undefined;
 return {code:known?.code??'prerequisite-unverified',host,
  reason:known?.message??'Native setup prerequisites could not be verified; prepare manually.',
  evidence:[...new Set([...(known?.details.evidence??[]),...(details.evidence??[])])],
  suggest:[...new Set([...(known?.details.suggest??[]),...(details.suggest??[])])],
  agent_can_draft:known?.details.agentCanDraft??details.agentCanDraft??true};
}
