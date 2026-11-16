import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {dirname,join} from 'node:path';
import {promisify} from 'node:util';
import {npmCommand} from '../src/npm-command.mjs';
import {essentialEnvironment} from '../src/runtime-inputs.js';
import {project} from './helpers.js';

const exec=promisify(execFile);
type Package={manifest:Record<string,unknown>;bytes:Buffer;integrity:string;advertisedIntegrity?:string};
type Registry={
 url:string;
 publish:(name:string,version:string,manifest?:Record<string,unknown>,files?:Record<string,string>)=>Promise<Package>;
 tag:(name:string,tag:string,version:string)=>void;
 requests:{path:string;authorization?:string}[];
 responseStatus:number;
 onRequest?:()=>void;
 onTarball?:()=>void;
};

export async function npmRegistry(run:(registry:Registry)=>Promise<void>):Promise<void>{
 const packages=new Map<string,Map<string,Package>>();
 const tags=new Map<string,Record<string,string>>();
 const registry:Registry={url:'',requests:[],responseStatus:200,tag(name,tag,version){
  tags.set(name,{...tags.get(name),[tag]:version});
 },async publish(name,version,fields={},files={}){
  let result:Package|undefined;
  await project(async directory=>{
   const manifest={...fields,name,version};
   await writeFile(join(directory,'package.json'),JSON.stringify(manifest));
   for(const [path,text] of Object.entries(files)){
    const target=join(directory,path);await mkdir(dirname(target),{recursive:true});await writeFile(target,text);
   }
   const command=npmCommand(['pack','--ignore-scripts','--offline','--json']);
   const {stdout}=await exec(command.executable,command.args,{cwd:directory,timeout:20_000,env:essentialEnvironment()});
   const [archive]=JSON.parse(stdout);
   const bytes=await readFile(join(directory,archive.filename));
   result={manifest,bytes,integrity:'sha512-'+createHash('sha512').update(bytes).digest('base64')};
  });
  const versions=packages.get(name)??new Map<string,Package>();
  versions.set(version,result!);packages.set(name,versions);
  if(!tags.has(name))registry.tag(name,'latest',version);
  return result!;
 }};
 const server=createServer((request,response)=>{
  const path=decodeURIComponent(new URL(request.url!,'http://localhost').pathname);
  registry.requests.push({path,authorization:request.headers.authorization});
  registry.onRequest?.();
  if(registry.responseStatus!==200){response.writeHead(registry.responseStatus).end();return;}
  for(const [name,versions] of packages){
   const tarball=(version:string)=>'/team/'+name+'/-/'+version+'.tgz';
   if(path==='/team/'+name){
    const entries=Object.fromEntries([...versions].map(([version,pkg])=>[version,{...pkg.manifest,dist:{integrity:pkg.advertisedIntegrity??pkg.integrity,tarball:new URL(tarball(version),registry.url).href}}]));
    response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({name,'dist-tags':tags.get(name),versions:entries}));return;
   }
   for(const [version,pkg] of versions)if(path===tarball(version)){
    registry.onTarball?.();response.writeHead(200,{'content-type':'application/octet-stream'}).end(pkg.bytes);return;
   }
  }
  response.writeHead(404).end();
 });
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const address=server.address();if(!address||typeof address==='string')throw Error('Fixture did not bind a TCP port');
 registry.url='http://127.0.0.1:'+address.port+'/team/';
 try{await run(registry);}finally{await new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();});}
}
