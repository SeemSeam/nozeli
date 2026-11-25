# Project-specific Windows development entry. No global environment mutations.
[CmdletBinding(PositionalBinding = $false)]
param(
    [string]$Workspace,
    [string]$CacheRoot,
    [string]$Executable,
    [string[]]$CommandArguments = @('--version')
)
$ErrorActionPreference = 'Stop'
if (-not $Workspace) { $Workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..')) }
$repo = (Resolve-Path -LiteralPath $Workspace).Path
$workspaceRoot = Split-Path -Parent $repo
if (-not $CacheRoot) { $CacheRoot = Join-Path ([IO.Path]::GetPathRoot($repo)) 'dev-cache' }
$nodeDirectory = Join-Path $workspaceRoot '.tools\node-v22.23.4-win-x64'
if (-not $Executable) { $Executable = Join-Path $nodeDirectory 'node.exe' }
$resolvedExecutable = (Resolve-Path -LiteralPath $Executable).Path
if ([IO.Path]::GetExtension($resolvedExecutable) -notin @('.exe', '.cmd')) {
    throw 'Executable must be an explicit .exe or .cmd. Pass JavaScript paths through -CommandArguments, not -Executable.'
}
$environmentPaths = @{
    TEMP = (Join-Path $CacheRoot 'temp')
    TMP = (Join-Path $CacheRoot 'temp')
    NPM_CONFIG_CACHE = (Join-Path $CacheRoot 'npm')
    ELECTRON_CACHE = (Join-Path $CacheRoot 'electron')
    ELECTRON_BUILDER_CACHE = (Join-Path $CacheRoot 'electron-builder')
    PLAYWRIGHT_BROWSERS_PATH = (Join-Path $CacheRoot 'playwright')
    npm_config_devdir = (Join-Path $CacheRoot 'node-gyp')
    NOZELI_TEST_OUTPUT_ROOT = (Join-Path (Split-Path -Parent $workspaceRoot) 'nozeli-test')
}
$previous = @{}
try {
    foreach ($entry in $environmentPaths.GetEnumerator()) {
        $previous[$entry.Key] = [Environment]::GetEnvironmentVariable($entry.Key, 'Process')
        New-Item -ItemType Directory -Path $entry.Value -Force | Out-Null
        [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process')
    }
    $previous['PATH'] = $env:PATH
    $env:PATH = "$nodeDirectory;$env:PATH"
    & $resolvedExecutable @CommandArguments
    $result = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 0 }
}
finally {
    foreach ($entry in $previous.GetEnumerator()) {
        [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process')
    }
}
exit $result
