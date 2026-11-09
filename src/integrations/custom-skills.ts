import {readFile,readdir,stat} from 'node:fs/promises';
import {resolve,relative,posix,parse as parsePath} from 'node:path';
import {parse} from 'yaml';
import {safePath,digest} from '../analyzer/evidence.js';
import {secretName} from '../analyzer/read-policy.js';
export interface SkillAsset {logicalId:string;target:string;content:string;encoding:'utf8'|'base64';mode:number;ownership:{kind:'file'};source:{kind:'customer-skill';ref:string;digest:string}}
export async function collectCustomSkill(source:string,targetRoot:string):Promise<SkillAsset[]>{
 if(!['.agents/skills','.claude/skills','.opencode/skills','.omp/skills'].includes(targetRoot)) throw new Error('skill target root unsupported');
 source=resolve(source);
 source=await safePath(parsePath(source).root,source);
 const skillPath=await safePath(source,'SKILL.md');
 if((await stat(skillPath)).size>1_000_000) throw new Error('skill frontmatter exceeds budget');
 const skill=await readFile(skillPath,'utf8');
 const match=skill.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
 if(!match) throw new Error('skill: frontmatter required');
 const metadata=parse(match[1]);
 if(!metadata || typeof metadata.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(metadata.name) || typeof metadata.description !== 'string' || !metadata.description.trim()) throw new Error('skill: valid name and description required');
 if(['change-prepare','change-deliver','change-release'].includes(metadata.name)) throw new Error('skill: fixed public entry collision');
 const assets:SkillAsset[]=[];let bytes=0;
 async function walk(dir:string):Promise<void>{
  for(const entry of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
   if(entry.name === '.git' || entry.name === 'node_modules') continue;
   if(secretName.test(entry.name)) throw new Error('skill: secret resource denied');
   if(entry.isSymbolicLink()) throw new Error('skill: symlink resource denied');
   const path=resolve(dir,entry.name);
   if(entry.isDirectory()){await walk(path);continue;}
   if(!entry.isFile()) throw new Error('skill: unsupported resource type');
   const info=await stat(await safePath(source,relative(source,path)));
   if(assets.length>=500 || bytes+info.size>5_000_000) throw new Error('skill resource budget exceeded');
   const content=await readFile(path);bytes+=content.length;
   const text=content.toString('utf8');const encoding=Buffer.from(text).equals(content)&&!text.includes('\0') ? 'utf8' : 'base64';
   const target=posix.join(targetRoot,metadata.name,relative(source,path).split('\\').join('/'));
   assets.push({logicalId:'skill:'+target,target,content:encoding === 'utf8' ? text : content.toString('base64'),encoding,mode:info.mode&0o777,ownership:{kind:'file'},source:{kind:'customer-skill',ref:path,digest:digest(content)}});
  }
 }
 await walk(source);return assets;
}
