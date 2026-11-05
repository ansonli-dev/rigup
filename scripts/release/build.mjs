import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {access,copyFile,mkdir,mkdtemp,readFile,realpath,rename,rm,stat,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const exec=promisify(execFile);
export const sourceRoot=fileURLToPath(new URL('../../',import.meta.url));
export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
export const currentTarget=()=>process.platform+'-'+process.arch;
export async function compileLauncher({outDir}) {
  await mkdir(outDir,{recursive:true});
  const executable=join(outDir,'rigup');
  await exec('cc',['-std=c99','-O2','-Wall','-Wextra',fileURLToPath(new URL('./launcher.c',import.meta.url)),'-o',executable],{timeout:60_000});
  if(process.platform==='darwin')await exec('codesign',['--force','--sign','-','--timestamp=none',executable],{timeout:30_000});
  return executable;
}
async function absent(path) {
  try{await access(path);throw Error('Refusing to overwrite existing release output: '+path);}catch(error){if(error.code!=='ENOENT')throw error;}
}
async function runtimeArchive(lock,target,cache) {
  const item=lock.targets[target];if(!item)throw Error('Unsupported release target: '+target);
  await mkdir(cache,{recursive:true});const path=join(cache,item.archive);
  try{if(sha256(await readFile(path))!==item.sha256)throw Error('Cached Node runtime checksum mismatch');return path;}catch(error){if(error.code!=='ENOENT')throw error;}
  const temporary=path+'.'+process.pid+'.tmp';
  try{
    await exec('curl',['-q','--fail','--location','--proto','=https','--tlsv1.2','--retry','2','--connect-timeout','20','--max-time','180','--output',temporary,'--','https://nodejs.org/dist/v'+lock.version+'/'+item.archive],{timeout:200_000,maxBuffer:1_000_000});
    if(sha256(await readFile(temporary))!==item.sha256)throw Error('Downloaded Node runtime checksum mismatch');
    await rename(temporary,path);return path;
  }finally{await rm(temporary,{force:true});}
}
export async function buildRelease({outDir=resolve('release-out'),target=currentTarget()}={}) {
  if(target!==currentTarget())throw Error('Build each release target natively; requested '+target+' on '+currentTarget());
  const lock=JSON.parse(await readFile(new URL('./runtime-lock.json',import.meta.url),'utf8'));
  if(!lock.targets[target])throw Error('Unsupported release target: '+target);
  const pkg=JSON.parse(await readFile(join(sourceRoot,'package.json'),'utf8'));
  if(!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version))throw Error('Invalid release version');
  outDir=resolve(outDir);
  if(outDir===sourceRoot||sourceRoot.startsWith(outDir+'/'))throw Error('Release output cannot replace source');
  await mkdir(outDir,{recursive:true});
  const stem='rigup-'+pkg.version+'-'+target,asset=join(outDir,stem+'.tar.gz');await absent(asset);
  const workspace=await realpath(await mkdtemp(join(tmpdir(),'rigup-release-build-')));
  try{
    const packed=JSON.parse((await exec('npm',['pack','--json','--pack-destination',workspace],{cwd:sourceRoot,timeout:120_000,maxBuffer:2_000_000})).stdout)[0];
    const npmArchive=join(workspace,packed.filename),npmBytes=await readFile(npmArchive);
    const runtime=await runtimeArchive(lock,target,join(outDir,'runtime-cache'));
    const directory=join(workspace,stem),app=join(directory,'lib/app'),node=join(directory,'lib/node');
    await mkdir(app,{recursive:true});await mkdir(node,{recursive:true});
    await exec('tar',['-xzf',npmArchive,'-C',app,'--strip-components=1'],{timeout:60_000});
    const sourceLock=await readFile(join(sourceRoot,'package-lock.json'));await writeFile(join(app,'package-lock.json'),sourceLock);
    const npmrc=join(workspace,'npmrc'),globalNpmrc=join(workspace,'global-npmrc');await writeFile(npmrc,'');await writeFile(globalNpmrc,'');
    await exec('npm',['ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund','--userconfig',npmrc,'--globalconfig',globalNpmrc,'--registry','https://registry.npmjs.org/'],{cwd:app,timeout:240_000,maxBuffer:2_000_000});
    await exec('tar',['-xzf',runtime,'-C',node,'--strip-components=1'],{timeout:120_000});
    await compileLauncher({outDir:directory});
    for(const name of ['LICENSE','THIRD_PARTY_NOTICES.md'])await copyFile(join(sourceRoot,name),join(directory,name));
    const commit=(await exec('git',['rev-parse','HEAD'],{cwd:sourceRoot})).stdout.trim();
    const dirty=!!(await exec('git',['status','--porcelain'],{cwd:sourceRoot})).stdout.trim();
    const info={schemaVersion:1,version:pkg.version,target,source:{commit,dirty},runtime:{version:lock.version,...lock.targets[target]},npm:{name:packed.filename,sha256:sha256(npmBytes),integrity:packed.integrity},sourceLockSha256:sha256(sourceLock),application:'lib/app/dist/cli.js',runtimeExecutable:'lib/node/bin/node',consumerRuntime:'Installed MCP/hooks use Node on the consuming host/CI; the CLI only prepends its bundled runtime for its own children.'};
    await writeFile(join(directory,'BUILD_INFO.json'),JSON.stringify(info,null,2)+'\n');
    await writeFile(join(directory,'INSTALL.txt'),'Rigup '+pkg.version+' ('+target+')\n\nKeep this directory complete. Run ./rigup init from your project, or link rigup into PATH. The CLI includes Node.js '+lock.version+'; Git and ps are external requirements. Installed MCP/hooks need Node on the consuming host/CI. Licenses are included here, lib/node/LICENSE, and each lib/app/node_modules package. See https://github.com/ansonli-dev/rigup/releases and lib/app/docs/guides/releases.md.\n');
    await exec('tar',['-czf',asset,'-C',workspace,stem],{timeout:180_000,maxBuffer:1_000_000});
    const npmOutput=join(outDir,packed.filename);
    try{const existing=await readFile(npmOutput);if(sha256(existing)!==info.npm.sha256)throw Error('Different npm package already in release output');}catch(error){if(error.code!=='ENOENT')throw error;await writeFile(npmOutput,npmBytes,{flag:'wx'});}
    const result={...info,asset:{name:stem+'.tar.gz',sha256:sha256(await readFile(asset)),size:(await stat(asset)).size}};
    await writeFile(join(outDir,target+'.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
    return result;
  }finally{await rm(workspace,{recursive:true,force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{
    const args=process.argv.slice(2),options={};
    for(let i=0;i<args.length;i++){if(!['--out-dir','--target'].includes(args[i])||!args[i+1])throw Error('Usage: node scripts/release/build.mjs [--out-dir directory] [--target platform-arch]');options[args[i]==='--out-dir'?'outDir':'target']=args[++i];}
    console.log(JSON.stringify(await buildRelease(options)));
  }catch(error){console.error(error.message);process.exitCode=1;}
}
