import {spawn} from 'node:child_process';
import {connect} from 'node:net';
import {text} from 'node:stream/consumers';

// The Job Object worker delivers a single launch message. After that, a named
// pipe forwards the probe's interactive stdin while the job owns the whole tree.
const {pipe,token}=JSON.parse(await text(process.stdin));
const input=connect(pipe);
input.once('error',()=>process.exit(1));
input.once('connect',()=>{
 const [executable,...args]=process.argv.slice(2);
 const child=spawn(executable,args,{stdio:['pipe','inherit','inherit'],windowsHide:true});
 child.once('error',error=>{process.stderr.write(error.message+'\n');process.exitCode=1;input.destroy();});
 child.once('exit',code=>{process.exitCode=code??1;input.destroy();});
 child.stdin.on('error',()=>{});
 input.write(token);
 input.pipe(child.stdin);
});
