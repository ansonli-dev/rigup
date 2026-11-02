export type Agent = 'claude' | 'codex' | 'opencode' | 'omp';
export interface SetupOptions {
  agents: Agent[];
  backend: 'native' | 'host';
  profile?: string;
  scope?: string[];
  readBudget?: {maxFiles:number;maxBytes:number};
  templates?: {source:string;target:string;values?:Record<string,string>}[];
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

