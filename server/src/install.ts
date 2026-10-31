// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import type { Latest } from './downloads';

/**
 * The script behind `curl -fsSL https://<host>/install.sh | sh`: installs the newest bridge build from
 * the download host (its URL and checksum written in here from latest.json) and links this computer.
 */
export function installScript(origin: string, latest: Latest): string {
  const cases = Object.entries(latest.bridge)
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
  *) echo "CodeRail: no bridge build for $os-$arch (macOS and Linux for now)" >&2; exit 1 ;;
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
