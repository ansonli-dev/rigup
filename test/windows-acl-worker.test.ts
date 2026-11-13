import assert from 'node:assert/strict';
import {test} from 'node:test';
import {checkWindowsAccess} from '../src/windows-acl-worker.js';

test('Windows worker classifies wrapped Win32 errors and bounds sharing and lock retries',{
 skip:process.platform!=='win32'&&'requires Windows PowerShell',
},async()=>{
 // Invoke a C# method so PowerShell wraps the Win32Exception in the same way
 // as a failed native ACL call. Exercise the real worker catch/response loop.
 const check=String.raw`
if (-not ('RigupAclErrorFixture' -as [type])) {
 Add-Type -TypeDefinition @'
public static class RigupAclErrorFixture {
 public static void Fail(int code) { throw new System.ComponentModel.Win32Exception(code); }
}
'@
 $script:attempts = @{}
}
if (-not $script:attempts.ContainsKey($path)) { $script:attempts[$path] = 0 }
$script:attempts[$path]++
$parts = $path.Split('-')
if ($script:attempts[$path] -le [int]$parts[2]) { [RigupAclErrorFixture]::Fail([int]$parts[1]) }
`;
 const request=(path:string)=>checkWindowsAccess(check,path,false,false,false);
 for(const code of [32,33]){
  await request(`C:\\transient-${code}-3`);
  const persistent=`C:\\persistent-${code}-4`;
  await assert.rejects(request(persistent),/Windows ACL I\/O failed \(sharing or lock violation\)/);
  await request(persistent);
 }
 const denied='C:\\denied-5-1';
 await assert.rejects(request(denied),/Windows ACL I\/O failed checking/);
 await request(denied);
});
