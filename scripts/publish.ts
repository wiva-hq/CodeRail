// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
// Publishes a build (the release pipeline's last job, after the bridges and the Mac app are built):
//   1. a GitHub release v<RELEASE>-build.<N> with every file and SHA256SUMS: where every build is downloaded from
//   2. the pointers to the newest one on dl.coderail.codes (R2 bucket coderail-downloads): latest.json (read by the
//      servers for install.sh and the Mac download) and mac/appcast.xml (Sparkle's feed, the Mac app's updates),
//      both naming that release's files; anything else in the bucket (older builds' files) is deleted.
//   bun scripts/publish.ts [--no-github] [--no-r2]
// Needs CODERAIL_BUILD; GH_TOKEN and GITHUB_REPOSITORY for GitHub; for R2, CLOUDFLARE_ACCOUNT_ID and
// CLOUDFLARE_API_TOKEN (or a wrangler login). Expects bridge/build/coderail-{darwin,linux}-{arm64,x64} and
// mac/build/CodeRail.zip with its Sparkle signature, mac/build/CodeRail.zip.sparkle.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const BUCKET = 'coderail-downloads';
/** The Cloudflare account that hosts the R2 bucket behind dl.coderail.codes (a secret on the release environment). */
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
const version = readFileSync(join(root, 'bridge/src/env.ts'), 'utf8').match(/RELEASE = '([^']+)'/)![1];
const build = process.env.CODERAIL_BUILD;
if (!build) throw new Error('Set CODERAIL_BUILD');
const id = `${version}-${build}`;
const tag = `v${version}-build.${build}`;
const args = process.argv.slice(2);

const TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'];
const macZip = join(root, 'mac/build/CodeRail.zip');
const files = [
  ...TARGETS.map((t) => ({ name: `coderail-${t}`, path: join(root, 'bridge/build', `coderail-${t}`), type: 'application/octet-stream' })),
  { name: `CodeRail-${id}-mac.zip`, path: macZip, type: 'application/zip' },
];
for (const f of files) if (!existsSync(f.path)) throw new Error(`Missing ${f.path}`);

const sha256 = async (path: string) => new Bun.CryptoHasher('sha256').update(await Bun.file(path).bytes()).digest('hex');
const sums: Record<string, string> = {};
for (const f of files) sums[f.name] = await sha256(f.path);
const sumsPath = join(root, 'mac/build/SHA256SUMS');
writeFileSync(sumsPath, Object.entries(sums).map(([n, s]) => `${s}  ${n}\n`).join(''));
files.push({ name: 'SHA256SUMS', path: sumsPath, type: 'text/plain' });
console.log(`CodeRail ${version} build ${build}:\n${readFileSync(sumsPath, 'utf8')}`);

async function run(cmd: string[], cwd = root) {
  const p = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT } });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`${cmd.slice(0, 4).join(' ')} failed:\n${out}${err}`);
  return out.trim();
}

const repo = process.env.GITHUB_REPOSITORY;
let githubUrl = `https://github.com/${repo ?? 'wiva-hq/CodeRail'}/releases/tag/${tag}`;

// 1. GitHub
if (!args.includes('--no-github')) {
  const token = process.env.GH_TOKEN;
  if (!token || !repo) throw new Error('Set GH_TOKEN and GITHUB_REPOSITORY, or pass --no-github');
  const gh = (path: string, init: RequestInit = {}) =>
    fetch(path.startsWith('http') ? path : `https://api.github.com/repos/${repo}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', ...(init.headers ?? {}) },
    });
  const r = await gh('/releases', {
    method: 'POST',
    body: JSON.stringify({
      tag_name: tag,
      target_commitish: process.env.GITHUB_SHA,
      name: `CodeRail ${version} (build ${build})`,
      prerelease: true,
      generate_release_notes: true,
    }),
  });
  if (!r.ok) throw new Error(`Creating the GitHub release failed: ${r.status} ${await r.text()}`);
  const release: any = await r.json();
  githubUrl = release.html_url;
  const upload = release.upload_url.replace(/\{.*\}$/, '');
  for (const f of files) {
    const u = await gh(`${upload}?name=${encodeURIComponent(f.name)}`, { method: 'POST', headers: { 'content-type': f.type }, body: Bun.file(f.path) });
    if (!u.ok) throw new Error(`Uploading ${f.name} failed: ${u.status} ${await u.text()}`);
    console.log(`GitHub: ${f.name}`);
  }
  console.log(`GitHub release: ${githubUrl}`);
}

// 2. The pointers on the download host
if (!args.includes('--no-r2')) {
  if (!ACCOUNT) throw new Error('Set CLOUDFLARE_ACCOUNT_ID, or pass --no-r2');
  const sparkle = `${macZip}.sparkle`;
  if (!existsSync(sparkle)) throw new Error(`No Sparkle signature (${sparkle}); was CODERAIL_SPARKLE_KEY set for the Mac build?`);
  const sig = readFileSync(sparkle, 'utf8').trim(); // sparkle:edSignature="…" length="…"
  if (!/sparkle:edSignature="[^"]+"/.test(sig)) throw new Error(`Unexpected Sparkle signature: ${sig}`);
  const token = process.env.CLOUDFLARE_API_TOKEN ?? (await run(['bunx', 'wrangler', 'auth', 'token'], root)).split('\n').pop()!;

  const put = async (key: string, path: string, type: string, cache: string) => {
    for (let attempt = 1; ; attempt++) {
      try {
        await run(['bunx', 'wrangler', 'r2', 'object', 'put', `${BUCKET}/${key}`, '--file', path, '--content-type', type, '--cache-control', cache, '--remote'], root);
        break;
      } catch (e) {
        if (attempt === 3) throw e;
        console.log(`R2: ${key} failed (attempt ${attempt}), retrying`);
        await Bun.sleep(5000 * attempt);
      }
    }
    console.log(`R2: ${key}`);
  };
  // (The files are the GitHub release's: R2's uploads stop at 300 MiB, and a bridge with its browser is bigger.)
  const url = (name: string) => `https://github.com/${repo ?? 'wiva-hq/CodeRail'}/releases/download/${tag}/${name}`;
  for (const f of files) {
    const r = await fetch(url(f.name), { method: 'HEAD' });
    if (!r.ok) throw new Error(`${url(f.name)} isn't downloadable (${r.status}); is the GitHub release there?`);
  }

  const published = new Date();
  const latest = {
    version,
    build,
    published: published.toISOString(),
    mac: { url: url(`CodeRail-${id}-mac.zip`), sha256: sums[`CodeRail-${id}-mac.zip`], size: Bun.file(macZip).size },
    bridge: Object.fromEntries(TARGETS.map((t) => [t, { url: url(`coderail-${t}`), sha256: sums[`coderail-${t}`] }])),
    github: githubUrl,
  };
  const appcast = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <title>CodeRail</title>
    <item>
      <title>CodeRail ${version} (build ${build})</title>
      <pubDate>${published.toUTCString()}</pubDate>
      <sparkle:version>${build}</sparkle:version>
      <sparkle:shortVersionString>${version}</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>13.0</sparkle:minimumSystemVersion>
      <enclosure url="${latest.mac.url}" type="application/octet-stream" ${sig} />
    </item>
  </channel>
</rss>
`;
  const tmp = join(root, 'mac/build');
  writeFileSync(join(tmp, 'latest.json'), JSON.stringify(latest, null, 2) + '\n');
  writeFileSync(join(tmp, 'appcast.xml'), appcast);
  await put('latest.json', join(tmp, 'latest.json'), 'application/json', 'no-cache');
  await put('mac/appcast.xml', join(tmp, 'appcast.xml'), 'application/xml', 'no-cache');

  // Only the pointers stay.
  const keep = (key: string) => key === 'latest.json' || key === 'mac/appcast.xml';
  const old: string[] = [];
  let cursor = '';
  do {
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/r2/buckets/${BUCKET}/objects?per_page=1000${cursor ? `&cursor=${cursor}` : ''}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body: any = await r.json();
    if (!body.success) throw new Error(`Listing R2 failed: ${JSON.stringify(body.errors)}`);
    old.push(...body.result.map((o: { key: string }) => o.key).filter((k: string) => !keep(k)));
    cursor = body.result_info?.is_truncated ? body.result_info.cursor : '';
  } while (cursor);
  for (const key of old) {
    await run(['bunx', 'wrangler', 'r2', 'object', 'delete', `${BUCKET}/${key}`, '--remote'], root);
    console.log(`R2: deleted ${key}`);
  }
  console.log(`Download host: https://dl.coderail.codes/latest.json, pointing at ${githubUrl}`);
}
