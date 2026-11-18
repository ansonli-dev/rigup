import {en} from './en.js';
import {currentLocale,translate,type Locale,type MessageKey,type MessageParams} from './index.js';

const reusedReasonCodes=[
 'cli.invalidLanguage','cli.invalidJson','cli.operationFailed',
 'cli.applySavedPreview','cli.providerRequired','cli.interruptedSeed','cli.interruptedTool',
 'cli.claimSelectionMismatch','cli.claimIncomplete','cli.claimAgentsRequired','cli.initRequired','cli.pathAgentsRequired',
 'cli.interruptedResearch','openspec.resume','openspec.resumeScope','lifecycle.rulesNext','result.reviewWait',
 'native.manualOmp','native.manualCodex','native.manualOpenCode',
 'doctor.initRequired','doctor.claimUnrecorded','doctor.claimSelectionRequired','doctor.claimIncomplete',
 'doctor.manifestMissing','doctor.manifestReadable','doctor.manifestDamaged','doctor.recoveryDamaged',
 'doctor.interrupted','doctor.rulesPending','doctor.selectionMissing','doctor.baselineMissing','doctor.targetMissing',
 'doctor.modeChanged','doctor.contentPresent','doctor.modified','doctor.ownershipInvalid','doctor.binaryFound','doctor.binaryMissing',
 'doctor.hostReload','doctor.hostReloadClaude','doctor.hostUnconfigured','doctor.hostProbe','doctor.hostVersion','doctor.nodeFound',
 'doctor.externalFound','doctor.receipt','doctor.wikiBaseline','doctor.nativeUnavailable','doctor.runtimePending','doctor.checkResult',
 'preview.seedPrevious','preview.seedMissing','preview.seedExisting','preview.seedCreate',
 'preview.mergeRemoveBaseline','preview.mergeRemoveChanged','preview.mergeMissingContent','preview.mergeExistingChanged',
 'preview.mergeLocalDeleted','preview.mergeBinary','preview.mergeOverlapping',
] as const satisfies readonly MessageKey[];

type CatalogueReasonCode=Extract<MessageKey,`reason.${string}`|`artifact.env${string}`|`runtime.source.${string}`>;
export type ReasonCode=CatalogueReasonCode|typeof reusedReasonCodes[number];
export const reasonCodes:readonly ReasonCode[]=[
 ...reusedReasonCodes,
 ...(Object.keys(en) as MessageKey[]).filter((key):key is CatalogueReasonCode=>
  key.startsWith('reason.')||key.startsWith('artifact.env')||key.startsWith('runtime.source.')),
];
const knownCodes=new Set(reasonCodes);

export type ReasonParams=Readonly<Record<string,string|number|LocalizableReason>>;
export interface LocalizableReason {readonly code:ReasonCode;readonly params:ReasonParams;readonly fallback:string}
export type ReasonInput=string|LocalizableReason;

// Machine reports and approval hashes consume string-keyed properties.
export const reasonDetail:unique symbol=Symbol('reasonDetail');
export const nextStepReasonDetail:unique symbol=Symbol('nextStepReasonDetail');
export interface WithReasonDetail {[reasonDetail]?:ReasonInput;[nextStepReasonDetail]?:ReasonInput}
export type ReasonedReport=Record<string,unknown>&WithReasonDetail;

export function reasonFallback(input:ReasonInput):string{
 return typeof input==='string'?input:input.fallback;
}

function expand(params:ReasonParams,render:(reason:LocalizableReason)=>string):MessageParams{
 return Object.fromEntries(Object.entries(params).map(([key,value])=>[key,typeof value==='object'?render(value):value]));
}

export function makeReason(code:ReasonCode,params:ReasonParams={},fallback?:string):LocalizableReason{
 return {code,params,fallback:fallback??translate('en',code,expand(params,reasonFallback))};
}

export function renderReason(input:ReasonInput,locale:Locale=currentLocale()):string{
 if(typeof input==='string')return input;
 if(!knownCodes.has(input.code))return input.fallback;
 return translate(locale,input.code,expand(input.params,reason=>renderReason(reason,locale)));
}

export class ReasonError extends Error {
 constructor(readonly reason:ReasonInput){super(reasonFallback(reason));}
}

export function reasonFromError(error:unknown):ReasonInput{
 if(error instanceof ReasonError)return error.reason;
 if(error instanceof SyntaxError)return makeReason('cli.invalidJson');
 return error instanceof Error?error.message:makeReason('cli.operationFailed');
}
