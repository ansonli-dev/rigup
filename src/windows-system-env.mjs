import {userInfo} from 'node:os';
import {win32} from 'node:path';

export function windowsSystemPowerShell(){
 const root=process.env.SystemRoot;
 if(!root||!(/^[a-z]:[\\/][^:\r\n]+$/i.test(root)))throw Error('Windows system directory unavailable');
 return win32.join(root,'System32','WindowsPowerShell','v1.0','powershell.exe');
}

export function windowsSystemCommand(){
 return win32.join(win32.dirname(win32.dirname(win32.dirname(windowsSystemPowerShell()))),'cmd.exe');
}

/** @param {NodeJS.ProcessEnv} [approved] */
export function windowsSystemEnvironment(approved){
 const shell=win32.dirname(windowsSystemPowerShell());
 const sys=win32.dirname(win32.dirname(shell)),root=win32.dirname(sys);
 // Native .NET helper processes must not load modules or search for tools in a project.
 const home=userInfo().homedir,local=win32.join(home,'AppData','Local');
 const temp=approved?.TEMP??win32.join(local,'Temp');
 return {SystemRoot:root,WINDIR:root,SystemDrive:win32.parse(root).root.slice(0,2),ComSpec:win32.join(sys,'cmd.exe'),
  USERPROFILE:home,LOCALAPPDATA:local,APPDATA:win32.join(home,'AppData','Roaming'),TEMP:temp,TMP:temp,
  PATH:sys,PSModulePath:win32.join(shell,'Modules'),NoDefaultCurrentDirectoryInExePath:'1'};
}
