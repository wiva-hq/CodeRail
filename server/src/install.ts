// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import type { Latest } from './downloads';

/**
 * The script behind `curl -fsSL https://<host>/install.sh | sh`: installs the newest bridge build from
 * the download host (its URL and checksum written in here from latest.json) and links this computer.
 */
export function installScript(origin: string, latest: Latest): string {
  const cases = Object.entries(latest.bridge)
    .filter(([target]) => !target.startsWith('windows'))
    .map(([target, f]) => `  ${target}) url='${f.url}'; sum='${f.sha256}' ;;`)
    .join('\n');
  return `#!/bin/sh
# CodeRail bridge installer for ${origin} (bridge ${latest.version} build ${latest.build})
set -eu

os=$(uname -s | tr '[:upper:]' '[:lower:]')
arch=$(uname -m)
case "$arch" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64) arch=x64 ;;
  *) echo "CodeRail: unsupported CPU $arch" >&2; exit 1 ;;
esac
case "$os-$arch" in
${cases}
  *) echo "CodeRail: no bridge build for $os-$arch (macOS and Linux; on Windows use install.ps1)" >&2; exit 1 ;;
esac

dir="$HOME/.coderail/bin"
mkdir -p "$dir"
echo "Downloading the CodeRail bridge ${latest.version} build ${latest.build} for $os-$arch..."
curl -fL --progress-bar -o "$dir/coderail.tmp" "$url"
if command -v sha256sum >/dev/null 2>&1; then got=$(sha256sum "$dir/coderail.tmp" | cut -d' ' -f1)
else got=$(shasum -a 256 "$dir/coderail.tmp" | cut -d' ' -f1); fi
if [ "$got" != "$sum" ]; then
  rm -f "$dir/coderail.tmp"
  echo "CodeRail: the download doesn't match its checksum; try again" >&2
  exit 1
fi
chmod +x "$dir/coderail.tmp"
mv "$dir/coderail.tmp" "$dir/coderail"
if [ "$os" = darwin ]; then xattr -d com.apple.quarantine "$dir/coderail" 2>/dev/null || true; fi

case ":$PATH:" in
  *":$dir:"*) ;;
  *)
    for rc in "$HOME/.zshrc" "$HOME/.bashrc"; do
      if [ -f "$rc" ] && ! grep -q '.coderail/bin' "$rc"; then
        printf '\\nexport PATH="$HOME/.coderail/bin:$PATH"\\n' >> "$rc"
      fi
    done
    ;;
esac

echo "Installed $dir/coderail"
if [ -f "$HOME/.coderail/config.json" ]; then
  "$dir/coderail" service restart
else
  "$dir/coderail" link "${origin}" </dev/tty
fi
`;
}

/**
 * What an installed Windows bridge's `coderail update` reads (/api/version/windows-x64; bridge/src/platform/win32/
 * update-manifest.ts checks it), or null when the newest build has no Windows bridge.
 */
export function windowsManifest(latest: Latest) {
  const f = latest.bridge['windows-x64'];
  if (!f?.size) return null;
  return { schema: 1, target: 'windows-x64', helperProtocol: 1, version: `${latest.version}+${latest.build}`, sha256: f.sha256, size: f.size, url: f.url };
}

/**
 * The script behind `irm https://<host>/install.ps1 | iex`, for Windows PowerShell 5.1 and later in a normal (not
 * administrator) window: downloads the newest Windows bridge, checks it, installs it for the current user and links
 * this computer; an installed one is updated instead.
 */
export function installPowerShell(origin: string, latest: Latest): string | null {
  const f = latest.bridge['windows-x64'];
  if (!f) return null;
  return `# CodeRail bridge installer for ${origin} (bridge ${latest.version} build ${latest.build})
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$arch = $env:PROCESSOR_ARCHITEW6432; if (-not $arch) { $arch = $env:PROCESSOR_ARCHITECTURE }
if ($arch -ne 'AMD64') { throw "CodeRail: no Windows bridge build for $arch (x64 for now)" }
$state = Join-Path $env:LOCALAPPDATA 'CodeRail'
$exe = Join-Path $state 'bin\\current\\coderail.exe'
if ((Test-Path $exe) -and (Test-Path (Join-Path $state 'installation.json'))) {
  Write-Host 'CodeRail is installed here; updating it.'
  & $exe update
  return
}
$tmp = Join-Path $env:TEMP ('coderail-' + [guid]::NewGuid().ToString('N') + '.exe')
try {
  Write-Host 'Downloading the CodeRail bridge ${latest.version} build ${latest.build} for windows-x64 (about 600 MB)...'
  Invoke-WebRequest -UseBasicParsing -Uri '${f.url}' -OutFile $tmp
  if ((Get-FileHash -Algorithm SHA256 $tmp).Hash.ToLower() -ne '${f.sha256}') { throw "CodeRail: the download doesn't match its checksum; try again" }
  & $tmp install
  if ($LASTEXITCODE) { throw "CodeRail: installing failed ($LASTEXITCODE)" }
} finally {
  Remove-Item $tmp -Force -ErrorAction SilentlyContinue
}
& $exe link '${origin}'
`;
}
