# MemHub CLI - thin PowerShell wrapper over the MemHub REST API.
# Windows PowerShell 5.1+ compatible. Base URL: http://127.0.0.1:4777 (override with MEMHUB_URL).

param(
  [Parameter(Position = 0)]
  [string]$Cmd,
  [Parameter(Position = 1, ValueFromRemainingArguments = $true)]
  [string[]]$Rest,
  [string]$Tags,
  [string]$Model,
  [string]$Parent,
  [string]$Type,
  [switch]$Help
)

$ErrorActionPreference = 'Stop'

$Base = 'http://127.0.0.1:4777'
if ($env:MEMHUB_URL) { $Base = $env:MEMHUB_URL.TrimEnd('/') }

function Show-Usage {
  @'
MemHub CLI - talks to the MemHub server at http://127.0.0.1:4777 (override with MEMHUB_URL).

Usage:
  memhub.ps1 notes <text> [-Tags a,b] [-Model name] [-Parent nodeId]
  memhub.ps1 find <query>
  memhub.ps1 node <nodeId>
  memhub.ps1 link <sourceId> <targetId> [-Type edgeType]
  memhub.ps1 add <type> <label>
  memhub.ps1 stats
  memhub.ps1 hops <nodeId> [depth]
  memhub.ps1 backup
  memhub.ps1 [-Help]

Node types: project, file, concept, person, decision, session, note.

Examples:
  .\memhub.ps1 notes "Chose SQLite over Postgres" -Model "claude-opus-4" -Tags decision,database
  .\memhub.ps1 add project "memhub"
  .\memhub.ps1 find "auth system"
  .\memhub.ps1 node concept:auth-system
  .\memhub.ps1 link project:memhub concept:auth-system -Type relates-to
  .\memhub.ps1 stats
  .\memhub.ps1 hops project:memhub 3
  .\memhub.ps1 backup
'@
}

function Show-HttpError([object]$Err, [string]$Url) {
  $detail = $Err.Exception.Message
  if ($Err.Exception.Response) {
    $code = [int]$Err.Exception.Response.StatusCode
    Write-Host ("MemHub request failed: " + $Url + " -> HTTP " + $code + " (" + $detail + ")") -ForegroundColor Yellow
  } else {
    Write-Host ("MemHub server not running at " + $Base + " — start it: npm start (in memhub/)  [" + $detail + "]") -ForegroundColor Yellow
  }
  exit 1
}

function ApiGet([string]$Path) {
  $url = $Base + $Path
  try {
    Invoke-RestMethod -Method Get -Uri $url
  } catch {
    Show-HttpError $_ $url
  }
}

function ApiPost([string]$Path, [object]$Body) {
  $url = $Base + $Path
  try {
    $json = ConvertTo-Json -InputObject $Body -Depth 6 -Compress
    Invoke-RestMethod -Method Post -Uri $url -ContentType 'application/json' -Body $json
  } catch {
    Show-HttpError $_ $url
  }
}

if ($Help -or -not $Cmd) { Show-Usage; exit 0 }

if ($null -eq $Rest) { $Rest = @() }

switch ($Cmd.ToLowerInvariant()) {

  'notes' {
    $text = $Rest[0]
    if (-not $text) { Show-Usage; exit 1 }
    $body = @{ text = $text }
    if ($Tags) { $body.tags = @($Tags -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }
    if ($Model) { $body.model = $Model }
    if ($Parent) { $body.parent = $Parent }
    $r = ApiPost '/api/notes' $body
    $n = $r.note
    Write-Host ("Note saved: " + $n.id)
    if ($n.parent) { Write-Host ("  parent: " + $n.parent) }
    if ($n.model) { Write-Host ("  model: " + $n.model) }
    if ($n.tags) { Write-Host ("  tags: " + ($n.tags -join ', ')) }
  }

  'find' {
    $q = $Rest[0]
    if (-not $q) { Show-Usage; exit 1 }
    $r = ApiGet ('/api/search?q=' + [System.Uri]::EscapeDataString($q))
    $hits = @()
    if ($r.results) { $hits = @($r.results) }
    if ($hits.Count -eq 0) { Write-Host 'No matches.'; exit 0 }
    foreach ($hit in $hits) {
      Write-Host ('{0,-8} {1}  [{2}]  {3}' -f $hit.score, $hit.label, $hit.type, $hit.id)
    }
  }

  'node' {
    $id = $Rest[0]
    if (-not $id) { Show-Usage; exit 1 }
    $r = ApiGet ('/api/node/' + [System.Uri]::EscapeDataString($id))
    $n = $r.node
    Write-Host ("id:      " + $n.id)
    Write-Host ("label:   " + $n.label)
    Write-Host ("type:    " + $n.type)
    if ($n.createdAt) { Write-Host ("created: " + $n.createdAt) }
    if ($n.meta) {
      foreach ($p in $n.meta.PSObject.Properties) {
        Write-Host ("meta:    " + $p.Name + " = " + $p.Value)
      }
    }
    $neighbors = @()
    if ($r.neighbors) { $neighbors = @($r.neighbors) }
    Write-Host ("neighbors (" + $neighbors.Count + "):")
    foreach ($nb in $neighbors) {
      Write-Host ("  - " + $nb.label + "  [" + $nb.type + "]  " + $nb.id)
    }
    $noteCount = 0
    if ($r.notes) { $noteCount = @($r.notes).Count }
    Write-Host ("notes: " + $noteCount)
  }

  'link' {
    $source = $Rest[0]
    $target = $Rest[1]
    if (-not $source -or -not $target) { Show-Usage; exit 1 }
    $body = @{ source = $source; target = $target }
    if ($Type) { $body.type = $Type }
    $r = ApiPost '/api/edge' $body
    Write-Host ("Edge saved: " + $r.edge.id)
  }

  'add' {
    $nodeType = $Rest[0]
    $label = $Rest[1]
    if (-not $nodeType -or -not $label) { Show-Usage; exit 1 }
    $r = ApiPost '/api/node' @{ type = $nodeType; label = $label }
    Write-Host ("Node saved: " + $r.node.id + "  [" + $r.node.type + "]  " + $r.node.label)
  }

  'stats' {
    $r = ApiGet '/api/stats'
    Write-Host ("nodes: " + $r.nodes + "  edges: " + $r.edges + "  notes: " + $r.notes)
    if ($r.byType) {
      $parts = @()
      foreach ($p in $r.byType.PSObject.Properties) { $parts += ($p.Name + "=" + $p.Value) }
      if ($parts.Count -gt 0) { Write-Host ("by type: " + ($parts -join '  ')) }
    }
    $top = @()
    if ($r.topConnected) { $top = @($r.topConnected) }
    if ($top.Count -gt 0) {
      Write-Host ""
      Write-Host "top connected:"
      foreach ($t in $top) {
        Write-Host ('{0,6}  {1,-9} {2}  ({3})' -f $t.degree, $t.type, $t.label, $t.id)
      }
    }
  }

  'hops' {
    $id = $Rest[0]
    if (-not $id) { Show-Usage; exit 1 }
    $depth = 2
    if ($Rest.Count -gt 1 -and $Rest[1]) {
      $parsed = 0
      if ([int]::TryParse($Rest[1], [ref]$parsed)) { $depth = $parsed }
    }
    $r = ApiGet ('/api/query/' + [System.Uri]::EscapeDataString($id) + '?hops=' + $depth)
    $nodes = @()
    if ($r.subgraph.nodes) { $nodes = @($r.subgraph.nodes) }
    $center = $r.center
    if ($center -and $center.id) { $center = $center.id }
    Write-Host ("center: " + $center + "  depth: " + $depth + "  nodes: " + $nodes.Count)
    foreach ($n in $nodes) {
      Write-Host ("  - " + $n.label + "  [" + $n.type + "]  " + $n.id)
    }
  }

  'backup' {
    $r = ApiPost '/api/backup' @{}
    Write-Host ("Backup written: " + $r.file)
  }

  'help' {
    Show-Usage
    exit 0
  }

  default {
    Show-Usage
    exit 1
  }
}
