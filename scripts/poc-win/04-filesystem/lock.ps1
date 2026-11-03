# Copyright 2026 Wiva, Inc.
# SPDX-License-Identifier: Apache-2.0
param([string]$Path, [string]$Ready, [int]$Milliseconds = 200, [string]$Release = '')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = $OutputEncoding = [Text.UTF8Encoding]::new($false)
$file = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
try {
  [IO.File]::WriteAllText($Ready, 'locked')
  if ($Release) {
    $deadline = [DateTime]::UtcNow.AddMilliseconds($Milliseconds)
    while (-not [IO.File]::Exists($Release)) {
      if ([DateTime]::UtcNow -gt $deadline) { throw 'Lock release deadline exceeded' }
      Start-Sleep -Milliseconds 10
    }
  } else { Start-Sleep -Milliseconds $Milliseconds }
}
finally { $file.Dispose() }
