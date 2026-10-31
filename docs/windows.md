# Windows support: handoff

CodeRail's bridge (the program on each computer) runs on macOS and Linux today. This is everything that needs
doing for Windows, where it lives in the code, and how to test it. The server (one Docker container) and the web app
already work from any OS; almost all of the work is in `bridge/`.

Status on 2026-10-27: nothing for Windows exists yet beyond `osName('win32')` in the web app.

## How the pieces fit (5-minute version)

- **Server** (`server/`, Docker): accounts, permissions, and a hub per computer that relays WebSockets between the
  browser and that computer's bridge. Unchanged for Windows except two small path checks (below).
- **Bridge** (`bridge/`, Bun, compiled to one binary): connects *out* to the server, runs Claude Code and Codex
  through their ACP adapters, and serves terminals (PTYs), files, git and a per-chat Camofox browser. Entry point
  `bridge/src/main.ts` (`link`, `run`, `service`, `status`, `unlink`).
- **Protocol** (`protocol/src/index.ts`): every method, who may call it, and the events.
- Read `docs/DESIGN.md` for the full picture.

## The decision to make first: paths

The protocol, the server and the web app assume POSIX paths: absolute means it starts with `/`, the separator is
`/`. Windows has `C:\Users\me\code`.

**Recommendation:** keep the wire format `/`-separated and normalize at the bridge edge. The bridge reports and
accepts paths like `C:/Users/me/code` (drive letter, forward slashes); Node's `path.win32` accepts those, so the
bridge converts once when it reads and writes the file system. Then only "absolute" checks need to learn about a
drive letter:

| Where | Today | Change |
|---|---|---|
| `protocol/src/index.ts` `inFolders` (~line 352) | compares with `/` | keep, but compare case-insensitively when the path starts with a drive letter (Windows paths aren't case-sensitive) |
| `server/src/index.ts` grant folders (~line 400) | must start with `/` | also allow `^[A-Za-z]:/` |
| `web/src/components/FolderPicker.svelte` typed path (~line 67) and `crumbs` | must start with `/`, root `/` | allow a drive root (`C:/`) as a root |
| `web/src/lib/machineText.ts` `parentOf`, `tilde`, `untilde` | `/` root | treat `C:/` as a root; `~` works as is once the bridge reports `home` as `C:/Users/me` |
| `bridge/src/scope.ts` `expand`, `real`, `checkPath`, the `.git` check (line 74) | `/` | normalize with `path.win32` + forward slashes; compare case-insensitively |

Do this first; everything below builds on it.

## Work list (in order)

### 1. Terminals: no PTY in Bun on Windows (biggest item)

`bridge/src/terminals.ts` spawns shells with `Bun.spawn(cmd, { terminal: {...} })` (line ~67). Bun's own docs for
that option: *"Only available on POSIX systems (Linux, macOS)."* Windows needs ConPTY another way:

- Try `@lydell/node-pty` or `node-pty` (N-API, prebuilt Windows binaries; Bun loads N-API modules). It must be
  bundled with the compiled bridge the way Camofox's native module is (see `bridge/scripts/build.ts`,
  `browser.ts` `impit-*`).
- Wrap it behind the same small interface `terminals.ts` uses (`write`, `resize`, `kill`, data callback,
  `exited`), so macOS/Linux keep `Bun.spawn`.
- Default shell (line ~50): `pwsh.exe` if installed, else `powershell.exe`, else `%ComSpec%`; not `/bin/zsh`.
- `kill('SIGHUP')` (lines ~174, ~181): use a plain `kill()` on Windows.
- Harness sign-in (`terminals.login`) runs in a terminal too, so it depends on this.

### 2. The service (starts the bridge at login)

`bridge/src/main.ts` `installService` / `uninstallService` / `status` (lines ~177-290) handle `launchd` (macOS) and
`systemd --user` (Linux).

- Use a **per-user Scheduled Task** at logon (`schtasks /Create /SC ONLOGON /TN CodeRail /TR "<exe> run" /RL LIMITED
  /F`, with restart on failure), or the `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` key. Not a Windows
  Service: a service runs as SYSTEM, without the person's `claude`/`codex` logins or PATH.
- Logs go to `~/.coderail/bridge.log` as today (`LOG_PATH`).
- `status` reads the task's state (`schtasks /Query /TN CodeRail /FO LIST`).

### 3. The environment the agents get

`bridge/src/env.ts` `userEnv()` (line ~76) runs the login shell (`$SHELL -ilc 'env -0'`) to get the person's PATH,
since a launchd/systemd service starts with a bare one. On Windows a Scheduled Task already gets the user's
environment: return `process.env` (minus `BUN_BE_BUN`) and skip the probe.

`detect()` in `bridge/src/agents.ts` (~line 507) uses `Bun.which`, which honours `PATHEXT`, so `claude.exe` /
`claude.cmd` are found. Check that the ACP adapters start `claude` / `codex` correctly on Windows
(`CLAUDE_CODE_EXECUTABLE`, `CODEX_PATH` in `AdapterProcess.start`).

### 4. Small OS switches

| Where | macOS / Linux | Windows |
|---|---|---|
| `bridge/src/main.ts` line ~97 (open the link page) | `open` / `xdg-open` | `cmd /c start "" <url>` |
| `bridge/src/files.ts` `trash` (line ~112) | `~/.Trash`, XDG trash | the Recycle Bin: PowerShell `Microsoft.VisualBasic.FileIO.FileSystem` `DeleteFile/DeleteDirectory(..., SendToRecycleBin)` |
| `bridge/src/config.ts`, `env.ts` `mode: 0o700/0o600`, `chmodSync` | protects the machine token | no effect on Windows; `~/.coderail` under the user profile is private by default. Note it, don't fight it |
| `bridge/src/scope.ts` `guarded()` message | mentions macOS Full Disk Access | fine as is (only fires on macOS timeouts) |
| `bridge/src/env.ts` line ~48 | macOS-only check | returns null elsewhere, fine |

### 5. The browser (Camofox)

`bridge/scripts/browser.ts` builds a Camofox runtime per target from the Camoufox release zips (`ENGINES`, line ~15)
plus `impit-<target>` (a native module).

- Add `windows-x64` (Camoufox publishes `win.x86_64`; take its sha256 from the release). `impit` has
  `impit-win32-x64-msvc`.
- The executable inside is `camoufox.exe`; check `CAMOUFOX_INSTALL_DIR` and the launch env in
  `bridge/src/browser.ts` (`launch()`, ~line 76).
- `bridge/src/browser-runtime.ts` uses `${process.platform}-${process.arch}` (`win32-x64`) for the dev path; pick
  one target name (`windows-x64`) and map it.
- The plugin (`bridge/src/camofox-plugin.js`) and the agent's browser tools (`browser-mcp.ts`) are plain
  JavaScript/HTTP and should need nothing.

### 6. Build, install, release

- `bridge/scripts/build.ts`: add `windows-x64` (`bun build --compile --target=bun-windows-x64`, output
  `coderail-windows-x64.exe`). The darwin-only `codesign` step stays darwin-only; Windows wants Authenticode
  signing (`signtool`) in the release job, or SmartScreen warns on download.
- `install.sh` (served by `server/src/install.ts`) is POSIX sh. Add `install.ps1` (download, checksum, put the exe
  in `%LOCALAPPDATA%\CodeRail`, add to the user PATH, run `coderail link <server>`), and a `/install.ps1` route in
  `server/src/index.ts` next to `/install.sh`. Usage: `irm https://<server>/install.ps1 | iex`.
- `scripts/publish.ts` (`TARGETS`, line ~27) and `.github/workflows/release.yml`: add a `windows-latest` job that
  builds and signs, and publish the `.exe` with the others in `latest.json`.
- A tray app like `mac/` is optional and later; the CLI + Scheduled Task is enough to start.

## Running it while you work

On any machine (the server can run on your Mac or Linux box):

```sh
bun install
bun run dev:server          # server on :8787, data in ./data, setup token "dev" (or $SETUP_TOKEN)
# open http://<that machine>:8787/setup, make an admin
```

On the Windows machine, with Bun installed:

```sh
bun install
cd bridge
bun src/main.ts link http://<server-host>:8787 --no-service   # approve the code in the browser
```

`--no-service` keeps it in the foreground (no Scheduled Task) while you iterate. `CODERAIL_HOME=<dir>` gives it a
scratch state folder instead of `~/.coderail`.

Type checks: `bun run check` at the repo root. The browser test (needs a built Camofox runtime):
`cd bridge && bun run test:browser`.

## Test plan (done = all of these on a real Windows 11 machine)

1. `install.ps1` from a fresh user account; `coderail link` approves; the computer shows online after a reboot.
2. Folder picker: browse `C:/Users/<you>`, type `~/code`, type a bad path (shows "doesn't exist"), New Folder,
   Rename, Move to Trash (lands in the Recycle Bin).
3. An Operator limited to `C:/Users/<you>/code` can't open `C:/Users/<you>/Documents` (files, git, folder picker),
   and `c:/users/<you>/CODE` is treated as the same folder.
4. A Claude Code chat and a Codex chat: start, prompt, approve a tool, cancel, reopen after the bridge restarts.
5. Terminal: open, type, resize, colours, `exit`, close; the harness sign-in terminal.
6. Changes card: status, diff, stage, commit, push in a repo with CRLF files.
7. Browser card: open a site, click, type, scroll; ask Claude to browse with its browser tools.
8. Pull the network for 30 s mid-turn: the turn's answer still arrives (the bridge holds events while offline).

## Things to watch for

- **Case-insensitive paths** are the main security edge: a folder limit must not be bypassed by `C:/Users/X` vs
  `c:/users/x`, or by a junction/symlink (`realpath` handles junctions; test it).
- **Line endings**: diffs and file writes must keep CRLF files CRLF (`web/src/lib/diffs.ts`, `bridge/src/files.ts`).
- **Long paths** (> 260 characters) and paths with spaces in shells and git calls.
- **Antivirus** may slow or block the compiled bridge and Camoufox on first run.

Keep the code style of the files you touch (short comments in parentheses, plain words).
