import {posix} from 'node:path';
import type {Evidence} from '../types.js';
export interface ProjectRuleSource {
 id:string;
 topic:string;
 statement:string;
 authority:'explicit-rule'|'convention';
 scope:string[];
 supportingEvidence:Evidence[];
 counterEvidence:Evidence[];
 exceptions:string[];
}
export interface ArtifactJob {logicalId:string;target:string;purpose:string;consumer:string;required:boolean;reason:string;sourceRefs:Evidence[];seedPaths:string[];relatedArtifacts:string[];acceptance:string[];status:'pending'|'done';ruleSources?:ProjectRuleSource[]}
export function relativeTarget(target:string):boolean {return !!target && !target.startsWith('/') && !target.includes('\\') && !target.split('/').includes('..') && posix.normalize(target) === target && target !== '.';}
export function validateArtifactList(input:unknown,required:string[]):ArtifactJob[]{
 if(!Array.isArray(input)) throw new Error('artifacts: expected array');
 const ids=new Set<string>(),targets=new Set<string>();
 const jobs=input.map(raw=>{
  if(!raw || typeof raw !== 'object') throw new Error('artifact: expected object');
  if('ruleSources' in raw) throw new Error('artifact.ruleSources: reserved for verified project rules');
  for(const key of ['logicalId','target','purpose','consumer','reason']) if(typeof raw[key] !== 'string' || !raw[key].trim()) throw new Error('artifact.'+key+': required');
  if(!relativeTarget(raw.target)||!raw.target.endsWith('.md')) throw new Error('artifact.target: invalid or escaping target');
  if(ids.has(raw.logicalId)||targets.has(raw.target)) throw new Error('duplicate artifact id or target');ids.add(raw.logicalId);targets.add(raw.target);
  if(typeof raw.required !== 'boolean') throw new Error('artifact.required: boolean required');
  for(const key of ['seedPaths','relatedArtifacts','acceptance']) if(!Array.isArray(raw[key])||raw[key].some((v:unknown)=>typeof v !== 'string')) throw new Error('artifact.'+key+': string array required');
  if(raw.seedPaths.some((p:string)=>!relativeTarget(p))) throw new Error('seed path escapes repository');
  if(!Array.isArray(raw.sourceRefs)||raw.sourceRefs.some((e:Evidence)=>!e||!relativeTarget(e.path)||!Number.isInteger(e.startLine)||!Number.isInteger(e.endLine)||e.startLine<1||e.endLine<e.startLine||!/^[a-f0-9]{64}$/.test(e.digest))) throw new Error('artifact.sourceRefs: invalid evidence');
  if(!raw.acceptance.length) throw new Error('artifact.acceptance: required');
  return {...raw,status:'pending'} as ArtifactJob;
 });
 for(const id of required) if(!ids.has(id)) throw new Error('required artifact missing: '+id);
 for(const job of jobs) if(job.relatedArtifacts.some(id=>!ids.has(id))) throw new Error('related artifact missing');
 return jobs;
}
