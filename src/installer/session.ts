import {realpath} from 'node:fs/promises';
// Research backend choice does not determine which parent session has loaded
// project assets. Configuration-directory variables alone do not prove a session.
export async function sessionHandoffRequired(root:string,sessionsEnded=false):Promise<boolean>{
 if(sessionsEnded||!(process.env.CODEX_THREAD_ID||process.env.CLAUDECODE||process.env.OPENCODE))return false;
 const cwd=await realpath(process.cwd()),project=await realpath(root);
 return project===cwd||project.startsWith(cwd+'/')||cwd.startsWith(project+'/');
}
