param(
  [Parameter(Mandatory=$true)][ValidateSet('Suspend','Resume')][string]$Mode,
  [Parameter(Mandatory=$true)][ValidateRange(1,2147483647)][int]$ProcessNumber,
  [Parameter(Mandatory=$true)][string]$CreationTime100ns
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class NozeliObservationWindow {
  [DllImport("kernel32.dll",SetLastError=true)] public static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
  [DllImport("kernel32.dll",SetLastError=true)] public static extern bool GetProcessTimes(IntPtr process,out ulong created,out ulong exited,out ulong kernel,out ulong user);
  [DllImport("kernel32.dll",SetLastError=true)] public static extern bool QueryFullProcessImageName(IntPtr process,uint flags,StringBuilder image,ref uint size);
  [DllImport("kernel32.dll")] public static extern uint WaitForSingleObject(IntPtr process,uint timeout);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
  [DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr process);
  [DllImport("ntdll.dll")] public static extern int NtResumeProcess(IntPtr process);
}
'@
# Only the exact, still-running synthetic supervisor incarnation and image
# beside this checkout/package's native fixture can be paused by this harness.
$heldProcess = [NozeliObservationWindow]::OpenProcess(0x101800,$false,$ProcessNumber)
if ($heldProcess -eq [IntPtr]::Zero) { throw 'Cannot retain original fixture supervisor' }
try {
  [uint64]$created = 0; [uint64]$exited = 0; [uint64]$kernel = 0; [uint64]$user = 0
  if (-not [NozeliObservationWindow]::GetProcessTimes($heldProcess,[ref]$created,[ref]$exited,[ref]$kernel,[ref]$user)) { throw 'Cannot stamp original fixture supervisor' }
  $image = New-Object System.Text.StringBuilder 32768
  [uint32]$size = 32768
  if (-not [NozeliObservationWindow]::QueryFullProcessImageName($heldProcess,0,$image,[ref]$size)) { throw 'Cannot verify fixture image' }
  $expectedImage = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../native/windows-process/build/Release/nozeli_windows_supervisor.exe'))
  if ($created.ToString([Globalization.CultureInfo]::InvariantCulture) -ne $CreationTime100ns -or
      -not [string]::Equals($image.ToString(),$expectedImage,[StringComparison]::OrdinalIgnoreCase) -or
      [NozeliObservationWindow]::WaitForSingleObject($heldProcess,0) -ne 258) { throw 'Fixture process incarnation or image changed' }
  $status = if ($Mode -eq 'Suspend') { [NozeliObservationWindow]::NtSuspendProcess($heldProcess) } else { [NozeliObservationWindow]::NtResumeProcess($heldProcess) }
  if ($status -ne 0) { throw "Fixture observation window failed: $status" }
  Write-Output '{"ok":true}'
} finally {
  [void][NozeliObservationWindow]::CloseHandle($heldProcess)
}
