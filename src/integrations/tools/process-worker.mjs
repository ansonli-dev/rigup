import {readFileSync,writeFileSync} from 'node:fs';
import {spawnCommand} from './windows-process.mjs';

try{
 const message=readFileSync(0,'utf8');
 if(message){
  const {spec,input}=JSON.parse(message);
  const child=spawnCommand(spec,{stdio:['pipe','inherit','inherit']});
  child.stdin.on('error',()=>{});
  child.stdin.end(input);
  child.once('error',()=>{process.exitCode=1;});
  child.once('exit',code=>{
   process.exitCode=code??1;
   if(code===0&&spec.successRecord){
    try{writeFileSync(spec.successRecord,'{"code":0}',{flag:'wx',mode:0o600,flush:true});}
    catch{process.exitCode=1;}
   }
  });
 }
}catch{process.exitCode=1;}
