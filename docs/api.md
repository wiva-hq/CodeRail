# CodeRail HTTP API

All JSON. Auth is the `__Host-cr_session` cookie (HttpOnly; plain `cr_session` over http in development) set by
setup, login and signup. Sign-in, sign-up, setup and `/api/pair/start` allow 10 tries a minute per address. Errors are
`{error: string}` with a 4xx/5xx status. The machine WebSocket protocol is in
`protocol/src/index.ts`.

## Account

| Method | Path | Body | Answer |
|---|---|---|---|
| GET | `/api/me` | | `{user: {id, username, isAdmin} \| null, setup: boolean}`. `setup` is true while no user exists |
| POST | `/api/setup` | `{token, username, password}` | `{user}`. Only while no user exists. `token` is the server's `SETUP_TOKEN` |
| POST | `/api/login` | `{username, password}` | `{user}` |
| POST | `/api/logout` | | `{ok}` |
| POST | `/api/password` | `{current, next}` | `{ok}` |
| GET | `/api/invites/:code` | | `{valid, isAdmin}` (no sign-in needed) |
| POST | `/api/signup` | `{code, username, password}` | `{user}` |

Usernames: 2-32 of `a-z 0-9 _ . -`. Passwords: at least 8 characters.

## Admin

| Method | Path | Body | Answer |
|---|---|---|---|
| GET | `/api/users` | | `[{id, username, isAdmin, disabled, createdAt}]` (any signed-in user may list, to grant access) |
| PATCH | `/api/users/:id` | `{isAdmin?, disabled?}` | `{ok}` (admin) |
| DELETE | `/api/users/:id` | | `{ok}` (admin) |
| GET | `/api/invites` | | `[{code, isAdmin, createdAt, expiresAt, createdBy}]` (admin, unused only) |
| POST | `/api/invites` | `{isAdmin}` | `{code, url, expiresAt}` (admin; 7 days) |
| DELETE | `/api/invites/:code` | | `{ok}` (admin) |
| GET | `/api/audit?machine=&user=&kind=&page=&size=` | | `{rows: [{at, username, machineId, machineName, action, detail}], page, size, more}`, newest first; `kind` is prompts, files, git, terminals or access; pages of `size` (10–200, default 50). Admins see all, owners their machines |
| GET | `/api/settings` | | `{auditDays}` (admin): how long the audit log keeps entries, 30, 90 (default), 365 or 0 (forever) |
| PATCH | `/api/settings` | `{auditDays}` | `{auditDays}` (admin); older entries are deleted then, and daily by the cron trigger |

## Machines

| Method | Path | Body | Answer |
|---|---|---|---|
| GET | `/api/machines` | | `MachineSummary[]`: the machines the user has a grant on (admins: all, as owner) |
| PATCH | `/api/machines/:id` | `{name}` | `{ok}` (owner) |
| DELETE | `/api/machines/:id` | | `{ok}` (owner): revokes its token and disconnects it |
| GET | `/api/machines/:id/grants` | | `[{userId, username, role, folders, harnesses, terminal}]` (owner) |
| PUT | `/api/machines/:id/grants/:userId` | `{role, folders: string[]\|null, harnesses: string[]\|null, terminal}` | `{ok}` (owner). Folders are absolute paths. A terminal grant is a full shell as the computer's user, past any folder limit, so treat it as owner-level trust. |
| DELETE | `/api/machines/:id/grants/:userId` | | `{ok}` (owner) |
| GET (WS) | `/api/machines/:id/ws` | | the machine socket |
| GET, HEAD | `/api/machines/:id/files?path=&download=` | | A file's bytes, streamed from the computer (the bridge's `fs.chunk`, 512 KB at a time), with `Range`, `ETag` and `If-Range`, for the web app's viewers (video and sound seek, PDFs open) and downloads. Any role; the caller's folder limits apply as on the socket. `download` saves it (and is audited as `fs.download`). Only raster pictures, video, sound, PDFs and fonts are shown inline; everything else is an attachment, always with `nosniff` and a `sandbox` Content-Security-Policy (PDFs excepted), since the bytes come from the app's own address |
| POST | `/api/machines/:id/zip` | `{path}` | `{zip, name, size}`: the folder zipped on the computer, in its temp folder (links and CodeRail's own folder left out; at most 50,000 files and 3.5 GB). Audited as `fs.zip` |
| GET, HEAD | `/api/machines/:id/zip/:zip?name=` | | That zip's bytes, as `/files` streams a file (an attachment). Only its maker may read it; it is deleted after 15 minutes |

## Linking a computer

The bridge runs `coderail link https://<host>`. It calls `POST /api/pair/start {name, info}` and gets
`{code, secret, url}`, prints the code and opens `url` (`/link?code=…`). The signed-in user confirms:

| Method | Path | Body | Answer |
|---|---|---|---|
| GET | `/api/pair/:code` | | `{code, name, info, expiresAt}` |
| POST | `/api/pair/:code/approve` | `{name}` | `{machineId}`: the approver becomes the machine's owner |

The bridge polls `POST /api/pair/poll {code, secret}` until it gets `{machineId, token}`, then connects to
`GET (WS) /api/bridge` with `Authorization: Bearer <token>`.

## Push

| Method | Path | Body | Answer |
|---|---|---|---|
| GET | `/api/push/key` | | `{publicKey}` (VAPID, base64url) or `{publicKey: null}` when push is not set up |
| POST | `/api/push/subscribe` | `{subscription}` (PushSubscription JSON) | `{ok}` |
| POST | `/api/push/unsubscribe` | `{endpoint}` | `{ok}` |

A push's payload is `{title, body, url}`; the service worker shows it and opens `url` on click.

## Pages (the SPA's routes)

`/` machines · `/m/:id` a machine · `/m/:id/s/:sessionId` a session on it · `/link?code=` approve a
computer · `/invite/:code` sign up · `/setup` first admin · `/settings` account, users, invites, audit.
