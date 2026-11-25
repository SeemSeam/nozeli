[CmdletBinding()]
param([string]$EvidenceRoot)
$ErrorActionPreference='Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'This probe requires real Windows' }
if (-not $EvidenceRoot) { $EvidenceRoot=Join-Path $PSScriptRoot '..\.test-output\windows-native' }
$EvidenceRoot=[IO.Path]::GetFullPath($EvidenceRoot)
$runRoot=Join-Path $EvidenceRoot ('file-primitives-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $runRoot -ErrorAction Stop | Out-Null
$fixture=Join-Path $runRoot 'fixture'
New-Item -ItemType Directory -Path $fixture -ErrorAction Stop | Out-Null
Add-Type -Path (Join-Path $PSScriptRoot 'native\windows-file-primitives.cs')
$facts=[Nozeli.Diagnostics.WindowsFilePrimitives]::Run($fixture)
$json=$facts | ConvertTo-Json -Depth 10
[IO.File]::WriteAllText((Join-Path $runRoot 'facts.json'),$json+[Environment]::NewLine,[Text.UTF8Encoding]::new($false))
$json
# Intentionally retain the small, synthetic fixture with its evidence. Exit 0
# means the diagnostic ran; qualification fields remain explicitly unsupported.
