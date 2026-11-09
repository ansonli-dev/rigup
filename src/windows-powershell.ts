import {execFile,type ExecFileOptions} from 'node:child_process';
import {win32} from 'node:path';
import {promisify} from 'node:util';

const exec=promisify(execFile);

export function windowsPowerShellExecutable():string{
 const systemRoot=process.env.SystemRoot;
 if(!systemRoot||!/^[a-z]:[\\/]/i.test(systemRoot))throw new Error('Windows system directory unavailable');
 return win32.join(systemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
}

export async function runWindowsPowerShell(command:string,options:Pick<ExecFileOptions,'env'|'timeout'|'maxBuffer'>={}){
 const executable=windowsPowerShellExecutable();
 return exec(executable,['-NoLogo','-NoProfile','-NonInteractive','-Command',command],{
  ...options,cwd:win32.dirname(executable),windowsHide:true,
 });
}
