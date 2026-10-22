<#
.SYNOPSIS
  Screen Coach threat check 1: no screenshot is ever written to disk.

.DESCRIPTION
  Run once with -Start before using Screen Coach, use it (hold the hotkey a few times, use
  "Look at my screen" from the tray), then run again with -Check. Every file created or changed
  since -Start under %TEMP%, Mew's app-data folders and the crash-dump folder is checked for
  image signatures (JPEG, PNG, BMP, GIF, WebP, DDS) and crash dumps.

  Other apps write to %TEMP% too: anything listed there is worth a look, but only files under
  Mew's own folders (or new crash dumps) fail the check outright.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\check-no-screenshots.ps1 -Start
  powershell -ExecutionPolicy Bypass -File scripts\check-no-screenshots.ps1 -Check
#>
param(
  [switch]$Start,
  [switch]$Check,
  [string]$MarkerPath = (Join-Path $env:TEMP 'mew-no-screenshots-start.txt')
)

$ErrorActionPreference = 'Stop'

$mewFolders = @(
  (Join-Path $env:APPDATA 'app.mew.desktop'),
  (Join-Path $env:LOCALAPPDATA 'app.mew.desktop')
)
$otherFolders = @($env:TEMP, (Join-Path $env:LOCALAPPDATA 'CrashDumps'))

# Files written at or after $since, walking folders by hand so one unreadable folder doesn't
# stop the scan (Windows PowerShell's .NET has no EnumerationOptions).
function Get-RecentFiles([string]$root, [datetime]$since) {
  $pending = New-Object System.Collections.Generic.Stack[System.IO.DirectoryInfo]
  if (-not (Test-Path -LiteralPath $root)) { return }
  $pending.Push((New-Object System.IO.DirectoryInfo $root))
  while ($pending.Count -gt 0) {
    $dir = $pending.Pop()
    try { $entries = $dir.GetFileSystemInfos() } catch { continue }
    foreach ($entry in $entries) {
      if ($entry -is [System.IO.DirectoryInfo]) {
        # Don't follow junctions/symlinks out of the folder being checked.
        if (-not ($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { $pending.Push($entry) }
      } elseif ($entry.LastWriteTimeUtc -ge $since -or $entry.CreationTimeUtc -ge $since) {
        $entry
      }
    }
  }
}

function Get-Kind([string]$path) {
  try {
    $stream = [System.IO.File]::Open($path, 'Open', 'Read', 'ReadWrite, Delete')
    try {
      $head = New-Object byte[] 16
      $read = $stream.Read($head, 0, 16)
    } finally { $stream.Dispose() }
  } catch { return $null }
  if ($read -ge 3 -and $head[0] -eq 0xFF -and $head[1] -eq 0xD8 -and $head[2] -eq 0xFF) { return 'JPEG' }
  if ($read -ge 4 -and $head[0] -eq 0x89 -and $head[1] -eq 0x50 -and $head[2] -eq 0x4E -and $head[3] -eq 0x47) { return 'PNG' }
  if ($read -ge 2 -and $head[0] -eq 0x42 -and $head[1] -eq 0x4D) { return 'BMP' }
  if ($read -ge 4 -and $head[0] -eq 0x47 -and $head[1] -eq 0x49 -and $head[2] -eq 0x46 -and $head[3] -eq 0x38) { return 'GIF' }
  if ($read -ge 12 -and $head[0] -eq 0x52 -and $head[1] -eq 0x49 -and $head[8] -eq 0x57 -and $head[9] -eq 0x45) { return 'WebP' }
  if ($read -ge 4 -and $head[0] -eq 0x44 -and $head[1] -eq 0x44 -and $head[2] -eq 0x53 -and $head[3] -eq 0x20) { return 'DDS' }
  if ($read -ge 4 -and $head[0] -eq 0x4D -and $head[1] -eq 0x44 -and $head[2] -eq 0x4D -and $head[3] -eq 0x50) { return 'crash dump' }
  return $null
}

if ($Start -eq $Check) {
  Write-Output 'Use exactly one of -Start or -Check.'
  exit 2
}

if ($Start) {
  [datetime]::UtcNow.Ticks.ToString() | Out-File -LiteralPath $MarkerPath -Encoding ascii
  Write-Output 'Start time recorded. Use Screen Coach, then run with -Check.'
  exit 0
}

if (-not (Test-Path -LiteralPath $MarkerPath)) {
  Write-Output 'No start time found: run with -Start first.'
  exit 2
}
$since = New-Object datetime ([long](Get-Content -LiteralPath $MarkerPath -Raw).Trim()), ([System.DateTimeKind]::Utc)

$failed = $false
$changed = 0
foreach ($root in $mewFolders + $otherFolders) {
  foreach ($file in Get-RecentFiles $root $since) {
    if ($file.FullName -eq $MarkerPath) { continue }
    $changed++
    $kind = Get-Kind $file.FullName
    $isDump = $file.Extension -eq '.dmp' -or $kind -eq 'crash dump'
    if (-not $kind -and -not $isDump) { continue }
    $label = if ($isDump) { 'crash dump' } else { $kind }
    $inMew = $mewFolders -contains $root
    if ($inMew -or $isDump) {
      $failed = $true
      Write-Output "FAIL  $label  $($file.FullName)"
    } else {
      Write-Output "check $label  $($file.FullName)  (written by another app?)"
    }
  }
}

Write-Output "$changed files created or changed since the start time."
if ($failed) {
  Write-Output 'Result: FAIL (an image or crash dump appeared in a Mew folder or the crash-dump folder).'
  exit 1
}
Write-Output 'Result: PASS (no image or crash dump written by Mew).'
exit 0
