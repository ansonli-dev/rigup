import {execFile,spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {statSync} from 'node:fs';
import {win32 as path} from 'node:path';
import {promisify} from 'node:util';

const exec=promisify(execFile);
const unavailable=0x20000001, remaining=0x20000002, unconfirmed=0x20000003, active=0x20000004;
const jobPattern=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

const native=String.raw`
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class RigupWindowsJob {
 const int Unavailable = 0x20000001, Remaining = 0x20000002, Unconfirmed = 0x20000003;
 const uint Suspended = 0x4, UnicodeEnvironment = 0x400, ExtendedStartup = 0x80000, NoWindow = 0x08000000;
 const uint KillOnClose = 0x2000, Infinite = 0xffffffff;

 [StructLayout(LayoutKind.Sequential)] struct Security { public int Size; public IntPtr Descriptor; public int Inherit; }
 [StructLayout(LayoutKind.Sequential)] struct Startup {
  public int Size; public IntPtr Reserved, Desktop, Title;
  public int X, Y, Width, Height, Columns, Rows, Fill, Flags;
  public short ShowWindow, ReservedSize; public IntPtr ReservedData, Input, Output, Error;
 }
 [StructLayout(LayoutKind.Sequential)] struct StartupEx { public Startup Startup; public IntPtr Attributes; }
 [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public int ProcessId, ThreadId; }
 [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
  public long ProcessTime, JobTime; public uint Flags;
  public UIntPtr MinWorkingSet, MaxWorkingSet; public uint ActiveLimit;
  public UIntPtr Affinity; public uint Priority, Scheduling;
 }
 [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
  public BasicLimits Basic; public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
  public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
 }
 [StructLayout(LayoutKind.Sequential)] struct Accounting {
  public long User, Kernel, PeriodUser, PeriodKernel;
  public uint Faults, Total, Active, Terminated;
 }

 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security, string name);
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits info, int size);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting info, int size, IntPtr length);
 [DllImport("kernel32.dll", EntryPoint="QueryInformationJobObject", SetLastError=true)] static extern bool QueryJobList(IntPtr job, int kind, IntPtr info, int size, IntPtr length);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
 [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string application, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string cwd, ref StartupEx startup, out ProcessInfo info);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref Security security, uint size);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool WriteFile(IntPtr file, byte[] data, int count, out int written, IntPtr overlap);
 [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
 [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int id);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(IntPtr source, IntPtr handle, IntPtr destination, out IntPtr copy, uint access, bool inherit, uint flags);
 [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
 [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool all, uint timeout);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

 static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
 static void Close(IntPtr handle) { if (handle != IntPtr.Zero) CloseHandle(handle); }
 static void Free(IntPtr memory) { if (memory != IntPtr.Zero) Marshal.FreeHGlobal(memory); }
 static string Decode(string value) { return Encoding.UTF8.GetString(Convert.FromBase64String(value)); }
 static string JobName(string id) { return "Global\\Rigup.Process." + Guid.Parse(id).ToString(); }
 static uint ActiveCount(IntPtr job) {
  Accounting info;
  Check(QueryInformationJobObject(job, 1, out info, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
  return info.Active;
 }
 static bool HasDescendants(IntPtr job, int root) {
  // The root handle can become signaled before its job accounting updates.
  // Compare member identities so one remaining descendant is never ignored.
  int capacity = 16;
  while (capacity <= 1048576) {
   int size = 8 + capacity * IntPtr.Size;
   IntPtr list = Marshal.AllocHGlobal(size);
   try {
    bool complete = QueryJobList(job, 3, list, size, IntPtr.Zero);
    int error = Marshal.GetLastWin32Error();
    if (!complete && error != 234) throw new Win32Exception(error);
    int assigned = Marshal.ReadInt32(list, 0), included = Marshal.ReadInt32(list, 4);
    if (assigned < 0 || included < 0 || included > capacity) throw new InvalidOperationException();
    for (int i = 0; i < included; i++) {
     if (Marshal.ReadIntPtr(list, 8 + i * IntPtr.Size).ToInt64() != (uint)root) return true;
    }
    if (complete && included == assigned) return false;
    capacity = Math.Max(capacity * 2, assigned);
   } finally { Free(list); }
  }
  throw new InvalidOperationException();
 }
 static bool HasLingeringDescendants(IntPtr job, int root, WaitHandle disconnected) {
  // Console helpers and npm subprocesses can still be exiting when their
  // parent signals. Give them a bounded interval before treating them as leaks.
  var wait = Stopwatch.StartNew();
  while (HasDescendants(job, root)) {
   if (disconnected.WaitOne(20)) return false;
   if (wait.ElapsedMilliseconds >= 500) return true;
  }
  return false;
 }
 public static bool Active(string id) {
  IntPtr job = OpenJobObject(4, false, JobName(id));
  if (job == IntPtr.Zero) {
   int error = Marshal.GetLastWin32Error();
   if (error == 2) return false;
   throw new Win32Exception(error);
  }
  try { return ActiveCount(job) != 0; } finally { Close(job); }
 }
 static void Stop(IntPtr job) {
  if (ActiveCount(job) == 0) return;
  Check(TerminateJobObject(job, 1));
  var wait = Stopwatch.StartNew();
  while (ActiveCount(job) != 0) {
   if (wait.ElapsedMilliseconds >= 5000) throw new TimeoutException();
   Thread.Sleep(20);
  }
 }
 static IntPtr DuplicateStd(int id) {
  IntPtr process = GetCurrentProcess(), copy;
  Check(DuplicateHandle(process, GetStdHandle(id), process, out copy, 0, true, 2));
  return copy;
 }
 static void Attribute(IntPtr list, int key, IntPtr values, params IntPtr[] handles) {
  Marshal.Copy(handles, 0, values, handles.Length);
  Check(UpdateProcThreadAttribute(list, 0, (IntPtr)key, values, (IntPtr)(handles.Length * IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
 }

 public static int Run(string line) {
  var args = line.Split('\t');
  if (args.Length != 6) return Unavailable;
  string executable = Decode(args[1]), command = Decode(args[2]), cwd = Decode(args[3]);
  byte[] input = Convert.FromBase64String(args[5]);
  IntPtr job = IntPtr.Zero, list = IntPtr.Zero, jobs = IntPtr.Zero, inherited = IntPtr.Zero, env = IntPtr.Zero;
  IntPtr read = IntPtr.Zero, write = IntPtr.Zero, output = IntPtr.Zero, error = IntPtr.Zero;
  var process = new ProcessInfo();
  bool initialized = false;
  using (var disconnected = new ManualResetEvent(false)) {
   var monitor = new Thread(() => {
    try { Console.In.Read(); } catch (System.IO.IOException) { }
    try { disconnected.Set(); } catch (ObjectDisposedException) { }
   });
   monitor.IsBackground = true;
   monitor.Start();
   try {
    job = CreateJobObject(IntPtr.Zero, JobName(args[0]));
    int createError = Marshal.GetLastWin32Error();
    if (job == IntPtr.Zero || createError == 183) return Unavailable;
    var limits = new ExtendedLimits();
    limits.Basic.Flags = KillOnClose;
    Check(SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(ExtendedLimits))));

    var security = new Security { Size = Marshal.SizeOf(typeof(Security)), Inherit = 1 };
    Check(CreatePipe(out read, out write, ref security, 0));
    output = DuplicateStd(-11);
    error = DuplicateStd(-12);
    IntPtr size = IntPtr.Zero;
    InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
    list = Marshal.AllocHGlobal(size);
    Check(InitializeProcThreadAttributeList(list, 2, 0, ref size));
    initialized = true;
    jobs = Marshal.AllocHGlobal(IntPtr.Size);
    inherited = Marshal.AllocHGlobal(3 * IntPtr.Size);
    Attribute(list, 0x2000d, jobs, job);
    Attribute(list, 0x20002, inherited, read, output, error);
    env = Marshal.StringToHGlobalUni(Decode(args[4]));
    var startup = new StartupEx { Attributes = list, Startup = new Startup {
     Size = Marshal.SizeOf(typeof(StartupEx)), Flags = 0x100, Input = read, Output = output, Error = error
    }};
    if (disconnected.WaitOne(0)) return Unavailable;
    Check(CreateProcess(executable, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero, true,
     Suspended | UnicodeEnvironment | ExtendedStartup | NoWindow, env, cwd, ref startup, out process));
    Close(read); read = IntPtr.Zero;
    if (disconnected.WaitOne(0)) { Stop(job); return 1; }
    Check(ResumeThread(process.Thread) != Infinite);

    IntPtr stdin = write;
    var feed = new Thread(() => {
     try { int written; if (input.Length != 0) WriteFile(stdin, input, input.Length, out written, IntPtr.Zero); }
     finally { Close(stdin); }
    });
    feed.IsBackground = true;
    feed.Start();
    write = IntPtr.Zero;

    uint state = WaitForMultipleObjects(2, new[] { process.Process, disconnected.SafeWaitHandle.DangerousGetHandle() }, false, Infinite);
    Check(state == 0 || state == 1);
    uint code = 1;
    if (state == 0) Check(GetExitCodeProcess(process.Process, out code));
    bool leftChildren = state == 0 && HasLingeringDescendants(job, process.ProcessId, disconnected);
    Stop(job);
    if (leftChildren) return Remaining;
    if (code >= Unavailable && code <= 0x20000004) return 1;
    return unchecked((int)code);
   } catch (Exception) {
    if (process.Process != IntPtr.Zero) {
     try { Stop(job); } catch (Exception) { return Unconfirmed; }
    }
    return Unavailable;
   } finally {
    Close(job); Close(process.Thread); Close(process.Process);
    Close(read); Close(write); Close(output); Close(error);
    if (initialized) DeleteProcThreadAttributeList(list);
    Free(list); Free(jobs); Free(inherited); Free(env);
   }
  }
 }
}
`;

const worker=Buffer.from(String.raw`
$ErrorActionPreference = 'Stop'
try {
 $query = $env:RIGUP_QUERY_JOB
 if (-not $query) {
  $line = [Console]::ReadLine()
  if ($null -eq $line) { exit 0 }
 }
 Microsoft.PowerShell.Utility\Add-Type -TypeDefinition @'
${native}
'@
 if ($query) {
  if ([RigupWindowsJob]::Active($query)) { exit ${active} }
  exit 0
 }
 exit ([RigupWindowsJob]::Run($line))
} catch {
 [Console]::Error.WriteLine($_.Exception.GetType().Name)
 exit ${unavailable}
}
`,'utf16le').toString('base64');

export function windowsPowerShellExecutable(){
 const root=process.env.SystemRoot;
 if(!root||!/^[a-z]:[\\/]/i.test(root))throw Error('Windows system directory unavailable');
 return path.join(root,'System32','WindowsPowerShell','v1.0','powershell.exe');
}

function supervisorOptions(query){
 const executable=windowsPowerShellExecutable();
 const cwd=path.dirname(executable);
 const env={...process.env,PSModulePath:path.join(cwd,'Modules'),RIGUP_QUERY_JOB:query};
 return {executable,args:['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',worker],cwd,env};
}

/** @param {string} command @param {string} cwd @param {NodeJS.ProcessEnv} env */
export function resolveWindowsExecutable(command,cwd,env){
 const executable=path.extname(command)?command:command+'.exe';
 if(path.extname(executable).toLowerCase()!=='.exe')throw Error('A native Windows executable is required');
 const pathKey=Object.keys(env).sort().find(key=>key.toLowerCase()==='path'&&env[key]!==undefined);
 const search=path.isAbsolute(executable)||executable.includes('\\')||executable.includes('/')
  ?[path.resolve(cwd,executable)]
  :(pathKey?env[pathKey]:'').split(';').filter(Boolean)
    .map(dir=>path.resolve(cwd,dir.replace(/^"|"$/g,''),executable));
 for(const candidate of search)if(statSync(candidate,{throwIfNoEntry:false})?.isFile())return candidate;
 throw Error('Windows executable unavailable in the selected environment');
}

function quoteArgument(value){
 if(typeof value!=='string'||value.includes('\0'))throw Error('Invalid Windows argument');
 return '"'+value.replace(/(\\*)"/g,(_,slashes)=>slashes+slashes+'\\"').replace(/\\+$/,slashes=>slashes+slashes)+'"';
}

function environmentBlock(env){
 const entries=new Map();
 for(const key of Object.keys(env).sort()){
  const normalized=key.toUpperCase(),value=env[key];
  if(value===undefined||entries.has(normalized))continue;
  if(!key||/[=\0]/.test(key)||String(value).includes('\0'))throw Error('Invalid Windows environment');
  entries.set(normalized,key+'='+value);
 }
 return [...entries.keys()].sort().map(key=>entries.get(key)).join('\0')+'\0\0';
}

/** @param {{executable:string,args:string[],cwd:string,env?:NodeJS.ProcessEnv,captureOutput?:boolean}} spec */
export function startWindowsProcess({executable,args,cwd,env=process.env,captureOutput=true}){
 if(process.platform!=='win32'||!path.isAbsolute(cwd))throw Error('Windows process supervision unavailable');
 executable=resolveWindowsExecutable(executable,cwd,env);
 const command=[executable,...args].map(quoteArgument).join(' ');
 if(command.length>=32767)throw Error('Windows command line is too long');
 const job=randomUUID(),block=environmentBlock(env);
 const supervisor=supervisorOptions(undefined);
 const child=spawn(supervisor.executable,supervisor.args,{cwd:supervisor.cwd,env:supervisor.env,windowsHide:true,
  stdio:['pipe',captureOutput?'pipe':'ignore',captureOutput?'pipe':'ignore']});
 let started=false,interrupted=false,closed=false,failed=false,force;
 const completed=new Promise(resolve=>{
  child.once('error',()=>{failed=true;});
  child.once('close',code=>{
   closed=true;
   clearTimeout(force);
   resolve({code:code===remaining?1:code,unavailable:failed||code===unavailable||code===unconfirmed,
    remaining:code===remaining||code===unconfirmed||code===null,interrupted});
  });
 });
 /** @type {Promise<{code:number|null,unavailable:boolean,remaining:boolean,interrupted:boolean}>} */
 const result=completed;
 const stop=()=>{
  if(closed||interrupted)return;
  interrupted=true;
  child.stdin.end();
  force=setTimeout(()=>{
   child.kill();
   child.stdout?.destroy();
   child.stderr?.destroy();
  },7000);
 };
 child.stdin.on('error',()=>{failed=true;stop();});
 return {pid:child.pid,job,stdout:child.stdout,stderr:child.stderr,completed:result,stop,start(input=''){
  if(started||interrupted||closed)throw Error('Windows process authorization is no longer available');
  started=true;
  child.stdin.write([job,...[executable,command,cwd,block,input].map(value=>Buffer.from(value,'utf8').toString('base64'))].join('\t')+'\n');
 }};
}

/** @param {string} id */
export async function windowsJobActive(id){
 if(typeof id!=='string'||!jobPattern.test(id))throw Error('Windows job identity cannot be confirmed');
 const {executable,args,cwd,env}=supervisorOptions(id);
 try{await exec(executable,args,{cwd,env,windowsHide:true,timeout:15000,maxBuffer:4096});return false;}
 catch(error){if(error.code===active)return true;throw Error('Windows job exit cannot be confirmed',{cause:error});}
}
