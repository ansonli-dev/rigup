import {readFile} from 'node:fs/promises';

export interface Recipe {packageIntegrity?:string;integrationId:string;version:string;kind:'agent'|'sdd'|'tool';sources:{url:string;revision:string;verifiedAt:string}[];evidenceStatus:{source:boolean;contract:boolean;live:boolean}}
export function requireRecipeEvidence(recipe:Recipe,version=recipe.version):void {
 if(version !== recipe.version) throw new Error(recipe.integrationId+': version change requires new evidence');
 if(!recipe.evidenceStatus.source || !recipe.sources.length) throw new Error(recipe.integrationId+': unverified source evidence');
 if(!/^(?:[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?|[a-f0-9]{40})$/.test(recipe.version)) throw new Error(recipe.integrationId+': exact version required');
 for(const source of recipe.sources) {
  if(!source.revision || !/^\d{4}-\d{2}-\d{2}$/.test(source.verifiedAt)) throw new Error('source evidence metadata missing');
  const url=new URL(source.url);if(url.protocol !== 'https:' || url.username || url.password) throw new Error('source evidence URL invalid');
 }
}
export function selectUpdateVersion(recipe:Recipe,installedVersion?:string,upgrade?:string):string {if(upgrade) {requireRecipeEvidence(recipe,upgrade);return upgrade;}
 return installedVersion ?? recipe.version;}
export function parseUpstreamLock(value:unknown):Recipe[]{
 if(!value || typeof value !== 'object') throw new Error('upstream lock: expected object');
 const doc=value as Record<string,unknown>;
 if(doc.schemaVersion !== 1 || !Array.isArray(doc.integrations)) throw new Error('upstream lock: schemaVersion/integrations invalid');
 const seen=new Set<string>();
 for(const raw of doc.integrations) {
  if(!raw || typeof raw !== 'object' || typeof raw.integrationId !== 'string' || !['agent','sdd','tool'].includes(raw.kind) || typeof raw.version !== 'string') throw new Error('upstream lock: invalid recipe');
  if(seen.has(raw.integrationId)) throw new Error('upstream lock: duplicate integration');seen.add(raw.integrationId);
  if(!Array.isArray(raw.sources) || !raw.evidenceStatus || ['source','contract','live'].some(k=>typeof raw.evidenceStatus[k] !== 'boolean')) throw new Error('upstream lock: evidence levels required');
  if(raw.integrationId === 'codegraph' && raw.repository !== 'https://github.com/colbymchenry/codegraph') throw new Error('CodeGraph repository does not match required upstream');
  if(!/^(?:[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?|[a-f0-9]{40})$/.test(raw.version)) throw new Error('upstream lock: exact version required');
  if(raw.evidenceStatus.source) requireRecipeEvidence(raw);
 }
 return doc.integrations as Recipe[];
}
export async function loadUpstreamLock():Promise<Recipe[]>{return parseUpstreamLock(JSON.parse(await readFile(new URL('../../docs/compatibility/upstream-lock.json',import.meta.url),'utf8')));}
