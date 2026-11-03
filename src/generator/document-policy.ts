import type {ArtifactJob} from './artifacts.js';
import {relativeTarget} from './artifacts.js';
export const DOCUMENT_POLICY_VERSION='1';
export function validateDocumentJob(job:ArtifactJob,allowedRoots:string[],emptyProject=false):void{
 if(!job.consumer.trim()) throw new Error('consumer required');
 if(!job.reason.trim()) throw new Error('generation reason required');
 if(!relativeTarget(job.target)||!allowedRoots.some(root=>relativeTarget(root)&&job.target.startsWith(root+'/'))||/\/(?:SKILL|AGENTS|CLAUDE)\.md$/.test(job.target)) throw new Error('document target outside allowed scope');
 if(/as[- ]is|system overview|architecture overview|系统现状|架构全景/i.test(job.purpose+' '+job.target)) throw new Error('AS-IS belongs to OpenWiki');
 if(/\/(?:changes|specs|plans|adr|glossary)(?:\/|\.)|proposal\.md$|tasks\.md$/i.test(job.target)) throw new Error('setup cannot prefill change history, ADR or glossary');
 if(emptyProject) throw new Error('empty project has no evidenced document gaps');
}
export function validateTemplateContent(content:string):void {
 if(/(?:skip|bypass|ignore|disable).{0,45}(?:approval|gate|native workflow)|跳过.{0,20}(?:批准|审批|门禁)/i.test(content)) throw new Error('candidate overrides approval gate or native flow');
}
export function validateDocumentContent(job:ArtifactJob,content:string):void{
 validateTemplateContent(content);
 if(!content.trim() || /^(?:TODO|TBD|placeholder|待补充)[.!\s]*$/i.test(content.trim()) || /\{\{[^}]+\}\}/.test(content)) throw new Error('required semantics cannot be placeholder');
 // A deterministic filter is only a first gate; independent semantic acceptance remains required.
 if(/(?:skip|bypass|ignore|disable).{0,45}(?:approval|gate|native workflow)|跳过.{0,20}(?:批准|审批|门禁)/i.test(content)) throw new Error('candidate overrides approval gate or native flow');
 if(!job.acceptance.length) throw new Error('acceptance criteria required');
}
