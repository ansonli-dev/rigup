import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';

export async function fakeRigup(bin:string,reported:string,serverVersion=reported,hang=false,handshake=false){
 const code=`const fs=require('node:fs');
 if(process.argv.includes('--version')){${hang?'setTimeout(()=>{},60000);':'console.log('+JSON.stringify(reported)+');'}}
 else{fs.writeFileSync('mcp-started','yes');${handshake?`require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.method==='initialize')console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,result:{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'rigup',version:${JSON.stringify(serverVersion)}}}}));});`:''}}
 `;
 if(process.platform==='win32'){
  const pkg=join(bin,'node_modules/@ansonli.dev/rigup');await mkdir(join(pkg,'dist'),{recursive:true});
  await writeFile(join(pkg,'package.json'),JSON.stringify({name:'@ansonli.dev/rigup',bin:{rigup:'dist/cli.js'}}));
  await writeFile(join(pkg,'dist/cli.js'),code);
  await writeFile(join(bin,'rigup.cmd'),'@echo off\r\n');
 }else await writeFile(join(bin,'rigup'),'#!'+process.execPath+'\n'+code,{mode:0o700});
}
