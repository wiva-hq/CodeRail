# Copyright 2026 Wiva, Inc.
# SPDX-License-Identifier: Apache-2.0
param([ValidateSet('all','runtime','terminal','codex')][string]$Suite = 'all')
$ErrorActionPreference = 'Stop'
if ($Suite -eq 'all' -or $Suite -eq 'codex') { $env:POC_CODEX_PATH = (Get-Command codex -ErrorAction Stop).Source }
$env:POC_PWSH_PATH = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
$env:POC_NODE_PATH = (Get-Command node -ErrorAction Stop).Source
$pocRepository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
if (-not (Test-Path -LiteralPath (Join-Path $pocRepository 'bridge/node_modules/@agentclientprotocol/codex-acp'))) {
  Push-Location -LiteralPath $pocRepository
  try {
    & npx.cmd --yes --package bun@1.4.4 bun install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw 'Locked repository dependencies failed to install' }
  } finally { Pop-Location }
}
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules/node-pty'))) {
  Push-Location -LiteralPath $PSScriptRoot
  try {
    & npm.cmd ci --workspaces=false --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'PoC dependencies failed to install' }
  } finally { Pop-Location }
}
$pocRunner = Join-Path $PSScriptRoot 'run.ts'
& npx.cmd --yes --package bun@1.4.4 bun $pocRunner $Suite
exit $LASTEXITCODE
