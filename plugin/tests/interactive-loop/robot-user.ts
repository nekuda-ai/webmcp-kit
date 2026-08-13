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

import { readFileSync, readdirSync } from "node:fs";
import { connect as tcpConnect } from "node:net";
import { join, sep } from "node:path";

const root = process.argv[2] ?? process.cwd();
const portFile = join(root, ".webmcp", ".port");
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

// .webmcp/ is git-tracked, so .port is untrusted input: only a plain decimal port may ever
// reach the ws URL (a value like "80@attacker.example" would redirect the connection).
function livePort(): number | null {
  try {
    const raw = readFileSync(portFile, "utf8").trim();
    if (!/^[0-9]{1,5}$/.test(raw)) return null;
    const n = Number(raw);
    return n >= 1 && n <= 65535 ? n : null;
  } catch {
    return null;
  }
}

let port = 0;
async function connect(): Promise<WebSocket> {
  for (let i = 0; i < 120; i++) {
    const candidate = livePort();
    if (candidate) {
      try {
        port = candidate;
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?role=page`);
        await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("ws error")); });
        console.log(`connected to the interactive loop on port ${port}`);
        return ws;
      } catch {}
    }
    await Bun.sleep(1000);
  }
  console.error(`no server behind ${portFile}`);
  process.exit(1);
  throw new Error("unreachable");
}

setTimeout(() => { console.error("GLOBAL DEADLINE exceeded"); process.exit(1); }, DEADLINE_MS);

const ws = await connect();
ws.onmessage = (e) => {
  const m = JSON.parse(String(e.data));
  if (m.type === "snapshot") { files = m.files; check(); }
  if (m.type === "file" && typeof m.name === "string") {
    if (m.text === null) delete files[m.name];
    else if (typeof m.text === "string") files[m.name] = m.text;
    check();
  }
};
const send = (o: unknown) => { console.log(`send: ${JSON.stringify(o)}`); ws.send(JSON.stringify(o)); };
setInterval(check, 300); // some predicates read the source tree, which sends no snapshot

// 1. the interactive plan appears
await waitFor("interactive plan with >= 3 tool suggestions + phase propose", () =>
  (plan()?.suggestions ?? []).length >= 3 && phase() === "propose");
const [a, b, c] = plan().suggestions;

// 2. pick two, take a third and put it back (deselection must not build it), comment on the
//    first, expect a live ack in _chat
send({ type: "pick", suggestion: a.id, picked: true });
send({ type: "pick", suggestion: b.id, picked: true });
send({ type: "pick", suggestion: c.id, picked: true });
send({ type: "pick", suggestion: c.id, picked: false });
const chatBeforeNote = chatCount();
send({ type: "comment", suggestion: a.id, text: "keep this one read-only" });
await waitFor("chat ack for the pre-build comment", () => chatCount() > chatBeforeNote);

// 3. submit, then interject while Claude is mid-build (baselined: only lines appended
//    after this submit count, so a previous run's build can't satisfy the wait)
const statusAtSubmit = statusLines().length;
send({ type: "submit", picks: [{ suggestion: a.id, note: "keep this one read-only" }, { suggestion: b.id, note: "" }] });
await waitFor("build started", () => statusLines().slice(statusAtSubmit).some((e) => e.state === "start"));

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
send({ type: "comment", suggestion: b.id, text: "mid-build note: name the params exactly as planned" });

// 4. both tool modules built (code.md review copies), phase review reached by THIS build,
//    mid-build comment answered
await waitFor("both code.md review copies + phase review", () =>
  !!files[`${a.id}.code.md`] && !!files[`${b.id}.code.md`] &&
  statusLines().slice(statusAtSubmit).some((e) => e.phase === "review") && phase() === "review");
await waitFor("chat reply to the mid-build comment", () => chatCount() > chatBeforeMid);

// 4b. the deselected suggestion was never built and stayed out of the build steps
if (files[`${c.id}.code.md`]) { console.error(`FAIL: deselected ${c.id} was built`); process.exit(1); }
if (statusLines().slice(statusAtSubmit).some((e) => e.suggestion === c.id)) {
  console.error(`FAIL: deselected ${c.id} has build steps`); process.exit(1);
}
console.log(`ok: deselected ${c.id} not built, no build steps`);

// 5. feedback round 1: a per-run marker, so a previous run's marker can't satisfy it —
//    checked in the review copy AND in the real tool module under the source tree
const marker = `// robot-check-${NONCE}`;
send({ type: "feedback", suggestion: a.id, text: `add the exact comment line ${marker} to the ${a.id} tool module` });
await waitFor(`${a.id}.code.md contains ${marker}`, () => (files[`${a.id}.code.md`] ?? "").includes(marker));
let modulePath: string | null = null;
await waitFor(`the ${a.id} tool module under the source tree contains ${marker}`,
  () => !!(modulePath = toolModuleFor(a.id, marker)));
console.log(`tool module carrying the feedback: ${modulePath}`);

// 6. feedback round 2: checkable in the interactive plan
const desc = `ROBOT-DESC-${NONCE}`;
send({ type: "feedback", suggestion: b.id, text: `set the description of ${b.id} to exactly: ${desc}` });
await waitFor(`${b.id} description == ${desc}`, () => suggestion(b.id)?.description === desc);

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
send({ type: "approve" });
await waitFor("phase verify", () =>
  statusLines().slice(statusAtSubmit).some((e) => e.phase === "verify"));
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
