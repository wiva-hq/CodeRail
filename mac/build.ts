// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
// Builds CodeRail.app (universal) with the bridge (as CodeRail Bridge.app) and Sparkle inside it, signs it, and zips it to
// build/CodeRail.zip. The version is RELEASE in bridge/src/env.ts and the build number CODERAIL_BUILD
// (the pipeline's run number, else 0); Sparkle compares build numbers. With CODERAIL_SPARKLE_KEY (the
// EdDSA private key file) it also writes build/CodeRail.zip.sparkle, the zip's Sparkle signature
// attributes for the appcast.
// Also signs the standalone macOS bridges in bridge/build (for install.sh and the GitHub release), since
// a Linux build leaves them unsigned.
//   bun mac/build.ts      (after `bun run build:bridge`, which makes bridge/build/coderail-darwin-*)
// Signs with CODERAIL_SIGN_IDENTITY, else the first "Developer ID Application" identity in the keychain,
// else ad hoc (refused with CODERAIL_REQUIRE_SIGNING=1, as in release builds). Notarizes and staples
// with an App Store Connect API key (CODERAIL_NOTARY_KEY: the .p8 file, CODERAIL_NOTARY_KEY_ID,
// CODERAIL_NOTARY_ISSUER), as CI does, or with the notarytool keychain profile CODERAIL_NOTARY_PROFILE
// (default "coderail-notary"), made once with:
//   xcrun notarytool store-credentials coderail-notary --apple-id <you@example.com> --team-id <TEAM>
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { universalMacBrowser } from '../bridge/scripts/browser';

const here = import.meta.dir;
const root = join(here, '..');
const out = join(here, 'build');
const app = join(out, 'CodeRail.app');
const contents = join(app, 'Contents');
const bridgeBuild = join(root, 'bridge/build');
const version = readFileSync(join(root, 'bridge/src/env.ts'), 'utf8').match(/RELEASE = '([^']+)'/)![1];
const build = process.env.CODERAIL_BUILD ?? '0';
const SPARKLE = '2.10.1';
const sparkle = join(here, '.cache', `Sparkle-${SPARKLE}`);

async function sh(cmd: string[], opts: { quiet?: boolean; ok?: boolean } = {}) {
  const p = Bun.spawn(cmd, { cwd: here, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0 && !opts.ok) {
    console.error(`${cmd.join(' ')} failed:\n${stdout}${stderr}`);
    process.exit(1);
  }
  if (!opts.quiet && stdout.trim()) console.log(stdout.trim());
  return { code, stdout, stderr };
}

if (!existsSync(join(sparkle, 'Sparkle.framework'))) {
  mkdirSync(sparkle, { recursive: true });
  const tar = join(sparkle, 'sparkle.tar.xz');
  await sh(['curl', '-fsSL', '-o', tar, `https://github.com/sparkle-project/Sparkle/releases/download/${SPARKLE}/Sparkle-${SPARKLE}.tar.xz`]);
  await sh(['tar', 'xf', tar, '-C', sparkle]);
  rmSync(tar);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(join(contents, 'MacOS'), { recursive: true });
mkdirSync(join(contents, 'Helpers'), { recursive: true });
mkdirSync(join(contents, 'Resources'), { recursive: true });
mkdirSync(join(contents, 'Frameworks'), { recursive: true });

// Sparkle, without its XPC services: those are only for sandboxed apps.
const framework = join(contents, 'Frameworks/Sparkle.framework');
await sh(['ditto', join(sparkle, 'Sparkle.framework'), framework]);
rmSync(join(framework, 'Versions/B/XPCServices'), { recursive: true });
rmSync(join(framework, 'XPCServices'), { force: true });

// The bridge, one binary for both chips, as an app of its own (CodeRail Bridge.app, in Helpers): macOS asks
// for, and remembers, Local Network access only for a program in a bundle that says why it wants it; a bare
// binary is silently kept off everything on the network but the router.
const bridgeApp = join(contents, 'Helpers/CodeRail Bridge.app');
mkdirSync(join(bridgeApp, 'Contents/MacOS'), { recursive: true });
await sh(['lipo', '-create', join(bridgeBuild, 'app/coderail-darwin-arm64'), join(bridgeBuild, 'app/coderail-darwin-x64'), '-output', join(bridgeApp, 'Contents/MacOS/coderail')]);
const browserResources = join(bridgeApp, 'Contents/Resources/browser');
await universalMacBrowser(browserResources);
writeFileSync(join(bridgeApp, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>codes.coderail.bridge</string>
  <key>CFBundleName</key><string>CodeRail Bridge</string>
  <key>CFBundleDisplayName</key><string>CodeRail Bridge</string>
  <key>CFBundleExecutable</key><string>coderail</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${build}</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSLocalNetworkUsageDescription</key><string>CodeRail Bridge opens the sites on this Mac's network, like your router or a dev server on another computer, in CodeRail's browser.</string>
</dict>
</plist>
`);

// The app, compiled for both chips.
for (const arch of ['arm64', 'x86_64']) {
  await sh(['swiftc', '-O', '-target', `${arch}-apple-macos13.0`, '-F', sparkle, '-framework', 'Sparkle', '-Xlinker', '-rpath', '-Xlinker', '@executable_path/../Frameworks', '-o', join(out, `CodeRail-${arch}`), join(here, 'CodeRail.swift')]);
}
await sh(['lipo', '-create', join(out, 'CodeRail-arm64'), join(out, 'CodeRail-x86_64'), '-output', join(contents, 'MacOS/CodeRail')]);

writeFileSync(join(contents, 'Info.plist'), readFileSync(join(here, 'Info.plist'), 'utf8').replaceAll('__VERSION__', version).replaceAll('__BUILD__', build));

// The icons: the app's, and the menu bar's template image.
const iconset = join(out, 'AppIcon.iconset');
mkdirSync(iconset);
const png = join(out, 'icon.png');
await sh(['swift', join(here, 'icon.swift'), 'app', png]);
await sh(['swift', join(here, 'icon.swift'), 'menubar', join(contents, 'Resources')]);
for (const px of [16, 32, 128, 256, 512]) {
  await sh(['sips', '-z', `${px}`, `${px}`, png, '--out', join(iconset, `icon_${px}x${px}.png`)], { quiet: true });
  await sh(['sips', '-z', `${px * 2}`, `${px * 2}`, png, '--out', join(iconset, `icon_${px}x${px}@2x.png`)], { quiet: true });
}
await sh(['iconutil', '-c', 'icns', iconset, '-o', join(contents, 'Resources/AppIcon.icns')]);

// Signing: the bridge first (with the entitlements Bun's JIT needs), then the app around it.
let identity = process.env.CODERAIL_SIGN_IDENTITY;
if (!identity) {
  const ids = (await sh(['security', 'find-identity', '-v', '-p', 'codesigning'], { quiet: true })).stdout;
  identity = ids.match(/"(Developer ID Application: [^"]+)"/)?.[1] ?? '-';
}
const signed = identity !== '-';
if (!signed && process.env.CODERAIL_REQUIRE_SIGNING === '1') {
  console.error('No Developer ID Application identity to sign with, and CODERAIL_REQUIRE_SIGNING=1');
  process.exit(1);
}
const runtime = signed ? ['--options', 'runtime', '--timestamp'] : [];
// Sign native browser code inside out before sealing the bridge bundle around it.
const browserApp = join(browserResources, 'camoufox/Camoufox.app');
const nestedApps = (await sh(['find', browserApp, '-depth', '-type', 'd', '(', '-name', '*.app', '-o', '-name', '*.framework', ')'], { quiet: true })).stdout.trim().split('\n').filter(Boolean);
const mainExecutables = new Set<string>();
for (const bundle of nestedApps.filter((p) => p.endsWith('.app'))) {
  const name = (await sh(['plutil', '-extract', 'CFBundleExecutable', 'raw', '-o', '-', join(bundle, 'Contents/Info.plist')], { quiet: true })).stdout.trim();
  mainExecutables.add(join(bundle, 'Contents/MacOS', name));
}
const nativeFiles = (await sh(['find', browserResources, '-type', 'f'], { quiet: true })).stdout.trim().split('\n');
for (const file of nativeFiles) {
  if (mainExecutables.has(file)) continue;
  const fd = openSync(file, 'r');
  const magic = Buffer.alloc(4);
  try { readSync(fd, magic, 0, 4, 0); } finally { closeSync(fd); }
  if (['cffaedfe', 'cefaedfe', 'cafebabe', 'bebafeca'].includes(magic.toString('hex'))) await sh(['codesign', '--force', '--sign', identity, ...runtime, '--entitlements', join(here, 'bridge.entitlements'), file], { quiet: true });
}
for (const bundle of nestedApps) await sh(['codesign', '--force', '--sign', identity, ...runtime, '--entitlements', join(here, 'bridge.entitlements'), bundle], { quiet: true });
const darwinBridges = ['arm64', 'x64'].map((a) => join(bridgeBuild, `coderail-darwin-${a}`));
for (const bin of [bridgeApp, ...darwinBridges]) {
  await sh(['codesign', '--force', '--sign', identity, ...runtime, '--entitlements', join(here, 'bridge.entitlements'), bin], { quiet: true });
}
// Sparkle's helpers, inside out, then the framework (as Sparkle's docs sign it).
for (const part of ['Versions/B/Autoupdate', 'Versions/B/Updater.app', '']) {
  await sh(['codesign', '--force', '--sign', identity, ...runtime, join(framework, part)], { quiet: true });
}
await sh(['codesign', '--force', '--sign', identity, ...runtime, app], { quiet: true });
await sh(['codesign', '--verify', '--strict', '--deep', app], { quiet: true });
console.log(`signed with ${signed ? identity : 'an ad-hoc signature (no Developer ID found)'}`);

const zip = join(out, 'CodeRail.zip');
const zipIt = () => sh(['ditto', '-c', '-k', '--keepParent', app, zip], { quiet: true });
await zipIt();

const { CODERAIL_NOTARY_KEY: key, CODERAIL_NOTARY_KEY_ID: keyId, CODERAIL_NOTARY_ISSUER: issuer } = process.env;
const profile = process.env.CODERAIL_NOTARY_PROFILE ?? 'coderail-notary';
let notary: string[] | null = null;
if (signed && key && keyId && issuer) notary = ['--key', key, '--key-id', keyId, '--issuer', issuer];
else if (signed && (await sh(['xcrun', 'notarytool', 'history', '--keychain-profile', profile], { quiet: true, ok: true })).code === 0)
  notary = ['--keychain-profile', profile];

if (notary) {
  console.log('notarizing (a few minutes)…');
  const submit = async (file: string) => {
    const r = await sh(['xcrun', 'notarytool', 'submit', file, ...notary!, '--wait']);
    if (!/status: Accepted/.test(r.stdout)) {
      console.error(`notarization of ${file} was not accepted`);
      process.exit(1);
    }
  };
  await submit(zip);
  await sh(['xcrun', 'stapler', 'staple', app]);
  rmSync(zip);
  await zipIt();
  // The bare bridges can't be stapled, but notarizing them lets Gatekeeper check them online.
  const bridges = join(out, 'bridges.zip');
  await sh(['zip', '-qj', bridges, ...darwinBridges], { quiet: true });
  await submit(bridges);
  rmSync(bridges);
  console.log('notarized (the app stapled)');
} else {
  console.log('not notarized (no API key or notarytool profile): Gatekeeper will ask people to allow it in System Settings');
}

const edKey = process.env.CODERAIL_SPARKLE_KEY;
if (edKey) {
  const r = await sh([join(sparkle, 'bin/sign_update'), '--ed-key-file', edKey, zip], { quiet: true });
  writeFileSync(`${zip}.sparkle`, r.stdout.trim() + '\n');
  console.log('signed the update for Sparkle');
}

for (const f of ['CodeRail-arm64', 'CodeRail-x86_64', 'icon.png']) rmSync(join(out, f));
rmSync(iconset, { recursive: true });
console.log(`built ${zip} (CodeRail ${version} build ${build}, ${(Bun.file(zip).size / 1e6).toFixed(1)} MB)`);
