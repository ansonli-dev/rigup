export type Agent = 'claude' | 'codex' | 'opencode' | 'omp';
export interface SetupOptions {
  agents: Agent[];
  quality?:{preCommit?:CheckSelector[];prePush?:CheckSelector[];maxPushCommits?:number;gitlab?:{checks:CheckSelector[];reportPaths?:string[];openwiki?:{envRefs:string[];sourcePaths:string[]}}};
  customer?:{commands?:Record<string,CommandSpec>;envRefs?:string[];deployment?:{adapter:string;target:string;authorizationReference:string;recoveryRunbook:string}};
  sdd?: 'superpowers'|'openspec'|'spec-kit';
  tools?: {id:'openwiki'|'codegraph';install:boolean;initialize:boolean;agents:Agent[]}[];
  customSkills?: {source:string;position?:'prepare'|'deliver'|'release'}[];
  projectConventions?: {tracker?:{system:'gitlab'|'github'|'local'|'other';reference?:string;description?:string};documentRoutes?:Record<string,string>;labelMapping?:Record<string,string>};
  model?: {provider:'anthropic';model:string;apiKeyEnv:string};
  backend: 'codex' | 'native' | 'host';
  documentLanguage?: string;
  executionPolicy?:{mode:'continuous'|'review'};
  profile?: string;
  scope?: string[];
  researchBudget?:{maxCalls:number;maxTokens:number};
  readBudget?: {maxFiles:number;maxBytes:number};
  templates?: {source:string;target:string;values?:Record<string,string|number|boolean>}[];
  mcp?: {id:string;agents:Agent[];url?:string;command?:CommandSpec;envRefs?:string[]}[];
}
export type StepResult<T> =
  | { status: 'complete'; value: T }
  | { status: 'pending-host'; requestId: string; requestPath: string; nextCommand: string };
export function validateStepResult(value:unknown):void {
 if(!value || typeof value !== 'object') throw new Error('StepResult: expected object');
 const v=value as Record<string,unknown>;
 if(v.status === 'complete') {if(!('value' in v)) throw new Error('value: required');return;}
 if(v.status !== 'pending-host') throw new Error('status: invalid');
 if('value' in v) throw new Error('value: forbidden for pending-host');
 for(const key of ['requestId','requestPath','nextCommand']) if(typeof v[key] !== 'string' || !v[key]) throw new Error(key+': required');
}
export function validateInventory(ids:string[],items:{logicalId:string;action:string}[]):void {
 for(const id of ids) if(items.filter(i=>i.logicalId === id).length !== 1) throw new Error(id+': requires exactly one disposition');
 for(const item of items) if(!['retain','update','retire','pending'].includes(item.action)) throw new Error(item.logicalId+': invalid disposition');
}
export interface CommandSpec {executable:string;args:string[];cwd:string;envRefs:string[]}
export interface Evidence {path:string;startLine:number;endLine:number;digest:string}

export interface SetupOperation {
 id:string;integrationId:string;kind:'install'|'initialize'|'check';parameters:CommandSpec;prerequisiteIds:string[];declaredWrites:string[];version:string;timeoutMs:number;
 protection:{kind:'new-empty-scope';target:string}|{kind:'native-staging';target:string;staging:string;control:string};
 query:{kind:'npm-package'|'native-initialization';packageJson:string;packageLock:string;name:string;version:string;integrity?:string};
}
export interface NativeInitializationReceipt {version:string;target:string;identity:string}

export interface ManagedAsset {logicalId:string;target:string;ownership:import('./managed-input.js').Ownership;digest:string;baseline?:string;encoding?:'utf8'|'base64';mode?:number;source?:{kind:string;ref:string;digest?:string}}
export interface AssetDisposition {logicalId:string;action:'retain'|'update'|'retire'|'pending';reason:string}
export type ProjectRulesStatus='pending'|'ready';
export interface SetupRequirement {integrationId:string;reason:string;nextCommand?:string}
export interface SetupPlan {projectRules?:ProjectRulesStatus;root:string;fingerprint:string;options:SetupOptions;runChecks?:CheckKind[];assets:import('./integrations/registry.js').PreparedAsset[];operations:SetupOperation[];dispositions:AssetDisposition[];warnings:string[];requirements:SetupRequirement[];versions:Record<string,string>}

export type CheckKind='build'|'lint'|'test'|'environment'|'eval';
export interface NpmScript {cwd:string;script:string}
export type CheckSelector=CheckKind|NpmScript;
