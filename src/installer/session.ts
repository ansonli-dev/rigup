import {realpath} from 'node:fs/promises';
import {isAbsolute,relative,sep} from 'node:path';

function contains(root:string,target:string):boolean {
 const path=relative(root,target);
 return !isAbsolute(path)&&path!=='..'&&!path.startsWith('..'+sep);
}
// Research backend choice does not determine which parent session has loaded
// project assets. Configuration-directory variables alone do not prove a session.
export async function sessionHandoffRequired(root:string,sessionsEnded=false):Promise<boolean>{
 if(sessionsEnded||!(process.env.CODEX_THREAD_ID||process.env.CLAUDECODE||process.env.OPENCODE))return false;
 const cwd=await realpath(process.cwd()),project=await realpath(root);
 return contains(project,cwd)||contains(cwd,project);
}
