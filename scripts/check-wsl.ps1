param([string]$CheckoutRoot = (Resolve-Path "$PSScriptRoot/..").Path, [string]$EvidenceDirectory)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
if (-not $IsWindows -or [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') { throw 'This runner requires native x64 Windows with WSL2 available.' }
if (-not $EvidenceDirectory) { $EvidenceDirectory = Join-Path ([IO.Path]::GetTempPath()) ('rigup-wsl-evidence-' + [Guid]::NewGuid().ToString('N')) }
New-Item -ItemType Directory -Path $EvidenceDirectory -Force | Out-Null
$stage = Join-Path ([IO.Path]::GetTempPath()) ('rigup-wsl-' + [Guid]::NewGuid().ToString('N'))
$distribution = 'RigupVerification-' + [Guid]::NewGuid().ToString('N')
New-Item -ItemType Directory -Path $stage | Out-Null
$imported = $false
try {
  $rootfs = Join-Path $stage 'ubuntu-base-24.04.5-base-amd64.tar.gz'
  $node = Join-Path $stage 'node-v24.22.2-linux-x64.tar.gz'
  # Fixed hashes from Canonical SHA256SUMS and nodejs.org SHASUMS256.txt.
  Invoke-WebRequest 'https://cdimage.ubuntu.com/ubuntu-base/releases/24.04/release/ubuntu-base-24.04.5-base-amd64.tar.gz' -OutFile $rootfs
  if ((Get-FileHash $rootfs -Algorithm SHA256).Hash.ToLowerInvariant() -ne 'e77b6f10c2590cef872b33ee9f635a0e3fd1f57fb074c0e52b5c7f56147a0c86') { throw 'Ubuntu archive integrity mismatch' }
  Invoke-WebRequest 'https://nodejs.org/dist/v24.22.2/node-v24.22.2-linux-x64.tar.gz' -OutFile $node
  if ((Get-FileHash $node -Algorithm SHA256).Hash.ToLowerInvariant() -ne '361718c444e49af2ca5a110c83ba6a8901143f23ab285ebbef0341f391f482a9') { throw 'Node archive integrity mismatch' }
  $commit = (git -C $CheckoutRoot rev-parse HEAD).Trim()
  $sourceArchive = Join-Path $stage 'source.tar'
  git -C $CheckoutRoot archive --format=tar "--output=$sourceArchive" $commit
  wsl --version | Tee-Object -FilePath (Join-Path $EvidenceDirectory 'wsl-version.txt')
  wsl --import $distribution (Join-Path $stage 'distro') $rootfs --version 2
  $imported = $true
  $version = ((wsl --list --verbose) -join "`n") -replace "`0", ''
  $ownVersion = ($version -split "`n" | Where-Object { $_ -match [regex]::Escape($distribution) }) -join "`n"
  if ($ownVersion -notmatch '\s2\s*$') { throw 'The imported distribution is not WSL2' }
  $ownVersion | Set-Content (Join-Path $EvidenceDirectory 'distribution-version.txt')
  $kernel = (wsl -d $distribution -u root --exec uname -r).Trim()
  if ($kernel -notmatch '(?i)microsoft.*WSL2') { throw 'The running kernel is not WSL2' }
  $stageLinux = (wsl -d $distribution -u root --exec wslpath -u $stage).Trim()
  $evidenceLinux = (wsl -d $distribution -u root --exec wslpath -u $EvidenceDirectory).Trim()
  New-Item -ItemType Directory -Path (Join-Path $stage 'fixtures') | Out-Null
  $setup = @'
set -eu
stage=$1
evidence=$2
commit=$3
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends ca-certificates git procps
mkdir -p /opt/rigup-node /root/rigup-source
tar -xzf "$stage/node-v24.22.2-linux-x64.tar.gz" -C /opt/rigup-node --strip-components=1
export PATH=/opt/rigup-node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
tar -xf "$stage/source.tar" -C /root/rigup-source
cd /root/rigup-source
npm ci
npm run build
export RIGUP_SOURCE_COMMIT="$commit"
node scripts/check-wsl.mjs "$stage/fixtures" "$evidence/result.json"
'@
  [IO.File]::WriteAllText((Join-Path $stage 'setup.sh'), $setup.Replace("`r`n", "`n") + "`n", [Text.UTF8Encoding]::new($false))
  wsl -d $distribution -u root --exec bash "$stageLinux/setup.sh" $stageLinux $evidenceLinux $commit
  $result = Get-Content (Join-Path $EvidenceDirectory 'result.json') -Raw | ConvertFrom-Json
  if ($result.error -or -not $result.cleanup -or $result.cases.Count -ne 7 -or ($result.cases | Where-Object status -ne 'passed')) { throw 'WSL2 verification is incomplete' }
} finally {
  if ($imported) { wsl --unregister $distribution }
  Remove-Item -LiteralPath $stage -Recurse -Force
}
