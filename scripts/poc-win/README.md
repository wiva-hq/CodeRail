# Windows Phase 1 PoCs

Gate 1 cancellation blocker replay: the complete `codex` suite passed 12/12 on
Windows 11 x64 / Bun 1.4.4. See `docs/windows-bridge-gate1-blocker.md` and the
`evidence/2026-10-26-gate1-*` files. Default architecture: one ACP worker per
logical session, owned by a Job, protocol cancellation followed by bounded
worker recovery. The shared-runtime command Job is an exclusive-approval optimization.

Run from the repository root. No global Bun install or administrator token is required:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/poc-win/run.ps1 all
```

Requirements: Windows x64 with ConPTY, Node/npm/npx, and a signed-in Codex CLI available on PATH.
The runner installs repository dependencies from `bun.lock` when absent, installs this directory's
isolated `node-pty@1.1.0` dependency from `package-lock.json`, and executes every test using Bun 1.4.4.
`pwsh.exe` is tested when discoverable; Windows PowerShell and cmd are always tested.

Individual suites:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/poc-win/run.ps1 runtime
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/poc-win/run.ps1 terminal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/poc-win/run.ps1 codex
```

Optional targeted replay (SKIP is explicit and is never a PASS):

```powershell
$env:POC_FILTER = 'command-approval|session-job|approval-command-job'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/poc-win/run.ps1 codex
Remove-Item Env:POC_FILTER
```

The Codex suite performs real inference using the current user's login/config and default model.
It creates only new test sessions and temporary workspaces, approves only the named local test
fixture, and never attaches to existing user chats. Durable test histories remain in Codex for
recovery inspection. Authentication tokens and account email are not printed.

JSON-line output and raw stdout/stderr are saved under ignored `artifacts/`, with a timestamped
log for each run. Generated protocol bindings, executables and fixture PID files also live there.
The checked-in `evidence/` snapshot records the observed results, including failures.

**Exit code 1 is intentional when a reproduction fails its acceptance assertion.** At the initial
Phase 1 audit, direct FFI ConPTY output and Codex nested-command cancellation failed. Do not weaken
those assertions to make the gate green. Historical console-signal experiments are retained
for audit only and are excluded from the active suite. Do not run them as a cancellation strategy.

Job tests bind suspended processes before resume. A Bun terminal-worker fixture verifies that
subsequent ConPTY descendants inherit the Job. Crash tests intentionally terminate only the owner,
then use CIM to prove kernel-driven cleanup. Normal fixture teardown uses Job closure or
`taskkill /F /T`. The current cancellation tests use approval-owned command Jobs or independent
session Jobs. Fixture PID files serve only as assertion oracles, never as cleanup inputs.
Successful assertions run before emergency teardown; tests never terminate arbitrary user processes.

PoC-only static check:

```powershell
node bridge/node_modules/typescript/bin/tsc -p scripts/poc-win/tsconfig.json
```

These scripts do not enable the Windows bridge adapter. See `docs/windows-bridge-phase1.md` for
architecture decisions, exact evidence, limitations and Gate 1 status.
