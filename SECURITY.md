# Security

## Reporting a vulnerability

Please **don't open a public issue** for a security problem. Report it privately through GitHub:
[Report a vulnerability](https://github.com/wiva-hq/CodeRail/security/advisories/new).

Include what you found, how to reproduce it, and what an attacker could do with it. You'll get an
answer within a few days, and credit in the advisory once it's fixed, if you'd like.

## Scope

CodeRail gives the people you authorize control of your computers, so these matter most:

- the server: sign-in, sessions, invites, roles and per-computer permissions, the audit log;
- the link between the server and a computer: pairing, machine tokens, the relay;
- the bridge: folder limits, terminals, file and git access, the browser (Camofox);
- the builds: the Mac app, its updates, the download host and `install.sh`.

Out of scope: Claude Code, Codex and the other software CodeRail runs, and problems that need an
account that's already been given the access in question (an Owner can, by design, run commands on
their own computer).

## Supported versions

Only the newest build gets fixes; the Mac app updates itself, and `install.sh` always installs the
newest bridge.
