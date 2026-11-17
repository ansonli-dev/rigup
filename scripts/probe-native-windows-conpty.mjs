import childProcess from 'node:child_process';
import {appendFileSync,existsSync} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const spawn=childProcess.spawn;
childProcess.spawn=(file,args,options)=>{
 if(!Array.isArray(args)||!args.some(x=>String(x).includes('function Test-RigupAcl')))return spawn(file,args,options);
 const evidence=process.env.RIGUP_ACL_DIAGNOSTIC;
 const child=spawn(file,args,{...options,stdio:['pipe','pipe','pipe']});
 const append=text=>{if(evidence)appendFileSync(evidence,text);};
 append('helper env temp exists: '+existsSync(options.env.TEMP)+'\n');
 child.stderr.on('data',data=>append('helper stderr: '+data.toString().slice(0,3000)+'\n'));
 child.stderr.unref();
 child.stdout.on('data',data=>append('helper stdout: '+data.toString().slice(0,1000)+'\n'));
 child.on('error',error=>append('helper error: '+error.message+'\n'));
 child.on('exit',status=>append('helper exit: '+status+'\n'));
 return child;
};
syncBuiltinESMExports();
