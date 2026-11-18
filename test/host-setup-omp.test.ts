import assert from 'node:assert/strict';
import {mkdir,readFile,rm,stat,symlink,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {test} from 'node:test';
import type {HostRuntime} from '../src/integrations/host-setup/runtime.js';
import {project} from './helpers.js';
import {latestUrl,ompArchive,ompId as id,ompRegistryFixture} from './host-setup-fixtures.js';
import {resolveOmpPin} from '../src/integrations/host-setup/omp-pin.js';

const load=()=>import('../src/integrations/host-setup/omp.js').catch(()=>undefined);
const runtime=(root:string,home:string,env:NodeJS.ProcessEnv={}):HostRuntime=>({
 root,home,env:{HOME:home,...env},stateRoot:join(home,'state'),approved:'runtime',writerRoot:join(home,'state'),
 program:{file:process.execPath,args:[]},
});
const put=async(path:string,value:unknown)=>{
 await mkdir(dirname(path),{recursive:true});
 await writeFile(path,typeof value==='string'?value:JSON.stringify(value));
};

test('OMP resolves the official prerelease latest and rejects unusable registry metadata',async()=>{
 const {pin,metadata}=ompArchive();
 const urls:string[]=[];
 assert.deepEqual(await resolveOmpPin(async(url,options)=>{
  urls.push(String(url));assert.equal(options?.redirect,'error');return metadata();
 }),pin);
 assert.deepEqual(urls,[latestUrl]);
 for(const response of [
  {version:pin.version,dist:{...pin,tarball:'https://example.test/secret-redirect'}},
  {version:pin.version,dist:{...pin,integrity:'sha512-incomplete'}},
  {version:'../arbitrary-path',dist:pin},
  {dist:pin},
 ])await assert.rejects(resolveOmpPin(async()=>Response.json(response)),{code:'download-failed'});
});

test('OMP rejects a modified, oversized, or redirected asset before archive processing',async()=>{
 const omp=await load();assert.ok(omp,'OMP recipe is missing');
 const {pin}=ompArchive();
 await assert.rejects(omp.downloadOmp(pin,undefined,async (url,options)=>{
  assert.equal(url,pin.tarball);
  assert.equal(options?.redirect,'error');
  return new Response('modified');
 }),/integrity/);
 await assert.rejects(omp.downloadOmp(pin,undefined,async()=>new Response(null,{status:302})),/download/);
 await assert.rejects(omp.downloadOmp(pin,undefined,async()=>new Response(new Uint8Array(5_000_001))),/size/);
});

test('OMP stores complete archives under the approved version and reuses the verified store',()=>project(root=>project(async home=>{
 const omp=await load();assert.ok(omp);
 const rt=runtime(root,home),{bytes,pin,files}=ompArchive();
 const target=join(home,'state','native-packages','omp-superpowers-9.9.9-omp.1','package');
 await assert.rejects(omp.installOmpStore(rt,bytes,{...pin,version:'8.0.0'}),/manifest/);
 await assert.rejects(stat(join(rt.stateRoot,'native-packages')),{code:'ENOENT'});
 assert.equal(await omp.installOmpStore(rt,bytes,pin),target);
 for(const [name,content] of Object.entries(files))assert.equal(await readFile(join(target,name),'utf8'),content);
 assert.equal((await readFile(join(dirname(target),'complete'),'utf8')).trim(),pin.integrity);
 const first=await stat(dirname(target));
 assert.equal(await omp.installOmpStore(rt,bytes,pin),target);
 assert.equal((await stat(dirname(target))).mtimeMs,first.mtimeMs);
 await writeFile(join(target,'.pi/extensions/superpowers.ts'),'export default function changed() {}');
 await assert.rejects(omp.installOmpStore(rt,bytes,pin),/differs from the approved archive/);
})));

test('OMP tar decoding rejects redirections and traversal even with a valid header checksum',async()=>{
 const omp=await load();assert.ok(omp,'OMP recipe is missing');
 const {pin}=ompArchive();
 for(const [name,type] of [['package/../escape','0'],['package/file','2'],['package/C:/file','0'],['package/NUL.txt','0']]){
  const header=Buffer.alloc(1536);
  header.write(name,0);
  header.write('00000000000\0',124);
  header.write(type,156);
  header.write('ustar\0',257);
  header.fill(0x20,148,156);
  const sum=header.subarray(0,512).reduce((a,b)=>a+b,0).toString(8).padStart(6,'0');
  header.write(sum+'\0 ',148);
  assert.throws(()=>omp.parseOmpTar(header,pin),/Unsafe OMP archive entry/);
 }
});

test('OMP allows package registrations to be linked and protects foreign targets',()=>project(root=>project(async home=>{
 const omp=await load();assert.ok(omp,'OMP recipe is missing');
 const rt=runtime(root,home);
 const base=join(home,'.omp/plugins'),lock=join(base,'omp-plugins.lock.json');
 assert.equal((await omp.inspectOmp(rt)).status,'missing');
 await put(lock,{plugins:{[id]:{version:'7.0.2-omp.3',enabled:false}},settings:{}});
 await assert.rejects(omp.inspectOmp(rt),{code:'host-plugin-disabled'});
 await put(lock,{plugins:{[id]:{version:'8.0.0',enabled:true}},settings:{}});
 await put(join(base,'package.json'),{dependencies:{[id]:'8.0.0'}});
 assert.equal((await omp.inspectOmp(rt)).status,'missing');
 const foreign=join(home,'other-folder'),target=join(base,'node_modules',id);
 await mkdir(foreign);
 await mkdir(dirname(target),{recursive:true});
 await symlink(foreign,target,process.platform==='win32'?'junction':'dir');
 await assert.rejects(omp.inspectOmp(rt),{code:'omp-foreign-install'});
})));

test('OMP uses the named profile data root and treats required skill overrides as manual',()=>project(root=>project(async home=>{
 const omp=await load();assert.ok(omp,'OMP recipe is missing');
 const profile=join(home,'.omp/profiles/work'),xdg=join(home,'data');
 await mkdir(join(xdg,'omp','profiles','work'),{recursive:true});
 const rt=runtime(root,home,{OMP_PROFILE:'work',PI_CODING_AGENT_DIR:join(home,'decoy'),XDG_DATA_HOME:xdg});
 assert.equal((await omp.inspectOmp(rt)).plugins,join(process.platform==='win32'?profile:join(xdg,'omp','profiles','work'),'plugins'));
 await put(join(profile,'agent','config.yml'),'skills:\n  ignoredSkills: [brainstorming]\n');
 await assert.rejects(omp.inspectOmp(rt),{code:'host-plugin-disabled'});
})));

test('OMP reports only allowlisted dotenv key names and unreadable paths',()=>project(root=>project(async home=>{
 const omp=await load();assert.ok(omp);
 const [user,base,agent]=[join(home,'.env'),join(home,'.omp','.env'),join(home,'.omp','agent','.env')];
 await put(user,'EXAMPLE_API_KEY="secret-value\nPI_PROFILE=part-of-the-secret"\n');
 await put(base,'export PI_CONFIG_DIR="secret-location"\nXDG_DATA_HOME=secret-home\n');
 await mkdir(agent,{recursive:true});
 const {envReport}=await omp.inspectOmp(runtime(root,home,{PI_CONFIG_FILES:'secret-overlay',OMP_CONFIG_FILES:'also-secret'}));
 assert.deepEqual(envReport,{files:[user,base,agent],pathKeys:[
  {file:base,key:'PI_CONFIG_DIR'},{file:base,key:'XDG_DATA_HOME'},
  {file:'<environment>',key:'PI_CONFIG_FILES'},{file:'<environment>',key:'OMP_CONFIG_FILES'},
 ],unreadable:[agent]});
 assert.doesNotMatch(JSON.stringify(envReport),/secret|EXAMPLE_API_KEY|PI_PROFILE/);
})));

test('OMP uses config.yml before config.yaml and retains custom source evidence',()=>project(root=>project(async home=>{
 const omp=await load();assert.ok(omp);
 const base=join(home,'.omp','agent'),primary=join(base,'config.yml');
 await put(primary,'skills:\n  customDirectories: [custom-skills]\nextensions: [custom-extension.ts]\n');
 await put(join(base,'config.yaml'),'skills:\n  enabled: false\n');
 const inspected=await omp.inspectOmp(runtime(root,home));
 assert.equal(inspected.status,'missing');
 assert.ok(inspected.shadowEvidence.includes(primary+' (skills.customDirectories)'));
 assert.ok(inspected.shadowEvidence.includes(primary+' (extensions)'));
})));

test('the directory symlink probe selects registry only for Windows EPERM and removes scratch',async()=>{
 const {symlinksAllowed}=await import('../src/integrations/host-setup/symlink-probe.js');
 let calls=0;
 assert.equal(await symlinksAllowed('linux',async()=>{calls++;}),true);
 assert.equal(calls,0);
 for(const code of [undefined,'EPERM','EACCES']){
  let scratch:string|undefined;
  assert.equal(await symlinksAllowed('win32',async(source,link,type)=>{
   scratch=dirname(link);
   assert.equal(type,undefined);
   assert.ok((await stat(source)).isDirectory());
   if(code)throw Object.assign(Error('fixture failure'),{code});
   await symlink(source,link,process.platform==='win32'?'junction':'dir');
  }),code!=='EPERM');
  assert.ok(scratch);
  await assert.rejects(stat(scratch),{code:'ENOENT'});
 }
});

test('Windows directory symlink probe records native permission',{skip:process.platform!=='win32'},async t=>{
 const {symlinksAllowed}=await import('../src/integrations/host-setup/symlink-probe.js');
 let attempted=false,code:string|undefined;
 const allowed=await symlinksAllowed('win32',async (...args)=>{
  attempted=true;
  try{await symlink(...args);}catch(error){
   code=(error as NodeJS.ErrnoException).code;
   throw error;
  }
 });
 assert.ok(attempted);
 assert.equal(allowed,code!=='EPERM');
 t.diagnostic('Directory symlink result '+(code??'created')+'; preparation route '+(allowed?'link':'install'));
});

test('OMP verifies the real Bun registry tuple only after a registry dispatch',()=>project(root=>project(async home=>{
 const omp=await load();assert.ok(omp);
 const rt=runtime(root,home),base=join(home,'.omp','plugins'),fixture=ompRegistryFixture();
 const {target,bunLock,manifest}=await fixture.write(base);
 assert.deepEqual((await omp.inspectOmp(rt,'registry-receipt')).fromRegistry,
  {version:fixture.pin.version,integrity:fixture.pin.integrity});
 await assert.rejects(omp.inspectOmp(rt),{code:'omp-foreign-install'});
 await assert.rejects(omp.inspectOmp(rt,'registry-preflight'),{code:'omp-foreign-install'});
 assert.equal((await stat(target)).isDirectory(),true);
 const duplicate=fixture.lockText().replace('"packages": {','"packages": {}, "packages": {');
 for(const text of [duplicate,'{"packages":',fixture.lockText(['other@'+fixture.pin.version,'',{},fixture.pin.integrity]),' '.repeat(1_048_577)]){
  await put(bunLock,text);
  await assert.rejects(omp.inspectOmp(rt,'registry-receipt'),{code:'omp-not-recognized-after-install'});
 }
 await rm(bunLock);
 await assert.rejects(omp.inspectOmp(rt,'registry-receipt'),{code:'omp-not-recognized-after-install'});
 await put(bunLock,fixture.lockText());
 await put(manifest,{name:'@foreign/package',version:fixture.pin.version});
 await assert.rejects(omp.inspectOmp(rt,'registry-receipt'),{code:'omp-not-recognized-after-install'});
 await put(join(base,'omp-plugins.lock.json'),{plugins:{[id]:{enabled:false,version:fixture.pin.version}}});
 await assert.rejects(omp.inspectOmp(rt,'registry-receipt'),{code:'host-plugin-disabled'});
})));
