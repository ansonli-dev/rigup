import assert from 'node:assert/strict';
import childProcess,{execFile,type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {access,lstat,mkdir,mkdtemp,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join,win32} from 'node:path';
import {test} from 'node:test';
import {promisify} from 'node:util';
import {assertPrivateAccess,assertSafeWindowsAncestors,createWindowsPrivateDirectory} from '../src/private-access.js';
import {runWindowsPowerShell,windowsPowerShellExecutable} from '../src/windows-powershell.js';

const native={skip:process.platform!=='win32'&&'requires native Windows ACLs'};
const exec=promisify(execFile);

async function fixture(run:(parent:string)=>Promise<void>,deep=false){
 const root=await mkdtemp(join(tmpdir(),'rigup-private-acl-'));
 try{
  let parent=root;
  while(deep&&parent.length<280)parent=join(parent,'nested-'+String(parent.length)+'-'+'x'.repeat(60));
  await mkdir(parent,{recursive:true});
  await run(parent);
 }finally{await rm(root,{recursive:true,force:true});}
}

const deepFixture=(run:(parent:string)=>Promise<void>)=>fixture(run,true);

async function grant(path:string,rights:string){
 const icacls=join(process.env.SystemRoot??'C:\\Windows','System32','icacls.exe');
 await exec(icacls,[win32.toNamespacedPath(path),'/grant','*S-1-1-0:('+rights+')'],{timeout:15000});
}

function deniedAt(path:string){
 return (error:unknown)=>{
  assert.ok(error instanceof Error);
  assert.match(error.message,/Windows ACL denied untrusted access grant.*S-1-1-0/);
  assert.ok(error.message.includes(path));
  assert.ok(!error.message.includes('\\\\?\\'),'internal extended paths must not enter public denial messages');
  return true;
 };
}

test('Windows ACL worker supports a host that rejects System.IO extended paths',native,async t=>{
 // PowerShell may have cached this switch before our script starts. Reset its
 // .NET Framework cache as well, then prove the reproduction is active.
 const legacy=String.raw`
$ErrorActionPreference = 'Stop'
[AppContext]::SetSwitch('Switch.System.IO.UseLegacyPathHandling', $true)
$switches = [object].Assembly.GetType('System.AppContextSwitches')
$switches.GetField('_useLegacyPathHandling', 'Static,NonPublic').SetValue($null, 1)
$rejected = $false
try { [void][IO.File]::GetAttributes(('\\?\' + $env:SystemRoot)) }
catch [ArgumentException] { $rejected = $true }
if (-not $rejected) { throw 'Legacy path handling was not reproduced' }
`;
 assert.equal((await runWindowsPowerShell(legacy+"[Console]::Write('legacy-paths-rejected')",{timeout:30000})).stdout,'legacy-paths-rejected');
 const children:ChildProcess[]=[];
 const realSpawn=childProcess.spawn;
 const replacement=t.mock.method(childProcess,'spawn',(file,args,options)=>{
  assert.equal(file,windowsPowerShellExecutable());
  const command=args.indexOf('-Command')+1;
  assert.ok(command>0);
  const child=realSpawn(file,[...args.slice(0,command),legacy+'\n'+args[command]],options);
  children.push(child);
  return child;
 });
 syncBuiltinESMExports();
 t.after(async()=>{
  replacement.mock.restore();
  syncBuiltinESMExports();
  for(const child of children){
   if(child.exitCode!==null||child.signalCode!==null)continue;
   const closed=once(child,'close');
   child.ref();
   child.kill();
   await closed;
  }
 });
 await deepFixture(async parent=>{
  const directory=join(parent,'private 测试'),record=join(directory,'record.json');
  await createWindowsPrivateDirectory(directory,'private directory required');
  await writeFile(record,'synthetic');
  await assertPrivateAccess(directory,await lstat(directory),'private directory required');
  await assertPrivateAccess(record,await lstat(record),'private record required');
  await assertSafeWindowsAncestors(record,'safe ancestors required');
  await grant(record,'R');
  await assert.rejects(assertPrivateAccess(record,await lstat(record),'private record required'),deniedAt(record));
 });
});

test('Windows creates and verifies private directories and files beyond legacy path limits',native,()=>deepFixture(async parent=>{
 const directory=join(parent,'private'),record=join(directory,'record.json');
 await createWindowsPrivateDirectory(directory,'private directory required');
 await assertPrivateAccess(directory,await lstat(directory),'private directory required');
 await writeFile(record,'{"synthetic":true}\n');
 await assertPrivateAccess(record,await lstat(record),'private record required');
 await assertSafeWindowsAncestors(record,'safe ancestors required');
 assert.equal(await readFile(record,'utf8'),'{"synthetic":true}\n');
}));

test('Windows deep private files still reject public read grants with the original path',native,()=>deepFixture(async parent=>{
 const directory=join(parent,'private'),record=join(directory,'record.json');
 await createWindowsPrivateDirectory(directory,'private directory required');
 await writeFile(record,'synthetic');
 await grant(record,'R');
 await assert.rejects(assertPrivateAccess(record,await lstat(record),'private record required'),deniedAt(record));
 assert.equal(await readFile(record,'utf8'),'synthetic');
}));

test('Windows deep ancestor denials prevent creation and report the original ancestor path',native,()=>deepFixture(async parent=>{
 await grant(parent,'WA');
 const target=join(parent,'must-not-create');
 await assert.rejects(createWindowsPrivateDirectory(target,'private directory required'),deniedAt(parent));
 await assert.rejects(access(target),{code:'ENOENT'});
}));

test('Windows protected creation excludes inherited public access and preserves existing ACLs',native,()=>fixture(async parent=>{
 await grant(parent,'OI)(CI)(RX');
 const directory=join(parent,'private 测试');
 const sddl=async()=>{
  const command=`$acl = [IO.Directory]::GetAccessControl('${directory.replace(/'/g,"''")}'); [Console]::Write($acl.GetSecurityDescriptorSddlForm('All'))`;
  return (await runWindowsPowerShell(command,{timeout:30000})).stdout;
 };
 await createWindowsPrivateDirectory(directory,'private directory required');
 const initial=await sddl();
 assert.match(initial,/D:P/,'the new DACL is protected from inheritance');
 assert.doesNotMatch(initial,/;;;WD\)/,'Everyone must not be inherited');
 await createWindowsPrivateDirectory(directory,'private directory required');
 assert.equal(await sddl(),initial);
 await grant(directory,'R');
 const publicAcl=await sddl();
 await assert.rejects(createWindowsPrivateDirectory(directory,'private directory required'),deniedAt(directory));
 assert.equal(await sddl(),publicAcl,'an existing unsafe DACL must not be silently repaired');
}));

test('Windows ACL checks fail closed on missing paths, wrong types and junctions',native,()=>fixture(async parent=>{
 const directory=join(parent,'private'),record=join(directory,'record.json');
 await createWindowsPrivateDirectory(directory,'private directory required');
 await writeFile(record,'synthetic');
 await assert.rejects(createWindowsPrivateDirectory(record,'private directory required'),/Windows ACL (?:denied unexpected file type|I\/O failed)/);
 await assert.rejects(assertPrivateAccess(directory,await lstat(record),'private file required'),/Windows ACL denied unexpected file type/);
 await assert.rejects(assertPrivateAccess(join(directory,'missing'),await lstat(record),'private file required'),/Windows ACL I\/O failed/);
 const missingParent=join(directory,'missing-parent'),target=join(missingParent,'must-not-create');
 await assert.rejects(createWindowsPrivateDirectory(target,'private directory required'),/Windows ACL I\/O failed/);
 await assert.rejects(access(missingParent),{code:'ENOENT'});
 const link=join(parent,'junction');
 await symlink(directory,link,'junction');
 await assert.rejects(createWindowsPrivateDirectory(link,'private directory required'),/Windows ACL denied unexpected file type/);
 await assert.rejects(createWindowsPrivateDirectory(join(link,'must-not-create'),'private directory required'),/Windows ACL denied unexpected file type/);
 await assert.rejects(access(join(directory,'must-not-create')),{code:'ENOENT'});
 assert.equal(await readFile(record,'utf8'),'synthetic');
}));

test('Windows private access rejects namespace and ambiguous paths before launching the ACL worker',async()=>{
 for(const path of ['\\\\?\\C:\\private','\\\\server\\share\\private','C:\\private\\file:stream','C:\\private\\trailing.','C:\\private\\NUL','C:\\private\\question?','C:\\private\\control\0']){
  await assert.rejects(createWindowsPrivateDirectory(path,'private directory required'),/unsafe Windows path/);
 }
});
