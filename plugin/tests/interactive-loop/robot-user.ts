// Robot user for the interactive loop (NEK-693, ported from spike NEK-672): plays the
// Explorer's page role end to end. Waits for the interactive plan, picks 2 (and deselects a
// third), submits, interjects mid-build, runs 2 deterministic feedback rounds, approves.
// Exit 0 = full loop passed. Run: bun robot-user.ts <repo root>
// (the server must be up in that repo; a Claude session must be driving the loop)
//
// Reruns against a non-fresh state folder are safe: every wait is baselined against the
// lines already there, and the feedback markers carry a per-run nonce.
// Source-tree assertion: the skill writes tool modules to `<srcroot>/webmcp/`, so the robot
// looks for the round-1 marker in the conventional locations first and only then walks the
// whole tree (throttled — a real repo carries node_modules/.git), skipping `.webmcp/`.

import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { connect as tcpConnect } from "node:net";
import { join, sep } from "node:path";

const root = process.argv[2] ?? process.cwd();
const runFile = join(root, ".webmcp", ".run.json");
const DEADLINE_MS = Number(process.env.ROBOT_DEADLINE_MS ?? 600_000);
const STEP_TIMEOUT_MS = Number(process.env.ROBOT_STEP_TIMEOUT_MS ?? 180_000);
const NONCE = process.env.ROBOT_NONCE ?? Date.now().toString(36).slice(-6);

let files: Record<string, string> = {};
let waiter: { desc: string; pred: () => boolean; resolve: () => void } | null = null;

function ndjson(name: string): any[] {
  return (files[name] ?? "").split("\n").filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}
const phase = () => {
  const p = ndjson("_status.ndjson").filter((e) => e.phase);
  return p.length ? p[p.length - 1].phase : "boot";
};
const chatCount = () => ndjson("_chat.ndjson").length;
const statusLines = () => ndjson("_status.ndjson");
const handled = (eventId: string) => ndjson("_ack.ndjson").some(
  (entry) => entry.run_id === run.run_id && entry.event_id === eventId && entry.status === "handled",
);
const plan = () => {
  try { return JSON.parse(files["plan.json"]); } catch { return null; }
};
const suggestion = (id: string) => (plan()?.suggestions ?? []).find((s: any) => s.id === id);

// The tool module for one suggestion — the real artifact, not the .code.md review copy:
// a file under a webmcp/ dir whose name is the suggestion's id (any extension).
const CONVENTIONAL = ["src/webmcp", "app/webmcp", "webmcp", "assets/webmcp"];
const SKIP_DIRS = new Set(["node_modules", ".git", ".webmcp", "dist", "build", ".next", "vendor"]);
let lastWalk = 0;

function walk(dir: string, out: string[], depth = 0): string[] {
  if (depth > 8) return out; // pruned before descending: a dependency tree must not stall the poll
  let names: { name: string; isDirectory(): boolean }[] = [];
  try { names = readdirSync(join(root, dir), { withFileTypes: true }); } catch { return out; }
  for (const e of names) {
    const rel = dir ? join(dir, e.name) : e.name;
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(rel, out, depth + 1); }
    else out.push(rel);
  }
  return out;
}

function toolModuleFor(id: string, marker: string): string | null {
  const named = (rel: string) => {
    const base = rel.split(sep).pop() ?? "";
    return base === id || base.startsWith(`${id}.`);
  };
  const carries = (rel: string) => {
    try { return readFileSync(join(root, rel), "utf8").includes(marker) ? rel : null; } catch { return null; }
  };
  for (const dir of CONVENTIONAL) {
    for (const rel of walk(dir, [])) if (named(rel)) { const hit = carries(rel); if (hit) return hit; }
  }
  if (Date.now() - lastWalk < 2000) return null; // full walk is expensive; throttle it
  lastWalk = Date.now();
  for (const rel of walk("", [])) {
    if (!rel.includes(`webmcp${sep}`) || !named(rel)) continue;
    const hit = carries(rel);
    if (hit) return hit;
  }
  return null;
}

function check() {
  if (waiter && waiter.pred()) {
    console.log(`ok: ${waiter.desc}`);
    const r = waiter.resolve;
    waiter = null;
    r();
  }
}
function waitFor(desc: string, pred: () => boolean): Promise<void> {
  console.log(`wait: ${desc}`);
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      console.error(`TIMEOUT waiting for: ${desc}`);
      console.error(`phase=${phase()} files=${Object.keys(files).join(",")}`);
      process.exit(1);
    }, STEP_TIMEOUT_MS);
    waiter = { desc, pred, resolve: () => { clearTimeout(t); resolve(); } };
    check();
  });
}

type Run = { version: 1; run_id: string; capability: string; workspace: string; port: number; pid: number; started_at: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function liveRun(): Run | null {
  try {
    const value = JSON.parse(readFileSync(runFile, "utf8"));
    if (Object.keys(value).sort().join(",") !== "capability,pid,port,run_id,started_at,version,workspace") return null;
    if (value.version !== 1 || value.workspace !== realpathSync(root)) return null;
    if (!UUID.test(value.run_id) || !UUID.test(value.capability) || value.run_id === value.capability) return null;
    if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) return null;
    if (!Number.isSafeInteger(value.pid) || value.pid < 1) return null;
    if (typeof value.started_at !== "string" || new Date(value.started_at).toISOString() !== value.started_at) return null;
    return value;
  } catch {
    return null;
  }
}

let port = 0;
let run: Run;
type Recorded = { type: "recorded"; request_id: string; event_id: string; run_id: string; order: number };
const requestWaiters = new Map<string, { resolve: (value: Recorded) => void; reject: (error: Error) => void }>();

function receive(raw: unknown) {
  const m = JSON.parse(String(raw));
  if (m.type === "recorded" && typeof m.request_id === "string") {
    const waiter = requestWaiters.get(m.request_id);
    if (waiter) {
      requestWaiters.delete(m.request_id);
      if (m.run_id === run.run_id) waiter.resolve(m as Recorded);
      else waiter.reject(new Error(`recorded wrong run ${m.run_id}`));
    }
    return;
  }
  if (m.type === "error") {
    const waiter = requestWaiters.get(m.request_id);
    if (waiter) {
      requestWaiters.delete(m.request_id);
      waiter.reject(new Error(m.message ?? "server rejected request"));
    }
    return;
  }
  if (m.type === "snapshot") { files = m.files; check(); }
  if (m.type === "file" && typeof m.name === "string") {
    if (m.text === null) delete files[m.name];
    else if (typeof m.text === "string") files[m.name] = m.text;
    check();
  }
}

async function connect(): Promise<WebSocket> {
  for (let i = 0; i < 120; i++) {
    const candidate = liveRun();
    if (candidate) {
      try {
        run = candidate;
        port = candidate.port;
        const query = new URLSearchParams({ role: "page", capability: run.capability, run_id: run.run_id });
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?${query}`);
        ws.onmessage = (event) => receive(event.data);
        await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("ws error")); });
        console.log(`connected to run ${run.run_id} on port ${port}`);
        return ws;
      } catch {}
    }
    await Bun.sleep(1000);
  }
  console.error(`no live run behind ${runFile}`);
  process.exit(1);
  throw new Error("unreachable");
}

setTimeout(() => { console.error("GLOBAL DEADLINE exceeded"); process.exit(1); }, DEADLINE_MS);

const ws = await connect();
function send(type: string, payload: unknown): Promise<Recorded> {
  const requestId = crypto.randomUUID();
  const request = { request_id: requestId, type, payload };
  console.log(`send: ${JSON.stringify(request)}`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      requestWaiters.delete(requestId);
      reject(new Error(`TIMEOUT waiting for recorded response to ${type}`));
    }, STEP_TIMEOUT_MS);
    requestWaiters.set(requestId, {
      resolve: (value) => { clearTimeout(timer); console.log(`recorded: ${value.event_id} order=${value.order}`); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    ws.send(JSON.stringify(request));
  });
}
setInterval(check, 300); // some predicates read the source tree, which sends no snapshot

// 1. the interactive plan appears
await waitFor("interactive plan with >= 3 tool suggestions + phase propose", () =>
  (plan()?.suggestions ?? []).length >= 3 && phase() === "propose");
const [a, b, c] = plan().suggestions;

// 2. pick two, take a third and put it back (deselection must not build it), comment on the
//    first, expect a live ack in _chat
await send("pick", { suggestion: a.id, picked: true });
await send("pick", { suggestion: b.id, picked: true });
await send("pick", { suggestion: c.id, picked: true });
await send("pick", { suggestion: c.id, picked: false });
const chatBeforeNote = chatCount();
const noteEvent = await send("comment", { suggestion: a.id, text: "keep this one read-only" });
await waitFor("chat ack for the pre-build comment", () => chatCount() > chatBeforeNote);
await waitFor("handled ack for the pre-build comment", () => handled(noteEvent.event_id));

// 3. submit, then interject while Claude is mid-build (baselined: only lines appended
//    after this submit count, so a previous run's build can't satisfy the wait)
const statusAtSubmit = statusLines().length;
const submitEvent = await send("submit", { picks: [{ suggestion: a.id, note: "keep this one read-only" }, { suggestion: b.id, note: "" }] });
await waitFor("build started", () => statusLines().slice(statusAtSubmit).some((e) => e.state === "start"));
await waitFor("handled ack for submit acceptance", () => handled(submitEvent.event_id));

// 3b. by the FIRST build-start update the deselected suggestion must already read
//     `declined` — an implementation must not leave it `proposed` all build and flip it
//     just before review
const buildStartSuggestion = (JSON.parse(readFileSync(join(root, ".webmcp", "plan.json"), "utf8")).suggestions ?? [])
  .find((s: any) => s.id === c.id);
if (buildStartSuggestion?.status !== "declined") {
  console.error(`FAIL: at build start, deselected ${c.id} status is ${buildStartSuggestion?.status}, expected declined`);
  process.exit(1);
}
console.log(`ok: deselected ${c.id} already declined at the first build-start update`);

const chatBeforeMid = chatCount();
const midBuildEvent = await send("comment", { suggestion: b.id, text: "mid-build note: name the params exactly as planned" });

// 4. both tool modules built (code.md review copies), phase review reached by THIS build,
//    mid-build comment answered
await waitFor("both code.md review copies + phase review", () =>
  !!files[`${a.id}.code.md`] && !!files[`${b.id}.code.md`] &&
  statusLines().slice(statusAtSubmit).some((e) => e.phase === "review") && phase() === "review");
await waitFor("chat reply to the mid-build comment", () => chatCount() > chatBeforeMid);
await waitFor("handled ack for the mid-build comment", () => handled(midBuildEvent.event_id));

// 4b. the deselected suggestion was never built and stayed out of the build steps
if (files[`${c.id}.code.md`]) { console.error(`FAIL: deselected ${c.id} was built`); process.exit(1); }
if (statusLines().slice(statusAtSubmit).some((e) => e.suggestion === c.id)) {
  console.error(`FAIL: deselected ${c.id} has build steps`); process.exit(1);
}
console.log(`ok: deselected ${c.id} not built, no build steps`);

// 5. feedback round 1: a per-run marker, so a previous run's marker can't satisfy it —
//    checked in the review copy AND in the real tool module under the source tree
const marker = `// robot-check-${NONCE}`;
const feedbackOne = await send("feedback", { suggestion: a.id, text: `add the exact comment line ${marker} to the ${a.id} tool module` });
await waitFor(`${a.id}.code.md contains ${marker}`, () => (files[`${a.id}.code.md`] ?? "").includes(marker));
let modulePath: string | null = null;
await waitFor(`the ${a.id} tool module under the source tree contains ${marker}`,
  () => !!(modulePath = toolModuleFor(a.id, marker)));
console.log(`tool module carrying the feedback: ${modulePath}`);
await waitFor("handled ack for feedback round 1", () => handled(feedbackOne.event_id));

// 6. feedback round 2: checkable in the interactive plan
const desc = `ROBOT-DESC-${NONCE}`;
const feedbackTwo = await send("feedback", { suggestion: b.id, text: `set the description of ${b.id} to exactly: ${desc}` });
await waitFor(`${b.id} description == ${desc}`, () => suggestion(b.id)?.description === desc);
await waitFor("handled ack for feedback round 2", () => handled(feedbackTwo.event_id));

// 7. every built suggestion carries a verify outcome before approval is possible
const verified = (id: string) => statusLines().slice(statusAtSubmit).some(
  (e) => e.suggestion === id && e.step === "verify" && e.state === "done" && !!e.outcome);
await waitFor(`${a.id} and ${b.id} have a verify outcome`, () => verified(a.id) && verified(b.id));

// 8. approve → verify → done (again, only transitions appended after this run's submit count),
//    the built suggestions end `approved`, and teardown actually frees the port —
//    ECONNREFUSED, not a timeout: an unresponsive listener is still a listener
function portReleased(): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = tcpConnect({ host: "127.0.0.1", port });
    const done = (v: boolean) => { sock.destroy(); resolve(v); };
    sock.setTimeout(1000, () => done(false));
    sock.once("connect", () => done(false));
    sock.once("error", (err: NodeJS.ErrnoException) => done(err.code === "ECONNREFUSED"));
  });
}
let portFree = false;
const approveEvent = await send("approve", {});
await waitFor("phase verify", () =>
  statusLines().slice(statusAtSubmit).some((e) => e.phase === "verify"));
await waitFor("handled ack for approval acceptance", () => handled(approveEvent.event_id));
setInterval(async () => {
  if (!portFree && (await portReleased())) {
    portFree = true;
    check();
  }
}, 500);
await waitFor("phase done", () =>
  statusLines().slice(statusAtSubmit).some((e) => e.phase === "done") && phase() === "done");
await waitFor(`${a.id} and ${b.id} status == approved, ${c.id} still declined`, () =>
  suggestion(a.id)?.status === "approved" && suggestion(b.id)?.status === "approved" &&
  suggestion(c.id)?.status === "declined");
await waitFor(`port ${port} released at teardown`, () => portFree);
console.log("ROBOT PASS: full interactive loop completed");
process.exit(0);
