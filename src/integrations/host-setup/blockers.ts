import type {Agent} from '../../types.js';
import {makeReason,ReasonError,reasonDetail,reasonFallback,type ReasonInput,type WithReasonDetail} from '../../i18n/reasons.js';

type Details={evidence?:string[];suggest?:string[];agentCanDraft?:boolean};
export interface Blocker extends WithReasonDetail {
 code:string;
 host:Agent;
 reason:string;
 evidence:string[];
 suggest:string[];
 agent_can_draft:boolean;
}

export class NativeBlocker extends ReasonError {
 constructor(readonly code:string,reason:ReasonInput,readonly details:Details={}){super(reason);}
}

export function toBlocker(host:Agent,error:unknown,details:Details={}):Blocker {
 const known=error instanceof NativeBlocker?error:undefined;
 const reason=known?.reason??makeReason('reason.native.prerequisites');
 return {code:known?.code??'prerequisite-unverified',host,
  reason:reasonFallback(reason),...(typeof reason==='string'?{}:{[reasonDetail]:reason}),
  evidence:[...new Set([...(known?.details.evidence??[]),...(details.evidence??[])])],
  suggest:[...new Set([...(known?.details.suggest??[]),...(details.suggest??[])])],
  agent_can_draft:known?.details.agentCanDraft??details.agentCanDraft??true};
}
