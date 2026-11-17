// Runs only in the isolated native Windows CI job. Capture the local PowerShell
// infrastructure error for diagnosis without exposing any host command output.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
import {windowsSystemEnvironment} from '../src/windows-system-env.mjs';

assert.equal(process.platform,'win32');
const dir=await mkdtemp(join(homedir(),'rigup-acl-probe-'));
const system=windowsSystemEnvironment();
let errorOutput='';
const spawn=childProcess.spawn;
childProcess.spawn=(file,args,options)=>{
 const child=spawn(file,args,{...options,stdio:['pipe','pipe','pipe']});
 child.stderr.on('data',bytes=>{errorOutput=(errorOutput+bytes.toString('utf8')).slice(0,4096);});
 return child;
};
syncBuiltinESMExports();
try{
 const {assertSafeWindowsAncestors}=await import('../src/private-access.ts');
 await assertSafeWindowsAncestors(join(dir,'child'),'Isolated ACL probe');
 console.log('Windows ACL probe passed');
}catch(error){
 console.log(JSON.stringify({helperTempExists:fs.existsSync(system.TEMP),runnerTempExists:fs.existsSync(process.env.TEMP??'')}));
 if(errorOutput)console.error(errorOutput);
 for(let cause=error;cause;cause=cause.cause)console.error(cause.message);
 process.exitCode=1;
}finally{
 childProcess.spawn=spawn;syncBuiltinESMExports();
 await rm(dir,{recursive:true,force:true});
}
