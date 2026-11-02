# memHub installer: wire every AI tool on this machine into the shared brain.
# PowerShell 5.1 compatible. Idempotent: safe to re-run.
#
# Usage:
#   .\install.ps1                       # auto-detect repo root, wire everything
#   .\install.ps1 -RepoPath <path>      # explicit memHub checkout
#   .\install.ps1 -SkipCodex            # tools: -SkipCodex, -SkipCursor, -SkipOpenCode, -SkipClaude
param(
  [string]$RepoPath = "",
  [switch]$SkipClaude,
  [switch]$SkipCodex,
  [switch]$SkipCursor,
  [switch]$SkipOpCode
)

$ErrorActionPreference = 'Stop'

if (-not $RepoPath) {
  # repo root = this script's grandparent is repo root (script lives in repo root)
  $RepoPath = $PSScriptRoot
}
$RepoPath = (Resolve-Path $RepoPath).Path
$Mcp = Join-Path $RepoPath 'server\src\mcp.js'
if (-not (Test-Path $Mcp)) { throw "memHub checkout not found at $RepoPath (missing server\src\mcp.js)" }

function JsonReplace($file, $script) {
  if (Test-Path $file) {
    $json = Get-Content $file -Raw | ConvertFrom-Json
  } else {
    $json = [PSCustomObject]@{}
  }
  & $script $json | Out-Null
  $dir = Split-Path $file -Parent
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $json | ConvertTo-Json -Depth 32 | Set-Content -Path $file -Encoding UTF8
}

Write-Host "memHub at $RepoPath"

# ---------- Claude Code (plugin marketplace) ----------
if (-not $SkipClaude) {
  Write-Host "=> Claude Code: adding plugin marketplace"
  try {
    $null = (& claude plugin marketplace add DailyDoseOfStuff/memHub 2>&1)
    if ($LASTEXITCODE -ne 0) { Write-Host "   marketplace add failed ($LASTEXITCODE), falling back to plain MCP wiring" }
  } catch { Write-Host "   marketplace add failed: $($_.Exception.Message)" }
  if ($LASTEXITCODE -eq 0) {
    try { $null = (& claude plugin install "memhub@memhub-marketplace" 2>&1); Write-Host "   plugin installed ($LASTEXITCODE)" } catch { Write-Host "   plugin install failed: $($_.Exception.Message)" }
  }
  if ($LASTEXITCODE -ne 0) {
    Write-Host "   fallback: plain MCP registration"
    try { $null = (& claude mcp add memHub -- node $Mcp 2>&1) } catch {}
  }
}

# ---------- OpenAI Codex CLI (~/.codex/config.toml) ----------
if (-not $SkipCodex) {
  $cfg = "$env:USERPROFILE\.codex\config.toml"
  Write-Host "=> Codex: $cfg"
  $block = @"
[mcp_servers.memhub]
command = "node"
args = ["$Mcp"]
"@
  $toml = if (Test-Path $cfg) { Get-Content $cfg -Raw } else { '' }
  # drop any previous memhub block, then append the fresh one
  $toml = ($toml -replace '(?ms)\[mcp_servers\.memhub\].*?(?=\r?\n\[|\z)', '').TrimEnd()
  if ($toml) { $toml = $toml + "`r`n`r`n" + $block } else { $toml = $block }
  New-Item -ItemType Directory -Path (Split-Path $cfg -Parent) -Force | Out-Null
  Set-Content -Path $cfg -Value $toml -Encoding ASCII
}

# ---------- Cursor (~/.cursor/mcp.json) ----------
if (-not $SkipCursor) {
  $f = "$env:USERPROFILE\.cursor\mcp.json"
  Write-Host "=> Cursor: $f"
  JsonReplace $f { param($json)
    if (-not $json.mcpServers) { $json | Add-Member -NotePropertyName mcpServers -NotePropertyValue ([PSCustomObject]@{}) }
    if (-not $json.mcpServers.memhub) { $json.mcpServers | Add-Member -NotePropertyName memhub -NotePropertyValue ([PSCustomObject]@{}) }
    $json.mcpServers.memhub.command = 'node'
    $json.mcpServers.memhub.args = @($Mcp)
  }
}

# ---------- opencode (~/.config/opencode/opencode.json) ----------
if (-not $SkipOpCode) {
  $f = "$env:USERPROFILE\.config\opencode\opencode.json"
  Write-Host "=> opencode: $f"
  JsonReplace $f { param($json)
    if (-not $json.mcp) { $json | Add-Member -NotePropertyName mcp -NotePropertyValue ([PSCustomObject]@{}) }
    if (-not $json.mcp.memhub) { $json.mcp | Add-Member -NotePropertyName memhub -NotePropertyValue ([PSCustomObject]@{}) }
    $json.mcp.memhub.type = 'local'
    $json.mcp.memhub.enabled = $true
    if (-not $json.mcp.memhub.command) { $json.mcp.memhub | Add-Member -NotePropertyName command -NotePropertyValue ([PSCustomObject]@{}) }
    $json.mcp.memhub.command.command = 'node'
    $json.mcp.memhub.command.args = @($Mcp)
  }
}

Write-Host "`nDone. Every wired tool now shares the same memory graph."
Write-Host "Universe UI:  cd '$RepoPath'; docker compose up -d   (or npm start)"
Write-Host "Health check: http://127.0.0.1:4777/api/health"
