import type {Stats} from 'node:fs';
import {win32} from 'node:path';
import {checkWindowsAccess,WindowsAclCheckError} from './windows-acl-worker.js';

const checkWindowsAcl = String.raw`
$user = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$trusted = @(
 $user,
 'S-1-5-18',
 'S-1-5-32-544',
 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
)
# Generic write/all, ACL/owner changes, deletion and reparse-point writes.
$replacementRights = 0x500d0142

# System.IO can reject extended paths in Windows PowerShell 5.1, depending on
# the host's .NET path handling. Use Unicode Win32 APIs for filesystem access;
# keep the managed ACL types for in-memory construction and policy checks.
if (-not ('RigupNativeAcl' -as [type])) {
 Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class RigupNativeAcl {
 [StructLayout(LayoutKind.Sequential)]
 struct SecurityAttributes { public int Length; public IntPtr Descriptor; public int InheritHandle; }
 [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
 static extern uint GetFileAttributesW(string path);
 [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
 [return: MarshalAs(UnmanagedType.Bool)]
 static extern bool CreateDirectoryW(string path, ref SecurityAttributes attributes);
 [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
 static extern uint GetNamedSecurityInfoW(string path, int type, uint information, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl, out IntPtr descriptor);
 [DllImport("advapi32.dll", ExactSpelling = true)]
 static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
 [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
 static extern IntPtr LocalFree(IntPtr memory);
 public static uint Attributes(string path) {
  uint attributes = GetFileAttributesW(path);
  if (attributes == 0xFFFFFFFF) throw new Win32Exception(Marshal.GetLastWin32Error());
  return attributes;
 }
 public static byte[] Descriptor(string path) {
  IntPtr descriptor;
  // SE_FILE_OBJECT; OWNER | GROUP | DACL_SECURITY_INFORMATION. This API
  // returns its error code directly, not through GetLastError.
  uint status = GetNamedSecurityInfoW(path, 1, 7, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, out descriptor);
  if (status != 0) throw new Win32Exception((int)status);
  try {
   if (descriptor == IntPtr.Zero) throw new InvalidOperationException("Missing security descriptor");
   byte[] bytes = new byte[checked((int)GetSecurityDescriptorLength(descriptor))];
   Marshal.Copy(descriptor, bytes, 0, bytes.Length);
   return bytes;
  } finally {
   if (LocalFree(descriptor) != IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
  }
 }
 public static void CreateDirectory(string path, byte[] descriptor) {
  // Keep the self-relative descriptor alive through the synchronous native
  // call. SECURITY_ATTRIBUTES applies the protected DACL at creation.
  IntPtr memory = Marshal.AllocHGlobal(descriptor.Length);
  try {
   Marshal.Copy(descriptor, 0, memory, descriptor.Length);
   SecurityAttributes attributes = new SecurityAttributes();
   attributes.Length = Marshal.SizeOf(typeof(SecurityAttributes));
   attributes.Descriptor = memory;
   if (!CreateDirectoryW(path, ref attributes)) {
    int error = Marshal.GetLastWin32Error();
    // ERROR_ALREADY_EXISTS: leave it unchanged and validate it below.
    if (error != 183) throw new Win32Exception(error);
   }
  } finally { Marshal.FreeHGlobal(memory); }
 }
}
'@
}

function New-AclDenial([string]$candidate, [string]$reason, [string]$principal = '') {
 $denial = @{status = 'denied'; path = $candidate; reason = $reason; principal = $principal}
 if ($principal) {
  try {
   $denial.account = [Security.Principal.SecurityIdentifier]::new($principal).Translate([Security.Principal.NTAccount]).Value
  } catch { # Display the SID if the account cannot be resolved.
  }
 }
 return $denial
}

function Assert-SafeAcl($candidate, [bool]$isDirectory, [bool]$privateLeaf) {
 # Keep public paths unchanged; only the Win32 calls use the extended form.
 $ioPath = '\\?\' + $candidate
 $attributes = [IO.FileAttributes][RigupNativeAcl]::Attributes($ioPath)
 if (($attributes -band [IO.FileAttributes]::ReparsePoint) -or
     ([bool]($attributes -band [IO.FileAttributes]::Directory) -ne $isDirectory)) {
  return (New-AclDenial $candidate 'unexpected-type')
 }
 $descriptor = [Security.AccessControl.RawSecurityDescriptor]::new([RigupNativeAcl]::Descriptor($ioPath), 0)
 $owner = $descriptor.Owner.Value
 if ($owner -notin $trusted) {
  return (New-AclDenial $candidate 'untrusted-owner' $owner)
 }
 if ($null -eq $descriptor.DiscretionaryAcl) {
  return (New-AclDenial $candidate 'missing-dacl')
 }

 $userAccess = $false
 $inheritedUserAccess = 0
 foreach ($ace in $descriptor.DiscretionaryAcl) {
  if ($ace.AceType -eq [Security.AccessControl.AceType]::AccessDenied) { continue }
  if ($ace.AceType -ne [Security.AccessControl.AceType]::AccessAllowed) {
   $principal = if ($ace -is [Security.AccessControl.KnownAce]) { $ace.SecurityIdentifier.Value }
   return (New-AclDenial $candidate 'unsupported-rule' $principal)
  }
  $inheritOnly = [int]$ace.AceFlags -band [int][Security.AccessControl.AceFlags]::InheritOnly
  $principal = $ace.SecurityIdentifier.Value
  if ($principal -notin $trusted -and ($privateLeaf -or
      (-not $inheritOnly -and ($ace.AccessMask -band $replacementRights)))) {
   return (New-AclDenial $candidate 'untrusted-grant' $principal)
  }
  if ($principal -eq $user) {
   if (-not $inheritOnly) { $userAccess = $true }
   if ([int]$ace.AceFlags -band [int][Security.AccessControl.AceFlags]::ObjectInherit) {
    $inheritedUserAccess = $inheritedUserAccess -bor $ace.AccessMask
   }
  }
 }

 if ($privateLeaf -and -not $userAccess) { return (New-AclDenial $candidate 'missing-user-access' $user) }
 if ($privateLeaf -and $isDirectory) {
  # Map generic access to the file rights needed to read and write private records.
  if ($inheritedUserAccess -band 0x10000000) { $inheritedUserAccess = $inheritedUserAccess -bor 0x12019f }
  if ($inheritedUserAccess -band [int]::MinValue) { $inheritedUserAccess = $inheritedUserAccess -bor 0x120089 }
  if ($inheritedUserAccess -band 0x40000000) { $inheritedUserAccess = $inheritedUserAccess -bor 0x120116 }
  if (($inheritedUserAccess -band 0x12019f) -ne 0x12019f) {
   return (New-AclDenial $candidate 'missing-inherited-access' $user)
  }
 }
}

# Verify the path from the root downward so an untrusted ancestor cannot move a checked child.
$ancestors = [Collections.Generic.Stack[string]]::new()
# Walk validated drive-path separators without .NET's legacy path normalization.
for ($parent = $path; $parent.Length -gt 3;) {
 $parent = $parent.Substring(0, [Math]::Max(3, $parent.LastIndexOf('\')))
 $ancestors.Push($parent)
}
foreach ($ancestor in $ancestors) {
 $denial = Assert-SafeAcl $ancestor $true $false
 if ($null -ne $denial) { return $denial }
}
if ($create) {
 $acl = [Security.AccessControl.DirectorySecurity]::new()
 $acl.SetAccessRuleProtection($true, $false)
 foreach ($id in $trusted[0..2]) {
  $rule = [Security.AccessControl.FileSystemAccessRule]::new(
   [Security.Principal.SecurityIdentifier]::new($id), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $acl.AddAccessRule($rule)
 }
 # Apply the protected DACL at creation. An existing directory keeps its ACL.
 [RigupNativeAcl]::CreateDirectory(('\\?\' + $path), $acl.GetSecurityDescriptorBinaryForm())
}
if (-not $ancestorsOnly) { Assert-SafeAcl $path $directory $true }
`;

async function assertWindowsAcl(path:string,directory:boolean,ancestorsOnly:boolean,message:string,create=false):Promise<void>{
 const normalized=win32.resolve(path);
 const root=win32.parse(normalized).root;
 const unsafe=normalized.slice(root.length).split(win32.sep).some(part=>
  /[ .]$/.test(part)||/[<>:"|?*\u0000-\u001f]/.test(part)||/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:[. ]|$)/i.test(part));
 if(!/^[a-z]:\\$/i.test(root)||unsafe)throw new Error(message+': unsafe Windows path');
 try{await checkWindowsAccess(checkWindowsAcl,normalized,directory,ancestorsOnly,create);}
 catch(cause){
  const detail=cause instanceof WindowsAclCheckError?cause.message:'Windows ACL worker unavailable';
  throw new Error(`${message}: ${detail}`,{cause});
 }
}

export async function assertSafeWindowsAncestors(path:string,message:string):Promise<void>{
 if(process.platform==='win32')await assertWindowsAcl(path,true,true,message);
}

export async function createWindowsPrivateDirectory(path:string,message:string):Promise<void>{
 await assertWindowsAcl(path,true,false,message,true);
}

export async function assertPrivateAccess(path:string,stat:Stats,message:string):Promise<void>{
 if(process.platform==='win32')await assertWindowsAcl(path,stat.isDirectory(),false,message);
 else if(stat.mode&0o077)throw new Error(message);
}
