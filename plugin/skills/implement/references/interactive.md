# Interactive loop

Phase D reviewed live in the browser instead of in chat. Needs a runtime with background tasks and a persistent WebSocket monitor (Claude Code today) — without both, use chat-only review (`--no-interactive-loop`).

The state folder `<repo>/.webmcp/` is the single source of truth — the Explorer page is a live view of it. Never send content over the socket or paste tool code into chat: write the files, the watcher renders them. NDJSON lines are terse single lines with ISO-8601 `ts` (`date -u +%Y-%m-%dT%H:%M:%SZ`).

## State folder (git-tracked — ADR-0003)

- `plan.json` — the interactive plan: `{"journey","site","suggestions":[{"id","name","description","why","status","params":[{"name","type","description"}]}]}`. `site` is a short label for the site or page the tools serve (e.g. `coupling.dev`) — the Explorer titles the map's site node with it; without it the node falls back to ellipsizing the journey paragraph, which reads badly. `journey` stays the full narrative. A tool suggestion is metadata + the why — **no implementation code**. Write `why` as one short plain sentence a non-engineer understands: say which user need this tool serves, with no jargon and without restating the tool name. Keep each `status` current at every transition (proposed → building → review → approved, or `declined` when the developer leaves it out): the Explorer renders each suggestion's lifecycle from it, so a stale status is a lie on screen — and the committed record must say which suggestions were declined, not merely never reached.
- `_status.ndjson` — you append phase transitions `{"ts","phase"}` (propose | build | review | verify | done) and build steps `{"ts","suggestion","step","state"}` (step: code | verify; state: start | done). A finished verify step also carries the skill's conclusion: `"outcome":"verified|failed|could-not-verify"`. A `phase` line flips the page; a `step` line animates one suggestion's chips — never confuse the two shapes.
- `_chat.ndjson` — you append replies `{"ts","from":"claude","re":"<suggestion id|null>","text"}`.
- `_feedback.ndjson` — server-owned: every user event. Never write it. Only `comment` / `submit` / `feedback` / `approve` reach your Monitor; `pick` lands on disk only.
- `<id>.code.md` — named after the suggestion's `id`: the built tool module's code in a fenced block, for the Explorer's read-only code view. The real artifact is the tool module in the customer source tree.

## Startup

1. Start the server as a **background Bash task** (`run_in_background`, not `&`/`disown` with a log file — its stdout must stay readable to you): `bun <this skill's dir>/interactive/server.ts <repo root>`. It creates `.webmcp/`, binds a free port, watches the folder and relays page events.
2. Take **your** port from that task's output (`webmcp-explorer on http://localhost:<port>`). `.webmcp/.port` holds the same value — unless the server warned that another interactive loop is already live, in which case `.port` stays that one's; say so before continuing.
3. Open the page for the user: `open http://localhost:<port>` (skip when a robot or headless client drives).
4. Arm a Monitor on `ws://localhost:<port>/ws?role=claude`, `persistent: true`. Each user action arrives as one JSON-line notification. Do not stop it before phase `done`.

## Phases

1. **Propose** — after A–C, write `plan.json`, append phase `propose`, tell the user to decide in the Explorer, end your turn.
2. **Decide** — on each `comment`: append one short `_chat.ndjson` reply saying how you'll use it, and revise `plan.json` when the note changes a suggestion. Picks are disk-only — you never see them. End your turn.
3. **Build** — `submit` is the Phase-D approval. Append phase `build` and set every suggestion the developer left out of the picks to status `declined`. Then per approved suggestion, in order: status `building` in `plan.json` → `code start` → write the tool module as `<srcroot>/webmcp/<id>.<ext>` **and** its `<id>.code.md` review copy (same id, so the Explorer can pair them) → `code done` → `verify start` → the skill's static checks → `verify done` with the `outcome` those checks reached → status `review`. Batch consecutive status appends into one `printf`. A `comment` or `feedback` mid-build: reply in `_chat.ndjson` immediately, apply it if that suggestion isn't built yet, otherwise say you queued it and apply it first thing in review; then continue. Every suggestion built **and** its verify outcome recorded → append phase `review`, end your turn.
4. **Review** — on each plain `comment`: reply in `_chat.ndjson` and apply it as plan-level feedback. On each `feedback` about a **built** suggestion: revise the tool module and its `<id>.code.md`, rerun the static checks and append a fresh `verify done` with its `outcome` (an edit can break what was green — the old chip must not stand), append a `_chat.ndjson` reply saying exactly what changed, stay in phase `review`, end your turn. Unlimited rounds.
5. **Verify** — on `approve`: set every shipped suggestion's status to `approved`, append phase `verify`, then finish per the skill's normal completion. Only static checks run before review; the **full Phase F ladder (boot, registration, invocation) runs here, after final approval**. As it runs, append fresh per-suggestion `verify start` / `verify done` lines (the latter with its final `outcome`) to `_status.ndjson`, so the Explorer's chips track the real ladder; then branch and PR. The PR includes `.webmcp/` — the plan, the why per tool, the approval trail.
6. **Done** — only after the PR exists, append phase `done`, then tear down the loop. Never write `done` while verification or PR creation is still underway.

## Rules

- **Wake model.** Ending your turn while the loop is live is correct — Monitor notifications re-invoke you. Never TaskStop the monitor before phase `done`.
- Monitor events are user actions, not chat replies. They carry their payload, but `.webmcp/` is the truth — when in doubt, re-read it.
- **Tool requests.** A `comment` whose text starts with `Tool request:` asks for a new capability: reply in `_chat.ndjson`; during `propose`, add or revise its suggestion in `plan.json`; after `submit`, treat it as a plan change — add it as `proposed`, then follow the explicit-go rule for restoring a declined suggestion below.
- **`declined` is terminal for this run.** A `comment` or `feedback` naming a declined suggestion earns a `_chat.ndjson` reply and nothing else — no build, no module. If the developer explicitly asks for it back, that is a plan change: set it to `proposed`, and build it only on an explicit go (a fresh `submit` or an unambiguous confirmation). Never infer Phase-D approval from a comment.
- **Phase-D carve-out (ADR-0003).** In the interactive loop the state folder `.webmcp/` is exempt from the skill's "nothing before approval" gate: it *is* the approval mechanism. Tool modules, dependencies and branches stay gated on `submit`.
- **Teardown**, after phase `done`, in order: TaskStop the monitor **first** → `curl -X POST http://localhost:<port>/shutdown` → `lsof -iTCP:<port> -sTCP:LISTEN` to confirm nothing listens (expect empty). Shutting down first kills the ws, the monitor self-terminates, and the later TaskStop errors.
- **Recovery.** Server or monitor died: restart the server, take the port from **its** stdout (`.webmcp/.port` is only yours when that server claimed it), re-arm the Monitor, then read the tail of `_feedback.ndjson` — events that arrived while you were disconnected are on disk but were never relayed.
