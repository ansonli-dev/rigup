import assert from 'node:assert/strict';
import {mkdir,symlink,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {test} from 'node:test';
import type {HostRuntime} from '../src/integrations/host-setup/runtime.js';
import {project} from './helpers.js';

const id='@loneexile/omp-superpowers';
const load=()=>import('../src/integrations/host-setup/omp.js').catch(()=>undefined);
const runtime=(root:string,home:string,env:NodeJS.ProcessEnv={}):HostRuntime=>({
 root,home,env:{HOME:home,...env},stateRoot:join(home,'state'),approved:'runtime',writerRoot:join(home,'state'),
 program:{file:process.execPath,args:[]},
});
const put=async(path:string,value:unknown)=>{
 await mkdir(dirname(path),{recursive:true});
 await writeFile(path,typeof value==='string'?value:JSON.stringify(value));
};

test('OMP rejects a modified or redirected asset before archive processing',async()=>{
 const omp=await load();assert.ok(omp,'OMP recipe is missing');
 await assert.rejects(omp.downloadOmp(undefined,async (url,options)=>{
  assert.equal(url,'https://registry.npmjs.org/@loneexile/omp-superpowers/-/omp-superpowers-7.0.2-omp.3.tgz');
  assert.equal(options?.redirect,'error');
  return new Response(Buffer.alloc(221871),{status:200});
 }),/integrity/);
 await assert.rejects(omp.downloadOmp(undefined,async()=>new Response(null,{status:302})),/download/);
 await assert.rejects(omp.downloadOmp(undefined,async()=>new Response(Buffer.alloc(221872))),/size/);
});

test('OMP tar decoding rejects redirections and traversal even with a valid header checksum',async()=>{
 const omp=await load();assert.ok(omp,'OMP recipe is missing');
 for(const [name,type] of [['package/../escape','0'],['package/file','2'],['package/C:/file','0'],['package/NUL.txt','0']]){
  const header=Buffer.alloc(1536);
  header.write(name,0);
  header.write('00000000000\0',124);
  header.write(type,156);
  header.write('ustar\0',257);
  header.fill(0x20,148,156);
  const sum=header.subarray(0,512).reduce((a,b)=>a+b,0).toString(8).padStart(6,'0');
  header.write(sum+'\0 ',148);
  assert.throws(()=>omp.parseOmpTar(header),/Unsafe OMP archive entry/);
 }
});

test('OMP plugin lock keeps disabled, unverified and foreign targets out of preparation',()=>project(root=>project(async home=>{
 const omp=await load();assert.ok(omp,'OMP recipe is missing');
 const rt=runtime(root,home);
 const base=join(home,'.omp/plugins'),lock=join(base,'omp-plugins.lock.json');
 assert.equal((await omp.inspectOmp(rt)).status,'missing');
 await put(lock,{plugins:{[id]:{version:'7.0.2-omp.3',enabled:false}},settings:{}});
 await assert.rejects(omp.inspectOmp(rt),/disabled/);
 await put(lock,{plugins:{[id]:{version:'8.0.0',enabled:true}},settings:{}});
 await assert.rejects(omp.inspectOmp(rt),/different version/);
 await put(lock,{plugins:{},settings:{}});
 const foreign=join(home,'other-folder'),target=join(base,'node_modules',id);
 await mkdir(foreign);
 await mkdir(dirname(target),{recursive:true});
 await symlink(foreign,target,process.platform==='win32'?'junction':'dir');
 await assert.rejects(omp.inspectOmp(rt),/verified store/);
})));

test('OMP uses the named profile data root and treats required skill overrides as manual',()=>project(root=>project(async home=>{
 const omp=await load();assert.ok(omp,'OMP recipe is missing');
 const profile=join(home,'.omp/profiles/work'),xdg=join(home,'data');
 await mkdir(join(xdg,'omp','profiles','work'),{recursive:true});
 const rt=runtime(root,home,{OMP_PROFILE:'work',PI_CODING_AGENT_DIR:join(home,'decoy'),XDG_DATA_HOME:xdg});
 assert.equal((await omp.inspectOmp(rt)).plugins,join(process.platform==='win32'?profile:join(xdg,'omp','profiles','work'),'plugins'));
 await put(join(profile,'agent','config.yml'),'skills:\n  ignoredSkills: [brainstorming]\n');
 await assert.rejects(omp.inspectOmp(rt),/excludes required/);
})));

test('OMP rejects host dotenv files that could silently redirect plugin link',()=>project(root=>project(async home=>{
 const omp=await load();assert.ok(omp);
 for(const path of [join(home,'.env'),join(home,'.omp','.env'),join(home,'.omp','agent','.env')]){
  await put(path,'XDG_DATA_HOME='+root+'\nPI_CONFIG_FILES=another.yml\n');
  await assert.rejects(omp.inspectOmp(runtime(root,home)),error=>error instanceof Error&&error.message.includes(path));
  const {rm}=await import('node:fs/promises');
  await rm(path);
 }
})));

for(const key of ['PI_CONFIG_FILES','OMP_CONFIG_FILES'])test('OMP identifies the overlay that blocks link writes: '+key,()=>project(root=>project(async home=>{
 const omp=await load();assert.ok(omp);
 await assert.rejects(omp.inspectOmp(runtime(root,home,{[key]:join(home,'config.yaml')})),
  error=>error instanceof Error&&error.message.includes(key));
})));
