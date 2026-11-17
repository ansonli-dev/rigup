import {execFile,type ExecFileOptions} from 'node:child_process';
import {win32} from 'node:path';
import {promisify} from 'node:util';
import {windowsSystemEnvironment,windowsSystemPowerShell} from './windows-system-env.mjs';

const exec=promisify(execFile);

export const windowsPowerShellExecutable=windowsSystemPowerShell;

export async function runWindowsPowerShell(command:string,options:Pick<ExecFileOptions,'env'|'timeout'|'maxBuffer'>={}){
 const executable=windowsPowerShellExecutable();
 return exec(executable,['-NoLogo','-NoProfile','-NonInteractive','-Command',command],{
  ...options,env:windowsSystemEnvironment(options.env),cwd:win32.dirname(executable),windowsHide:true,
 });
}
