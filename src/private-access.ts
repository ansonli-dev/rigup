import {execFile} from 'node:child_process';
import {dirname,join} from 'node:path';
import {promisify} from 'node:util';
import {windowsSystemCommand} from './windows-system-env.mjs';

const exec=promisify(execFile);
const options={windowsHide:true,timeout:5000,maxBuffer:16_384};

export async function protectWindowsPrivateFile(path:string){
 const system=dirname(windowsSystemCommand());
 const {stdout}=await exec(join(system,'whoami.exe'),['/user','/fo','csv','/nh'],options);
 const sid=/"(S-\d+(?:-\d+)+)"\s*$/.exec(stdout)?.[1];
 if(!sid)throw Error('Windows user identity unavailable');
 const tool=join(system,'icacls.exe');
 await exec(tool,[path,'/grant:r','*'+sid+':(F)'],options);
 await exec(tool,[path,'/inheritance:r'],options);
}
