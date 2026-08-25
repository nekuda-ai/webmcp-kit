// Robot user for the interactive loop (NEK-693, ported from spike NEK-672): plays the
// Explorer's page role end to end. Waits for the interactive plan, picks 2 (and deselects a
// third), submits, interjects mid-build, runs 2 deterministic feedback rounds, approves,
// and accepts the post-build Connect offer.
// Exit 0 = full loop passed. Run: bun robot-user.ts <repo root>
// (the server must be up in that repo; a Claude session must be driving the loop)
//
// Reruns against a non-fresh state folder are safe: every wait is baselined against the
// lines already there, and the feedback markers carry a per-run nonce.
// Source-tree assertion: every suggestion declares its exact tool module in plan.json, so the
// robot checks the round-1 marker at that persisted source path rather than rediscovering it.

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { connect as tcpConnect } from "node:net";
import { join, relative, resolve, sep } from "node:path";
import { type Browser, type BrowserContext, type Page, chromium } from "playwright";

const root = process.argv[2] ?? process.cwd();
const runFile = join(root, ".webmcp", ".run.json");
const DEADLINE_AT = Number(process.env.ROBOT_DEADLINE_AT ?? Date.now() + 600_000);
const NONCE = process.env.ROBOT_NONCE ?? Date.now().toString(36).slice(-6);
const RECORD_DIR = process.env.ROBOT_RECORD_DIR;
const RECORD_RESULT = process.env.ROBOT_RECORD_RESULT;
const RECORD_HOST = process.env.ROBOT_HOST;
const RECORD_ATTEMPT = Number(process.env.ROBOT_ATTEMPT ?? 0);
const AGENT_EXIT_STATUS = process.env.ROBOT_AGENT_EXIT_STATUS;
type RecordingEntry = {
  state: string;
  file: string;
  timestamp: string;
  host: string;
  attempt: number;
  kind: "screenshot" | "video";
};
let recordingBrowser: Browser | null = null;
let recordingContext: BrowserContext | null = null;
let recordingPage: Page | null = null;
let recordingVideo: ReturnType<Page["video"]> = null;
let recordingPartial = false;
const recordingEntries: RecordingEntry[] = [];
const recordingIssues: string[] = [];

function recordingIssue(state: string, error: unknown): void {
  recordingPartial = true;
  const message = (error instanceof Error ? error.message : String(error))
    .replace(/\b(?:eyJ|oat_)[A-Za-z0-9._-]*/g, "[redacted-oauth]")
    .replace(/\bwmk_[A-Za-z0-9_-]+\b/g, "wmk_[redacted]")
    .replace(/\s+/g, " ")
    .slice(0, 300);
  recordingIssues.push(`${state}: ${message}`);
  console.error(`RECORDING partial at ${state}: ${message}`);
}

async function redactRecordingPage(page: Page): Promise<void> {
  await page.evaluate(() => {
    const redact = (value: string) => value
      .replace(/\bwmk_[A-Za-z0-9_-]+\b/g, "wmk_[redacted]")
      .replace(/\b(?:eyJ|oat_)[A-Za-z0-9._-]*/g, "[redacted-oauth]")
      .replace(/\brefresh_token\b(?:\s*[:=]\s*)?[^\s&"']*/gi, "[redacted-oauth]");
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      node.textContent = redact(node.textContent ?? "");
    }
    for (const element of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
      "input,textarea",
    )) element.value = redact(element.value);
  });
}

async function startRecording(): Promise<void> {
  if (!RECORD_DIR) return;
  try {
    mkdirSync(RECORD_DIR, { recursive: true, mode: 0o700 });
    const executablePath = process.env.ROBOT_BROWSER_EXECUTABLE;
    if (!executablePath) throw new Error("ROBOT_BROWSER_EXECUTABLE is missing");
    recordingBrowser = await chromium.launch({ executablePath, headless: true });
    recordingContext = await recordingBrowser.newContext({
      viewport: { width: 1440, height: 1000 },
      recordVideo: { dir: RECORD_DIR, size: { width: 1440, height: 1000 } },
    });
    recordingPage = await recordingContext.newPage();
    recordingVideo = recordingPage.video();
    const query = new URLSearchParams({ capability: run.capability, run_id: run.run_id });
    await recordingPage.goto(`http://127.0.0.1:${run.port}/?${query}`, {
      waitUntil: "domcontentloaded",
      timeout: remainingTime("recording Explorer navigation"),
    });
  } catch (error) {
    recordingIssue("explorer-start", error);
  }
}

async function recordExplorer(state: string, sequence: number): Promise<void> {
  if (!RECORD_DIR || !recordingPage) return;
  const file = `${String(sequence).padStart(2, "0")}-${state}.png`;
  try {
    await redactRecordingPage(recordingPage);
    await recordingPage.screenshot({ path: join(RECORD_DIR, file), fullPage: true });
    recordingEntries.push({
      state,
      file,
      timestamp: new Date().toISOString(),
      host: RECORD_HOST ?? "unknown",
      attempt: RECORD_ATTEMPT,
      kind: "screenshot",
    });
  } catch (error) {
    recordingIssue(state, error);
  }
}

async function finishRecording(): Promise<void> {
  if (!RECORD_DIR) return;
  try {
    await recordingContext?.close();
    if (recordingVideo) {
      const file = "explorer.webm";
      await recordingVideo.saveAs(join(RECORD_DIR, file));
      recordingEntries.push({
        state: "explorer-video",
        file,
        timestamp: new Date().toISOString(),
        host: RECORD_HOST ?? "unknown",
        attempt: RECORD_ATTEMPT,
        kind: "video",
      });
    }
  } catch (error) {
    recordingIssue("explorer-video", error);
  } finally {
    await recordingBrowser?.close().catch(() => {});
  }
  if (RECORD_RESULT) {
    writeFileSync(
      RECORD_RESULT,
      `${JSON.stringify({
        status: recordingPartial ? "partial" : "complete",
        entries: recordingEntries,
        issues: recordingIssues,
      })}\n`,
      { mode: 0o600 },
    );
  }
}

function remainingTime(desc: string): number {
  const remaining = DEADLINE_AT - Date.now();
  if (remaining <= 0) {
    console.error(`GLOBAL DEADLINE exceeded while waiting for: ${desc}`);
    process.exit(1);
  }
  return remaining;
}

let files: Record<string, string> = {};
let waiter: { desc: string; pred: () => boolean; resolve: () => void } | null = null;

function agentExitCode(): number | null {
  if (!AGENT_EXIT_STATUS) return null;
  try {
    const value = JSON.parse(readFileSync(AGENT_EXIT_STATUS, "utf8"));
    return Number.isInteger(value.code) ? value.code : null;
  } catch {
    return null;
  }
}

function failIfAgentExited(desc: string): void {
  const code = agentExitCode();
  if (code === null) return;
  console.error(`FAIL: agent exited (code ${code}) before "${desc}"`);
  process.exit(1);
}

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

function plannedWorkspacePath(declared: unknown): string | null {
  if (typeof declared !== "string" || declared.length === 0) return null;
  if (declared.includes("\\")) return null;
  const workspace = realpathSync(root);
  const absolute = resolve(workspace, declared);
  if (absolute === workspace || !absolute.startsWith(`${workspace}${sep}`)) return null;
  return relative(workspace, absolute).replaceAll(sep, "/");
}

function plannedEntryModule(): string | null {
  return plannedWorkspacePath(plan()?.entry_module);
}

function plannedSourceModule(id: string): string | null {
  return plannedWorkspacePath(suggestion(id)?.source_module);
}

function toolModuleFor(id: string, marker: string): string | null {
  const rel = plannedSourceModule(id);
  if (!rel) return null;
  try { return readFileSync(join(root, rel), "utf8").includes(marker) ? rel : null; } catch { return null; }
}

function connectedEntryModule(): string | null {
  const rel = plannedEntryModule();
  if (!rel) return null;
  try {
    const source = readFileSync(join(root, rel), "utf8");
    return source.includes("registerTools") &&
      /tracking\s*:\s*\{[\s\S]*?apiKey\s*:\s*["']wmk_[^"']+["']/.test(source)
      ? rel
      : null;
  } catch {
    return null;
  }
}

function check() {
  if (!waiter) return;
  if (waiter.pred()) {
    console.log(`ok: ${waiter.desc}`);
    const r = waiter.resolve;
    waiter = null;
    r();
  } else {
    failIfAgentExited(waiter.desc);
  }
}
function waitFor(desc: string, pred: () => boolean, timeoutSignature?: string): Promise<void> {
  console.log(`wait: ${desc}`);
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      if (timeoutSignature) console.error(timeoutSignature);
      console.error(`TIMEOUT waiting for: ${desc}`);
      console.error(`phase=${phase()} files=${Object.keys(files).join(",")}`);
      process.exit(1);
    }, remainingTime(desc));
    waiter = { desc, pred, resolve: () => { clearTimeout(t); resolve(); } };
    check();
  });
}

if (process.env.ROBOT_TEST_WAIT_FOR) {
  setInterval(check, 25);
  await waitFor(process.env.ROBOT_TEST_WAIT_FOR, () => false);
  process.exit(0);
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
let run = null as unknown as Run;
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
  while (Date.now() < DEADLINE_AT) {
    failIfAgentExited("interactive Explorer connection");
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

setTimeout(
  () => { console.error("GLOBAL DEADLINE exceeded"); process.exit(1); },
  remainingTime("interactive robot"),
);

const ws = await connect();
await startRecording();
function send(type: string, payload: unknown): Promise<Recorded> {
  const requestId = crypto.randomUUID();
  const request = { request_id: requestId, type, payload };
  console.log(`send: ${JSON.stringify(request)}`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      requestWaiters.delete(requestId);
      reject(new Error(`TIMEOUT waiting for recorded response to ${type}`));
    }, remainingTime(`recorded response to ${type}`));
    requestWaiters.set(requestId, {
      resolve: (value) => { clearTimeout(timer); console.log(`recorded: ${value.event_id} order=${value.order}`); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    ws.send(JSON.stringify(request));
  });
}
setInterval(check, 300); // some predicates read the source tree, which sends no snapshot

// 1. the interactive plan appears with every source seam and the entry seam resolved during wiring
await waitFor("interactive plan with >= 3 tool suggestions + exact source and entry modules + phase propose", () => {
  const suggestions = plan()?.suggestions ?? [];
  return suggestions.length >= 3 && !!plannedEntryModule() &&
    suggestions.every((item: any) => !!plannedSourceModule(item.id)) && phase() === "propose";
});
await recordExplorer("proposal-shown", 1);
const [a, b, c] = plan().suggestions;

// 2. pick two, take a third and put it back (deselection must not build it), comment on the
//    first, expect a live ack in _chat
await send("pick", { suggestion: a.id, picked: true });
await send("pick", { suggestion: b.id, picked: true });
await send("pick", { suggestion: c.id, picked: true });
await send("pick", { suggestion: c.id, picked: false });
const chatBeforeNote = chatCount();
const noteEvent = await send("comment", { suggestion: a.id, text: "keep this one read-only" });
await waitFor(
  "chat ack for the pre-build comment",
  () => chatCount() > chatBeforeNote,
  "NONDETERMINISM[comment-reply-missed]",
);
await recordExplorer("picks-comment", 2);

// 3. Once the comment effect is observable, durably queue submit before waiting for the
//    comment acknowledgement. This closes the host turn-end race: the same Stop continuation
//    always has a next event to claim, while numeric order still requires comment before submit.
const statusAtSubmit = statusLines().length;
const submitEvent = await send("submit", { picks: [{ suggestion: a.id, note: "keep this one read-only" }, { suggestion: b.id, note: "" }] });
await waitFor("handled ack for the pre-build comment", () => handled(noteEvent.event_id));
await waitFor(
  "handled ack for submit acceptance",
  () => handled(submitEvent.event_id),
  "NONDETERMINISM[submit-not-handled]",
);
await waitFor(
  "handled submit durably started the first selected build",
  () => {
    const acceptedStatus = statusLines().slice(statusAtSubmit);
    return acceptedStatus.some((e) => e.phase === "build") && acceptedStatus.some(
      (e) => e.suggestion === a.id && e.step === "code" && e.state === "start",
    );
  },
  "NONDETERMINISM[submit-handled-without-build-start]",
);
await recordExplorer("build-started", 3);

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
const feedbackSource = plannedSourceModule(a.id);
if (!feedbackSource) { console.error(`FAIL: ${a.id} has no exact source_module`); process.exit(1); }
const feedbackOne = await send("feedback", {
  suggestion: a.id,
  text: `edit the exact real visitor source module ${feedbackSource} first by adding the exact comment line ${marker}; then mechanically regenerate the .webmcp review copy from that file`,
});
await waitFor(`${a.id}.code.md contains ${marker}`, () => (files[`${a.id}.code.md`] ?? "").includes(marker));
let modulePath: string | null = null;
await waitFor(`the exact ${a.id} source module ${feedbackSource} contains ${marker}`,
  () => !!(modulePath = toolModuleFor(a.id, marker)));
console.log(`tool module carrying the feedback: ${modulePath}`);
await waitFor("handled ack for feedback round 1", () => handled(feedbackOne.event_id));
await recordExplorer("feedback-round-1", 4);

// 6. feedback round 2: checkable in the interactive plan
const desc = `ROBOT-DESC-${NONCE}`;
const feedbackTwo = await send("feedback", { suggestion: b.id, text: `set the description of ${b.id} to exactly: ${desc}` });
await waitFor(`${b.id} description == ${desc}`, () => suggestion(b.id)?.description === desc);
await waitFor("handled ack for feedback round 2", () => handled(feedbackTwo.event_id));
await recordExplorer("feedback-round-2", 5);

// 7. every built suggestion carries a verify outcome before approval is possible
const verified = (id: string) => statusLines().slice(statusAtSubmit).some(
  (e) => e.suggestion === id && e.step === "verify" && e.state === "done" && !!e.outcome);
await waitFor(`${a.id} and ${b.id} have a verify outcome`, () => verified(a.id) && verified(b.id));
await recordExplorer("verify-outcome", 6);

// 8. approve → verify → connect → done (again, only transitions appended after this run's submit count),
//    the built suggestions end `approved`, and teardown actually frees the port —
//    ECONNREFUSED, not a timeout: an unresponsive listener is still a listener
function portReleased(): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = tcpConnect({ host: "127.0.0.1", port });
    const done = (v: boolean) => { sock.destroy(); resolve(v); };
    sock.setTimeout(Math.min(1000, remainingTime(`port ${port} release`)), () => done(false));
    sock.once("connect", () => done(false));
    sock.once("error", (err: NodeJS.ErrnoException) => done(err.code === "ECONNREFUSED"));
  });
}
let portFree = false;
const approveEvent = await send("approve", {});
await waitFor("phase verify", () =>
  statusLines().slice(statusAtSubmit).some((e) => e.phase === "verify"));
await waitFor("handled ack for approval acceptance", () => handled(approveEvent.event_id));
await recordExplorer("approval", 7);
await waitFor("post-build Connect offer", () =>
  statusLines().slice(statusAtSubmit).some((e) => e.run === "connect" && e.state === "offer"));
await recordExplorer("connect-offer", 8);
const connectEvent = await send("connect", { action: "connect" });
await waitFor("handled ack for Connect acceptance", () => handled(connectEvent.event_id));
await waitFor("Connect completed", () =>
  statusLines().slice(statusAtSubmit).some((e) => e.run === "connect" && e.state === "done"));
await recordExplorer("connect-completed", 9);
const entryModule = connectedEntryModule();
if (!entryModule) {
  console.error("NONDETERMINISM[resolved-entry-tracking-missed]");
  process.exit(1);
}
console.log(`connected entry module: ${entryModule}`);
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
const connectEvidence = process.env.ROBOT_CONNECT_EVIDENCE;
if (connectEvidence) {
  const host = process.env.ROBOT_HOST;
  if ((host !== "claude" && host !== "codex") || !entryModule) {
    console.error("FAIL: host-specific Connect evidence is incomplete");
    process.exit(1);
  }
  writeFileSync(
    connectEvidence,
    `${JSON.stringify({
      version: 1,
      host,
      run_id: run.run_id,
      entry_module: entryModule,
      feedback_event_ids: [feedbackOne.event_id, feedbackTwo.event_id],
      approve_event_id: approveEvent.event_id,
    })}\n`,
    { mode: 0o600 },
  );
}
await finishRecording();
console.log("ROBOT PASS: full interactive loop completed");
process.exit(0);
