import type {ArtifactJob} from './artifacts.js';
import {relativeTarget} from './artifacts.js';
export const DOCUMENT_POLICY_VERSION='1';
export const markdownLinks=(text:string)=>text.matchAll(/(?<!\\)(?:\\\\)*\[[^\]]*\]\(([^)]+)\)/g);
export function validateDocumentJob(job:ArtifactJob,allowedRoots:string[],emptyProject=false):void{
 if(!job.consumer.trim()) throw new Error('consumer required');
 if(!job.reason.trim()) throw new Error('generation reason required');
 if(!relativeTarget(job.target)||!allowedRoots.some(root=>relativeTarget(root)&&job.target.startsWith(root+'/'))||/\/(?:SKILL|AGENTS|CLAUDE)\.md$/.test(job.target)) throw new Error('document target outside allowed scope');
 if(/as[- ]is|system overview|architecture overview|系统现状|架构全景/i.test(job.purpose+' '+job.target)) throw new Error('AS-IS belongs to OpenWiki');
 if(/\/(?:changes|specs|plans|adr|glossary)(?:\/|\.)|proposal\.md$|tasks\.md$/i.test(job.target)) throw new Error('setup cannot prefill change history, ADR or glossary');
 if(emptyProject) throw new Error('empty project has no evidenced document gaps');
}
export function validateTemplateContent(content:string):void {
 for(const clause of content.split(/[.;!\n?。；！？]/))for(const match of clause.matchAll(/(?:skip|bypass|ignore|disable).{0,45}(?:approval|gate|native workflow)|跳过.{0,20}(?:批准|审批|门禁)/gi)) {
  const before=clause.slice(0,match.index);
  const prohibition=/(?:never|do not|must not|should not|shall not|cannot|can't|don't)(?:\s+(?:ever|automatically|silently))?\s+$/i.test(before)||/(?:禁止|不得|不能|不应|不要)(?:擅自|自动|直接)?\s*$/.test(before);
  if(!prohibition)throw new Error('candidate overrides approval gate or native flow');
 }
}
export function validateDocumentContent(job:ArtifactJob,content:string):void{
 validateTemplateContent(content);
 if(!content.trim() || /^(?:TODO|TBD|placeholder|待补充)[.!\s]*$/i.test(content.trim()) || /\{\{[^}]+\}\}/.test(content)) throw new Error('required semantics cannot be placeholder');
 // A deterministic filter is only a first gate; independent semantic acceptance remains required.
 if(!job.acceptance.length) throw new Error('acceptance criteria required');
}
