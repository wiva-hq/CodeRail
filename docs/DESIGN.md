# CodeRail: design

A self-hosted remote control for the coding agents on your computers. You run it as one Docker container on
your own server and domain, install a small bridge on each computer, and from any browser (or the phone and
desktop clients) you see your machines and work on them as if you were sitting there: agent chats
(Claude Code, Codex, …), approvals, terminals, files, diffs and git.

The UI and the ACP adapters come from Forest (`~/Development/forest`). They're copied in and adapted.
Forest's sync, shared projects, cloud runners, contacts and channels are left out.

## Decisions so far

| Topic | Decision |
|---|---|
| Scope | Bridge everything about the machine: agents, approvals, terminal, folder view, diffs, git, and more panes as needed. Keep Forest's pane structure |
| Server | One Bun process in one Docker container per deployment (one org), with SQLite on a mounted folder |
| Bridge | TypeScript, compiled to a single binary with Bun |
| Auth | Built-in username + password |
| Permissions | Org admin/member; per-machine Owner / Operator / Viewer; an Operator can be limited to folders and harnesses |
| AI logins | Each machine's own Claude/Codex login. CodeRail never holds credentials. At most it opens the harness's own login in a terminal on that machine |
| Privacy | No end-to-end encryption. The server sees and stores session content so sessions can be replayed when a client returns |
| Continuity | Agent sessions and terminals keep running when every client is gone. A returning client replays |
| Phone | First an installable web app (PWA) with web push, keeping Forest's phone layout. A better phone app later |
| Native clients | None: the web app and PWA are the client |
| Reuse | Copy Forest's Svelte components and adapt them as needed |
| Adapters | The upstream `claude-agent-acp` and `codex-acp`, unmodified. CodeRail is a remote screen for what runs locally: it adds no MCP server, no background jobs and no permission layer of its own, and it leaves each harness's own config, permissions and session history as they are |
| Local sessions | Sessions started in the machine's own terminal show in the list (from the harness's own history) and can be resumed. A CLI that's still running can't be watched live |
| Platforms | macOS first for the bridge. Linux and Windows later |
| Browser pane | Yes: Camofox on the machine, one per chat, its screen streamed through the server |
| Mac install | A signed menu bar app (`mac/`), downloaded from the deployment, with the bridge inside it, as Claude Desktop ships Claude Code. It copies the bridge to `~/.coderail/bin` when the version changes, links through the browser, and shows the bridge's state. `install.sh` stays for Linux and the terminal |

## Pieces

```
 web UI / PWA ──WSS──────────────────┐
                                    ▼
        Server (Bun, one container)  ── SQLite data/coderail.sqlite (users, machines, grants, auth sessions, pairing)
          │  serves the web UI, /api (auth, admin), the machine sockets
          ▼
        Hub "Machine" (one per computer, in the same process)
          • holds the bridge's socket and every client's socket
          • checks each call against the caller's role, then forwards it
          • fans events out to subscribed clients
          • keeps each agent session's event log (data/machines/<id>.sqlite) for replay
                                    ▲
 bridge on the computer ──WSS (outbound only)──┘
   • ACP client: spawns claude-agent-acp / codex-acp per session
   • PTYs, file system, git, harness detection and login terminals
```

Repo layout:

| Path | What |
|---|---|
| `server/` | The server: routes, auth, SQLite schema and migrations, the `Machine` hub, the web app's files (`Dockerfile`, `compose.yaml` at the root) |
| `web/` | Svelte 5 + Vite UI, copied from `forest/app/src`. `lib/machine.svelte.ts` replaces Forest's desktop IPC with a WebSocket client |
| `bridge/` | The Bun bridge: `coderail link <url>`, `coderail run`, service install (launchd / systemd / Windows service) |
| `adapters/` | The upstream `claude-agent-acp` and `codex-acp` at pinned versions, bundled into the bridge |
| `protocol/` | Shared TypeScript types for every method and event, used by all three |

## Protocol

JSON-RPC 2.0 over WebSocket. A client talks to one machine's hub at
`/api/machines/<id>/ws`. The hub adds the caller to every request it forwards
(`{user, role, scope}`), so the bridge also knows who asked, and it can apply folder limits itself
as a second check.

Method groups (protocol/src/index.ts `METHODS` is the full list, with who may call each):

| Group | Methods |
|---|---|
| (hub) | `sub`, `unsub` (topics: `machine`, `session:<id>`, `term:<id>`, `browser:<sessionId>`, `fs:<folder>`) |
| `machine.*` | `info` (OS, hostname, harnesses installed and their versions, online, the caller's scope) |
| `agent.*` | `sessions`, `history`, `approvals`, `tasks`, `local`, `harnesses`, `new`, `open`, `prompt`, `cancel`, `answer`, `set_mode`, `set_model`, `set_config`, `retitle`, `rename`, `forget`, `close`, `task_stop`. Events: ACP `session/update` passed through on `session:<id>`, approvals and background tasks on `machine` |
| `term.*` | `list`, `open`, `attach`, `write`, `resize`, `close`: scrollback on attach, and a terminal keeps running with no one attached |
| `fs.*` | `home`, `list`, `read`, `write` (`append` for an upload's later parts), `mkdir`, `rename`, `trash`, `chunk` (a byte range, for downloads), `zip` (a folder, for its download). The server's `/files` and `/zip` routes stream these over plain HTTP (docs/api.md), so the browser's own players and PDF viewer read any size by Range. The Files card shows pictures, video, sound, PDFs, fonts, Markdown, HTML (in a sandboxed frame), SVG, CSV/TSV and spreadsheets (tables; SheetJS), Word documents (mammoth, in a sandboxed frame), JSON, notebooks, a zip's list, code in colour, and any other file as hex; anything downloads, a folder as a .zip; files are uploaded by dropping them on the tree or with Upload files…; a folder listed is watched (not its subfolders) and a change in it comes as `fs:<folder>` to those who have it open, so the tree keeps up |
| `git.*` | GitHub Desktop's way of working. Read: `status` (with a merge, rebase, cherry-pick or revert stopped part way, conflict markers left, stashes, lines changed, the remote and its web page), `diff` (HEAD against the file now, staged, a commit, a stash; whitespace hidden or not), `file`, `log` (not-pushed commits marked; a range for Compare), `show`, `branches` (recent ones from the reflog, the default), `compare`, `stashes`, `tags`. Change (operators): `commit` takes the files and lines picked (`picks`), built in an index of its own so what was staged with `git add` stays staged, and a line pick is refused if the file changed since it was read; `undo`, `discard`, `discard_lines`, `ignore`, `checkout` (a branch, a new one, a remote one, a commit; changes stashed on the branch they were made on, GitHub Desktop's own mark, or brought along), `branch_rename`, `branch_delete`, `merge` (or squash), `rebase`, `continue`, `abort`, `resolve` (ours, theirs, resolved), `revert`, `cherry_pick`, `reset` (changes kept), `tag`, `stash`, `stash_apply`, `stash_drop`, `fetch`, `pull`, `push` (with lease to force, with tags), `init`, `clone`. One change at a time per repository; a folder-limited caller's git runs nothing the repository names (hooks, editors, signing, external diffs) |
| `gh.*` | GitHub through the computer's own `gh` sign-in (CodeRail never holds a token): `repo`, `pulls`, `pull` (the current branch's, or #n, with its checks), `diff`, and for operators `checkout`, `create` (pushes first), `merge` (the ways the repository allows, refused if the PR changed), `rerun`, `publish` (callers with no folder limits). Fixed calls only, cached briefly so many viewers make one call; never `gh api` from a client, never a browser on the computer |
| `harness.*` | `login` (the harness's own sign-in in a terminal, a device-code flow where one exists), `logout` |
| `browser.*` | `open`, `attach`, `resize`, `watch`, `navigate`, `go`, `input` (one-way), `close`: Camofox on the machine, one per chat session (keyed by its id, its own profile), its screen as JPEG frames on `browser:<sessionId>` to everyone in the chat. Operators and owners. The chat's agent drives the same browser through an MCP server the bridge hands each session (`bridge/src/browser-mcp.ts`) |

Panes, from Forest's `panes.svelte.ts`: keep `files`, `changes` (git, as GitHub Desktop: Changes with
files and lines to pick, History with Compare, Pull requests), `terminal`, `browser` and `background`.
Drop or rework `details`, `env`, `versions` and `docs`.

## Auth and permissions

- **Accounts.** Username + password, hashed with PBKDF2-SHA256 in WebCrypto with a per-user salt. Sign-in sets an HttpOnly, Secure, SameSite=Lax cookie,
  and the session row lives in SQLite. The PWA uses the same cookie.
- **First run.** While no user exists, `/setup` creates the first admin. It's guarded by a `SETUP_TOKEN`
  set in the server's environment, so a fresh deployment can't be claimed by a stranger. After that, users join
  only through invite links made by an admin.
- **Org roles.** Admin (manages users, invites, every machine's grants) and Member.
- **Machine roles**, granted per user per machine:
  - *Owner*: everything, including grants and removing the machine.
  - *Operator*: start and drive sessions, answer approvals, use files and git. It can be limited to
    folder prefixes and to harnesses. **The terminal is a separate yes/no grant**, because a shell
    escapes any folder limit.
  - *Viewer*: sees sessions, files and diffs read only. No approvals, no terminal.
- **Machines.** `coderail link https://your.domain` asks the server for a short code. You enter it
  in the UI (or open the link the bridge prints), and the user who approves becomes the Owner.
  The bridge gets a long random machine token, stored at `~/.coderail/` and hashed in SQLite. Machines
  can be revoked from the UI.
- **Audit.** Every call that changes something (prompt, approval, file write, git, terminal open)
  is recorded with who, which machine and when.

## History and continuity

- The bridge owns live state: ACP processes, PTYs and file watches. It keeps running with no
  client attached.
- The machine's hub keeps an append-only log per agent session (prompts, updates, approvals,
  results), capped by size. Clients replay from it even
  while the machine is offline (read only).
- On reconnect the bridge reports its live sessions and terminals, and the hub reconciles them.
  Claude Code and Codex sessions resume across bridge restarts through ACP `session/load`.
- Pending approvals go out as web push to every user allowed to answer them.

## Phases

1. **Skeleton.** Server + SQLite + auth (setup, sign-in, invites), the bridge's `link` and `run`,
   the machine list with presence, `machine.info`.
2. **Agents.** The adapters in the bridge, `agent.*`, the chat UI copied from Forest (Message,
   LiveTurn, Composer, AskCard), approvals, replay.
3. **The machine.** The terminal (xterm, from Forest's TermView), the files pane, the changes pane, git.
4. **Permissions UI**, the audit view, harness login help, the browser pane (Camofox, streamed).
5. **PWA + web push**, Forest's phone layout.
6. **A better phone app.**

## Open questions

1. **PTYs under Bun.** Bun's built-in terminal support and `node-pty` both need checking on
   macOS, Linux and Windows. This decides whether the bridge is truly one binary.
2. **Adapters under Bun.** `claude-agent-acp` drives the `claude` CLI through the Agent SDK, so it
   needs a check that it runs under Bun. Otherwise the bridge spawns it with the machine's Node.
