# groundcontrol — design

Discord-driven mission control for AI agents running in [hotcell](https://github.com/sinameraji/hotcell)
sandboxes on your own hardware. You `@mention` an agent bot (or use a slash
command) in your private Discord server; an orchestrator on your Mac creates an
isolated hotcell sandbox, runs a headless coding harness (OpenCode via
OpenRouter) inside it, and reports back in a per-mission Discord thread —
a PR link for coding missions, a private tailnet file link for research
missions. Then the sandbox is destroyed.

```
you (anywhere) ──@mention──▶ Discord ◀──outbound only── orchestrator (this repo)
                                                            │ drives
                                                        hotcell daemon ──▶ sandbox: OpenCode + OpenRouter
                                                            │                (provider key never inside)
                                                        mission folder on disk ──▶ tailscale serve (private links)
```

Security posture, in one breath: **no inbound ports** (the bot connects out to
Discord), **provider keys never enter sandboxes** (hotcell's egress gateway),
**GitHub credentials never enter sandboxes** (work leaves as a git bundle; the
host pushes and opens the PR), **artifact links are tailnet-only** (Tailscale
Serve), and **only the owner's Discord user id is obeyed**.

## Mission lifecycle

1. Owner mentions an agent bot (`@codey add rate limiting to <repo url>`) or
   uses `/code` · `/research`. Non-owner and bot-authored messages are ignored.
2. The engine creates a mission: id `m-YYYYMMDD-xxxx`, a folder
   `<ARTIFACTS_ROOT>/<id>/`, a `state.json`, and a Discord thread spawned from
   the request message — **named after the ask**, not the id (the id lives in
   `-#` message subtext; Discord is a conversation, not a terminal). Plain
   greetings ("hello", "thanks") get a conversational reply and never spawn a
   mission.
3. The mission enters a concurrency-capped queue (`MAX_CONCURRENT_MISSIONS`);
   if it can't start immediately the bot replies with its place in line.
4. A runner executes it inside a fresh hotcell sandbox (below). Progress is a
   **single self-editing status message** (plus the typing indicator) that is
   deleted when the result posts — the finished thread contains only the ask
   and the answer.
5. On finish: results posted (PR link / artifact links + summary + cost),
   `state.json` updated, sandbox destroyed. On failure/timeout/cancel: same,
   with the error. The mission folder is the durable record.

### Coding missions

1. `createSandbox({ repo, egress: true, spendCapUsd, setup: [OPENCODE_SETUP] })`
   — hotcell clones the repo into `/workspace/<name>` and wires the egress
   gateway (`OPENROUTER_BASE_URL` + a short-lived `hc-…` token inside; the real
   key stays on the daemon).
2. The full task prompt (persona + owner's ask + output contract) is written to
   `/workspace/.mission/task.md` via `writeFile` — never interpolated into a
   shell string.
3. `opencode run --dir '<repoDir>' -m 'openrouter/<model>'
   --dangerously-skip-permissions "$(cat /workspace/.mission/task.md)"` runs
   headless; the prompt instructs the agent to commit its work.
4. Post-run, inside the sandbox: commit any leftover changes on branch
   `mission/<id>`, then `git bundle create /workspace/.mission/out.bundle
   <base>..HEAD` (base = the repo's default branch).
5. The bundle leaves the sandbox base64-encoded over exec stdout and is saved
   to the mission folder. The **host** (`src/github.ts`) clones/fetches, pushes
   `mission/<id>`, and opens the PR with the host's authenticated `gh`.
6. Thread gets: PR link, the agent's final answer (truncated), cost.

### Research missions

1. `createSandbox({ egress: true, spendCapUsd, setup: [OPENCODE_SETUP] })` — no repo.
2. Task contract in the prompt: write the full report to
   `/workspace/out/report.md`, a ≤900-char `summary.md`, and any extra
   artifacts into `/workspace/out/`.
3. Same headless OpenCode run.
4. Everything under `/workspace/out/` is copied to the mission folder
   (base64 over exec, so binaries survive).
5. Thread gets: the summary inline + a private tailnet link per artifact, cost.

## Thread cells (v1.5)

A Discord thread is a conversation, so it keeps **one long-lived sandbox** —
its *cell* — instead of a fresh sandbox per message. This rides hotcell's
lifecycle FSM directly: cells are created with `sleepAfter`, auto-pause after
idle (**≈zero RAM while paused** — cold stop-with-volume on the container
driver, memory snapshot on microVMs; paused cells don't count against the
admission budget), and *any* operation transparently resumes them — minutes or
weeks later. The workspace is the conversation's memory: the repo clone, past
reports (`/workspace/history/`), and any notes the agent left survive between
missions.

Mapping lives in `<ARTIFACTS_ROOT>/threads.json` (`src/missions/cells.ts`,
atomic writes; the daemon's sandbox list is the source of truth — this file is
just the address book).

**Engine owns the whole lifecycle** (runners never call `usage()` or
`destroy()`):

1. Resolving: mission in thread T → `cells.get(T)` → `attachSandbox(id)`;
   a vanished sandbox (daemon reset) drops the stale mapping and the runner
   creates fresh. Thread context (`poster.fetchContext`) is fetched for every
   threaded mission and included in the task prompt.
2. Completion — success *or* ordinary failure: snapshot cumulative sandbox
   usage; **per-mission cost = cumulative − cell's recorded baseline**; upsert
   the cell (sandboxId, lastUsedAt, missionCount, new totals). The sandbox is
   left running; `sleepAfter` pauses it. Missions without a thread (thread
   creation failed) keep v1 behavior: usage → destroy.
3. Cancel / timeout: the sandbox is destroyed **and the cell mapping removed**
   — destroy is the only reliable interrupt, so the thread starts a fresh cell
   next time (the thread message says so).
4. Restart orphans: a recorded sandbox is destroyed **only if it isn't some
   thread's current cell** — conversations survive orchestrator deploys.
5. Reaping: the janitor destroys cells idle past `CELL_MAX_IDLE_DAYS`
   (default 30) and prunes their mappings.

Runner deltas: reuse `ctx.cellSandbox ?? createSandbox(… sleepAfterMs …)`;
coding ensures the repo exists in a reused cell (`git clone` if missing,
`fetch` if present); research archives the previous `/workspace/out` into
`/workspace/history/<timestamp>/` before starting. Spend caps are per-sandbox,
so **a cell's cap is the conversation's budget**, not one message's.

## Module map

| Path | Owns |
|---|---|
| `src/types.ts` | all cross-module types (the contract — do not widen casually) |
| `src/config.ts` | env + agents-file loading, validation |
| `src/missions/store.ts` | mission ids, folders, `state.json` persistence, orphan sweep |
| `src/missions/cells.ts` | threadId → cell (long-lived sandbox) mapping, `threads.json` |
| `src/missions/queue.ts` | concurrency-capped FIFO queue |
| `src/missions/runner.ts` | `MissionEngine` — the seam: queue+store+runners+Discord+timeout |
| `src/hotcell.ts` | thin wrapper over `@hotcell/sdk` + OpenCode setup/run command builders |
| `src/runners/coding.ts` | coding mission flow (above) |
| `src/runners/research.ts` | research mission flow (above) |
| `src/github.ts` | host-side: bundle → push branch → `gh pr create` |
| `src/discord/manager.ts` | one discord.js Client per agent; mention + slash handling; owner gate |
| `src/discord/format.ts` | pure message-formatting helpers (2000-char safe) |
| `src/discord/register.ts` | slash-command registration per agent app |
| `src/files/server.ts` | read-only static server for `ARTIFACTS_ROOT`, loopback-bound |
| `src/files/links.ts` | mission-relative path → public tailnet URL |
| `src/janitor.ts` | docker prune + oversized-old-artifact pruning |
| `src/index.ts` | CLI: `start` · `janitor` · `register-commands` |
| `ops/` | launchd plists (orchestrator, hotcell daemon, janitor), install script, runbook |

## Security invariants (hold these when changing code)

- **Owner gate**: every message/interaction handler checks
  `author.id === config.ownerId` and ignores bot authors (prevents bot loops).
- **No prompt-in-shell**: task text reaches the sandbox via `writeFile` only.
  Anything else interpolated into an exec string goes through `shellQuote`.
- **File server**: GET/HEAD only; resolves paths with `realpath` and refuses
  anything outside `ARTIFACTS_ROOT` (traversal + symlink safe); binds
  `127.0.0.1` — exposure happens only via `tailscale serve`, which is
  tailnet-private. Artifacts are sandbox-authored, so they are never served as
  active content: html/svg/js go out as `text/plain`, every response carries
  `X-Content-Type-Options: nosniff` and a deny-all CSP (`default-src 'none';
  sandbox`) — a booby-trapped report can't script the origin and read the
  archive.
- **Secrets**: only ever in `.env` (gitignored) or the macOS keychain via
  hotcell. Nothing in this repo, nothing in mission folders, nothing in
  sandboxes.
- **Mission ids** are generated `[a-z0-9-]` and are the only things used in
  paths, branch names, and URLs.

## Capacity & safety rails

- Orchestrator: `MAX_CONCURRENT_MISSIONS` (default 2) — excess missions queue
  with a visible position.
- hotcell: admission control refuses sandbox creation when host memory budget
  is exhausted; per-sandbox cgroup caps available via daemon config.
- Money: per-mission egress spend cap (`MISSION_SPEND_CAP_USD`, default $5) —
  a runaway agent burns its cap, not the account.
- Time: `MISSION_TIMEOUT_MINUTES` (default 45) — on timeout the sandbox is
  destroyed and the mission fails visibly in the thread.
- Janitor (weekly launchd job): `docker system prune -f`, delete mission
  artifacts over `JANITOR_MAX_ARTIFACT_MB` once older than
  `JANITOR_ARTIFACT_MAX_AGE_DAYS`. Small text artifacts are kept forever —
  the mission history is the point.

## v1 / v2 line

**v1**: several named agent bots; each mission is one isolated sandbox;
results as PR links / private file links in a per-mission thread.

**v1.5 (this)**: thread cells — one persistent, auto-pausing sandbox per
conversation, with thread messages fed to the prompt, so follow-ups have both
conversational and workspace memory.

**v2 (rails already laid)**: agents read each other's mission folders and hand
off (`@codey` builds what `@scout` researched). Cells already allow a second
agent to join a thread and inherit its workspace; v2 adds deliberate handoffs,
a hop cap, and cross-thread artifact sharing.
