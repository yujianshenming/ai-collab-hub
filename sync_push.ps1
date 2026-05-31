Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-AntigravityConfigPath {
    $userName = Split-Path -Leaf $env:USERPROFILE
    return Join-Path -Path "C:\Users\$userName" -ChildPath ".gemini\antigravity"
}

function Assert-AntigravityClosed {
    $processes = Get-Process | Where-Object {
        $_.ProcessName -match "(?i)antigravity|gemini" -or
        ($_.Path -and $_.Path -match "(?i)antigravity|gemini")
    }

    if ($processes) {
        $list = $processes | ForEach-Object { "$($_.ProcessName) (PID $($_.Id))" }
        throw "Antigravity/Gemini appears to be running. Close it before syncing:`n$($list -join "`n")"
    }
}

function Assert-GitRepository {
    param([string]$ConfigPath)

    if (-not (Test-Path -LiteralPath $ConfigPath)) {
        throw "Config path does not exist: $ConfigPath"
    }

    if (-not (Test-Path -LiteralPath (Join-Path $ConfigPath ".git"))) {
        throw "Config path is not initialized as a Git repository: $ConfigPath"
    }
}

$configPath = Get-AntigravityConfigPath
Assert-AntigravityClosed
Assert-GitRepository -ConfigPath $configPath

Write-Host "Preparing Antigravity config push from: $configPath"
git -C $configPath add .

$changes = git -C $configPath status --porcelain
if (-not $changes) {
    Write-Host "No Antigravity config changes to commit."
    exit 0
}

$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
git -C $configPath commit -m "Sync update: $timestamp"
git -C $configPath push origin master
Write-Host "Antigravity config push completed."
