# sync_skills.ps1
# Mirror the canonical ui-ux-pro-max Skill directory to all provider copies.
# Canonical source: .claude/skills/ui-ux-pro-max  (edit ONLY there, then run this script)
# See CLAUDE.md section "Skill Canonical Source & Sync" for details.

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$skill = 'ui-ux-pro-max'
$canonical = Join-Path $root ".claude\skills\$skill"

if (-not (Test-Path $canonical)) {
    throw "Canonical source not found: $canonical"
}

# Providers sharing the canonical SKILL.md format -> full mirror (SKILL.md + data + scripts)
$fullSync = @(
    ".qoder\skills\$skill",
    ".codex\skills\$skill",
    ".trae\skills\$skill",
    ".codebuddy\skills\$skill",
    ".continue\skills\$skill",
    ".gemini\skills\$skill",
    ".opencode\skills\$skill"
)

# Providers with provider-adapted entry files -> mirror data + scripts only
$dataSync = @(
    ".agent\skills\$skill",
    ".cursor\skills\$skill",
    ".windsurf\skills\$skill",
    ".roo\skills\$skill",
    ".kiro\steering\$skill",
    ".github\prompts\$skill"
)

function Mirror-Dir($src, $dst) {
    robocopy $src $dst /MIR /NJH /NJS /NDL /NFL /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE): $src -> $dst" }
}

foreach ($rel in $fullSync) {
    $dest = Join-Path $root $rel
    if (-not (Test-Path $dest)) { Write-Warning "skip missing: $rel"; continue }
    Copy-Item (Join-Path $canonical 'SKILL.md') (Join-Path $dest 'SKILL.md') -Force
    Mirror-Dir (Join-Path $canonical 'data') (Join-Path $dest 'data')
    Mirror-Dir (Join-Path $canonical 'scripts') (Join-Path $dest 'scripts')
    Write-Output "full-sync : $rel"
}

foreach ($rel in $dataSync) {
    $dest = Join-Path $root $rel
    if (-not (Test-Path $dest)) { Write-Warning "skip missing: $rel"; continue }
    Mirror-Dir (Join-Path $canonical 'data') (Join-Path $dest 'data')
    Mirror-Dir (Join-Path $canonical 'scripts') (Join-Path $dest 'scripts')
    Write-Output "data-sync : $rel"
}

Write-Output "Done. Canonical: .claude\skills\$skill"
