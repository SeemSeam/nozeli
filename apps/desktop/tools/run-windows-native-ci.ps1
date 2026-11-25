# Hosted runner entry for the native qualification job. Not a product launcher.
[CmdletBinding()]
param(
    [switch] $AsTestUser,
    [string] $NodePath,
    [string] $GitPath,
    [string] $FixtureTemp,
    [string] $ExpectedSid
)
$ErrorActionPreference = 'Stop'

if ($AsTestUser) {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if ($identity.User.Value -ne $ExpectedSid -or $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Windows native qualification did not start under the dedicated standard user.'
    }
    $env:PATH = "$(Split-Path -Parent $NodePath);$(Split-Path -Parent $GitPath);$env:PATH"
    $env:TEMP = $env:TMP = $FixtureTemp
    & $NodePath tools/test-suites.mjs windows-native
    exit $LASTEXITCODE
}

if (-not $env:RUNNER_TEMP) { throw 'This launcher requires a disposable Windows CI runner.' }
$app = Split-Path -Parent $PSScriptRoot
$NodePath = (Get-Command node.exe -CommandType Application).Source
$GitPath = (Get-Command git.exe -CommandType Application).Source
# Cache the locked Electron binary before granting the test account read/execute access.
& $NodePath -e 'require("electron")'
if ($LASTEXITCODE -ne 0) { throw "Electron setup failed (exit $LASTEXITCODE)." }

$suffix = [guid]::NewGuid().ToString('N').Substring(0, 10)
$name = "nzl-$suffix"
$FixtureTemp = Join-Path $env:RUNNER_TEMP $name
$output = Join-Path $app '.test-output'
$null = New-Item -ItemType Directory -Path $FixtureTemp, $output -Force
$password = ConvertTo-SecureString ("a1!A" + [guid]::NewGuid().ToString('N')) -AsPlainText -Force
$user = New-LocalUser -Name $name -Password $password
try {
    $usersGroup = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')
    if (-not (Get-LocalGroupMember -SID $usersGroup | Where-Object SID -EQ $user.SID)) {
        Add-LocalGroupMember -SID $usersGroup -Member $user
    }
    $sid = $user.SID.Value
    # Grant only the test SID access to CI inputs and scratch space. Native
    # private directories still protect their own DACL and never inherit this.
    & icacls.exe $app /grant "*${sid}:(OI)(CI)(RX)"
    if ($LASTEXITCODE -ne 0) { throw 'Cannot grant access to the CI test inputs.' }
    foreach ($directory in @($FixtureTemp, $output)) {
        & icacls.exe $directory /grant "*${sid}:(OI)(CI)(M)"
        if ($LASTEXITCODE -ne 0) { throw "Cannot grant access to CI scratch: $directory" }
    }
    $credential = [pscredential]::new("$env:COMPUTERNAME\$name", $password)
    $stdout = Join-Path $FixtureTemp 'suite.out'
    $stderr = Join-Path $FixtureTemp 'suite.err'
    $arguments = "-NoProfile -NonInteractive -File `"$PSCommandPath`" -AsTestUser -NodePath `"$NodePath`" -GitPath `"$GitPath`" -FixtureTemp `"$FixtureTemp`" -ExpectedSid $sid"
    $run = Start-Process -FilePath (Join-Path $PSHOME 'pwsh.exe') -ArgumentList $arguments `
        -Credential $credential -LoadUserProfile -UseNewEnvironment -WorkingDirectory $app `
        -RedirectStandardOutput $stdout -RedirectStandardError $stderr -Wait -PassThru
    Get-Content -LiteralPath $stdout -Encoding utf8
    Get-Content -LiteralPath $stderr -Encoding utf8
    if ($run.ExitCode -ne 0) { throw "Windows native qualification failed (exit $($run.ExitCode))." }
} finally {
    Remove-LocalUser -SID $user.SID
}
