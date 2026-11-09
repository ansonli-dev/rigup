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

function New-AclDenial([string]$candidate, [string]$reason, [string]$principal = '') {
 return @{status = 'denied'; path = $candidate; reason = $reason; principal = $principal}
}

function Assert-SafeAcl($candidate, [bool]$isDirectory, [bool]$privateLeaf) {
 $attributes = [IO.File]::GetAttributes($candidate)
 if (($attributes -band [IO.FileAttributes]::ReparsePoint) -or
     ([bool]($attributes -band [IO.FileAttributes]::Directory) -ne $isDirectory)) {
  return (New-AclDenial $candidate 'unexpected-type')
 }
 $security = if ($isDirectory) { [IO.Directory]::GetAccessControl($candidate) }
             else { [IO.File]::GetAccessControl($candidate) }
 $descriptor = [Security.AccessControl.RawSecurityDescriptor]::new($security.GetSecurityDescriptorBinaryForm(), 0)
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
for ($parent = [IO.Directory]::GetParent($path); $null -ne $parent; $parent = $parent.Parent) {
 $ancestors.Push($parent.FullName)
}
foreach ($ancestor in $ancestors) {
 $denial = Assert-SafeAcl $ancestor $true $false
 if ($null -ne $denial) { return $denial }
}
if (-not $ancestorsOnly) { Assert-SafeAcl $path $directory $true }
`;

async function assertWindowsAcl(path:string,directory:boolean,ancestorsOnly:boolean,message:string):Promise<void>{
 const normalized=win32.resolve(path);
 const root=win32.parse(normalized).root;
 const unsafe=normalized.slice(root.length).split(win32.sep).some(part=>
  /[ .]$/.test(part)||part.includes(':')||/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:[. ]|$)/i.test(part));
 if(!/^[a-z]:\\$/i.test(root)||unsafe)throw new Error(message+': unsafe Windows path');
 try{await checkWindowsAccess(checkWindowsAcl,normalized,directory,ancestorsOnly);}
 catch(cause){
  const detail=cause instanceof WindowsAclCheckError?cause.message:'Windows ACL worker unavailable';
  throw new Error(`${message}: ${detail}`,{cause});
 }
}

export async function assertSafeWindowsAncestors(path:string,message:string):Promise<void>{
 if(process.platform==='win32')await assertWindowsAcl(path,true,true,message);
}

export async function assertPrivateAccess(path:string,stat:Stats,message:string):Promise<void>{
 if(process.platform==='win32')await assertWindowsAcl(path,stat.isDirectory(),false,message);
 else if(stat.mode&0o077)throw new Error(message);
}
