import {spawn} from 'node:child_process';

const child=spawn(process.execPath,[
 '--import','tsx','--test','--test-concurrency=1',...process.argv.slice(2),'test/live-*.test.ts',
],{env:{...process.env,RIGUP_LIVE:'1'},stdio:'inherit'});
child.once('error',error=>{console.error(error.message);process.exitCode=1;});
child.once('exit',code=>{process.exitCode=code??1;});
