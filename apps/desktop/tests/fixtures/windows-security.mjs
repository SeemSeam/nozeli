// Independent ordinary-user ACL inspection/mutation of synthetic fixtures only.
// Use the OS-bundled Windows PowerShell, not a product runtime dependency.
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';

export function security(action, file, {expectRefusal = false} = {}) {
  const script = `$ErrorActionPreference='Stop'
    $ProgressPreference='SilentlyContinue'
    $env:PSModulePath=[IO.Path]::Combine($PSHOME,'Modules')
    [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
    $file=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(file).toString('base64')}'))
    $action='${action}'
    $current=[Security.Principal.WindowsIdentity]::GetCurrent().User
    $everyone=[Security.Principal.SecurityIdentifier]::new('S-1-1-0')
    $isDirectory=[IO.Directory]::Exists($file)
    function Read-FixtureAcl {
      if($isDirectory){[IO.Directory]::GetAccessControl($file,[Security.AccessControl.AccessControlSections]'Owner,Group,Access')}
      else{[IO.File]::GetAccessControl($file,[Security.AccessControl.AccessControlSections]'Owner,Group,Access')}
    }
    function Write-FixtureAcl($descriptor) {
      if($isDirectory){[IO.Directory]::SetAccessControl($file,$descriptor)}
      else{[IO.File]::SetAccessControl($file,$descriptor)}
    }
    $acl=Read-FixtureAcl
    if($action -eq 'broad-parent') {
      $rule=[Security.AccessControl.FileSystemAccessRule]::new($everyone,'Modify','ContainerInherit,ObjectInherit','None','Allow')
      $acl.AddAccessRule($rule)
      Write-FixtureAcl $acl
    } elseif($action -eq 'protected-target') {
      $acl.SetAccessRuleProtection($true,$false)
      foreach($rule in @($acl.GetAccessRules($true,$false,[Security.Principal.SecurityIdentifier]))) {
        $acl.RemoveAccessRuleSpecific($rule)
      }
      $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($current,'FullControl','Allow'))
      $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($everyone,'Read','Allow'))
      Write-FixtureAcl $acl
    } elseif($action -eq 'add-write') {
      $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($everyone,'Write','Allow'))
      try {Write-FixtureAcl $acl}
      catch {
        if(-not ${expectRefusal ? '$true' : '$false'}){throw}
        $errorCode=$_.Exception.GetBaseException().HResult -band 65535
        @{refused=$true;error=$_.Exception.GetBaseException().Message;hresult=$errorCode} | ConvertTo-Json -Compress
        exit 0
      }
    } elseif($action -eq 'protect-user-file') {
      if($isDirectory){throw 'Synthetic user-file action requires a file'}
      $acl.SetAccessRuleProtection($true,$true)
      Write-FixtureAcl $acl
    } elseif($action -eq 'null-dacl') {
      $acl.SetSecurityDescriptorSddlForm('D:NO_ACCESS_CONTROL',[Security.AccessControl.AccessControlSections]::Access)
      Write-FixtureAcl $acl
    } elseif($action -ne 'inspect') {throw 'Unknown synthetic ACL action'}
    $acl=Read-FixtureAcl
    $rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | ForEach-Object {
      @{sid=$_.IdentityReference.Value;rights=[int]$_.FileSystemRights;type=[string]$_.AccessControlType;
        inherited=$_.IsInherited;inheritance=[int]$_.InheritanceFlags;propagation=[int]$_.PropagationFlags}
    })
    @{currentSid=$current.Value;owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value;
      group=$acl.GetGroup([Security.Principal.SecurityIdentifier]).Value;protected=$acl.AreAccessRulesProtected;
      sddl=$acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]'Owner,Group,Access');rules=$rules} | ConvertTo-Json -Depth 5 -Compress`;
  const child = spawnSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      encoding:'utf8', windowsHide:true, timeout:10000,
      // Scoped child env only: PowerShell scans PSModulePath during startup,
      // before the script's own reset can apply, so every cold start pays for
      // the inherited user-profile module scan unless it is pinned here.
      env: {...process.env, PSModulePath: path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/Modules')},
    });
  assert.ifError(child.error);
  assert.equal(child.signal, null);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, '');
  const result = JSON.parse(child.stdout.trim());
  if (expectRefusal) {
    assert.equal(result.refused, true, 'ACL update unexpectedly succeeded');
    assert.match(result.error, /\b(?:32|6800)\b/);
  }
  return result;
}
