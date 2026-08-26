// Explorer relay server. Bun, zero dependencies.
//
// A normal start creates a new logical run. `--resume` is the only way to retain the
// identity and event order of a run whose server died without a clean shutdown.
import {
  closeSync,
  constants,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  watch,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import {
  AppendLimitError,
  MAX_JOURNAL_BYTES,
  MAX_REQUEST_BYTES,
  MAX_JOURNAL_LINE_BYTES,
  PROTOCOL_VERSION,
  SERVICE,
  appendDurable,
  parseRecordedEnvelope,
  parseRunFile,
  readRegularText,
  validateRequest,
  type RecordedEnvelope,
  type RunFileV1,
} from "./protocol";

const ACTIONABLE = new Set(["comment", "feedback", "submit", "approve", "cancel", "connect"]);
const MAX_RUNTIME_BYTES = 16 * 1024;

function testDuration(name: string, fallback: number): number {
  const value = process.env[name];
  return value && /^[1-9][0-9]{1,5}$/.test(value) ? Number(value) : fallback;
}

const SERVER_LOCK_LEASE_MS = testDuration("WEBMCP_TEST_SERVER_LOCK_LEASE_MS", 60 * 1_000);
const SERVER_LOCK_RENEW_MS = Math.min(
  testDuration("WEBMCP_TEST_SERVER_LOCK_RENEW_MS", 10 * 1_000),
  Math.max(10, Math.floor(SERVER_LOCK_LEASE_MS / 2)),
);
const args = process.argv.slice(2);
const resume = args.includes("--resume");
const positional = args.filter((arg) => !arg.startsWith("--"));
const unknownFlags = args.filter((arg) => arg.startsWith("--") && arg !== "--resume");
if (unknownFlags.length > 0 || positional.length > 1) {
  console.error("usage: bun server.ts [workspace] [--resume]");
  process.exit(2);
}

let workspace: string;
try {
  workspace = realpathSync(positional[0] ?? process.cwd());
  if (!lstatSync(workspace).isDirectory()) throw new Error("not a directory");
} catch (error) {
  console.error(`refusing to start: invalid workspace (${(error as Error).message})`);
  process.exit(1);
  throw error;
}

const stateDir = join(workspace, ".webmcp");
const runFile = join(stateDir, ".run.json");
const lockFile = join(stateDir, ".server.lock");
const portFile = join(stateDir, ".port");
const lastPortFile = join(stateDir, ".port.last");
const gitignoreFile = join(stateDir, ".gitignore");
const feedbackFile = join(stateDir, "_feedback.ndjson");
const deliveryFile = join(stateDir, "_delivery.ndjson");

function stateDirIsReal(): boolean {
  try {
    return lstatSync(stateDir).isDirectory() && !lstatSync(stateDir).isSymbolicLink();
  } catch {
    return false;
  }
}

try {
  if (lstatSync(stateDir).isSymbolicLink()) {
    console.error(`refusing to start: ${stateDir} is a symlink`);
    process.exit(1);
  }
} catch {
  // Absent is expected on the first run.
}
mkdirSync(stateDir, { recursive: true });
if (!stateDirIsReal()) {
  console.error(`refusing to start: ${stateDir} is not a real directory`);
  process.exit(1);
}
try {
  if (lstatSync(runFile).isSymbolicLink()) {
    console.error("refusing to start: .webmcp/.run.json is a symlink");
    process.exit(1);
  }
} catch {
  // Absent is expected.
}

function writeFileExclusive(path: string, text: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o644);
    const buffer = Buffer.from(text, "utf8");
    const written = writeSync(fd, buffer, 0, buffer.length);
    if (written !== buffer.length) throw new Error(`short write (${written}/${buffer.length} bytes)`);
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function readRun(): RunFileV1 | null {
  const text = readRegularText(runFile, MAX_RUNTIME_BYTES);
  if (text === null) return null;
  try {
    const parsed = parseRunFile(JSON.parse(text));
    return parsed?.workspace === workspace ? parsed : null;
  } catch {
    return null;
  }
}

function explorerUrl(run: RunFileV1): string {
  const query = new URLSearchParams({ capability: run.capability, run_id: run.run_id });
  return `http://localhost:${run.port}/?${query}`;
}

function scopedUrl(run: RunFileV1, pathname: string): string {
  const query = new URLSearchParams({ capability: run.capability, run_id: run.run_id });
  return `http://127.0.0.1:${run.port}${pathname}?${query}`;
}

async function isLive(run: RunFileV1): Promise<boolean> {
  try {
    const response = await fetch(scopedUrl(run, "/healthz"), {
      signal: AbortSignal.timeout(500),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as Record<string, unknown>;
    return (
      body.service === SERVICE &&
      body.version === PROTOCOL_VERSION &&
      body.run_id === run.run_id &&
      body.workspace === workspace &&
      Object.keys(body).sort().join(",") === "run_id,service,version,workspace"
    );
  } catch {
    return false;
  }
}

const initialRun = readRun();
if (initialRun && (await isLive(initialRun))) {
  console.log(`webmcp-explorer already live on ${explorerUrl(initialRun)}  state: ${stateDir}`);
  process.exit(0);
}
if (resume && !initialRun) {
  console.error("refusing to resume: .webmcp/.run.json is absent or invalid for this workspace");
  process.exit(1);
}

const lockNonce = crypto.randomUUID();
let ownLockText = JSON.stringify({
  pid: process.pid,
  nonce: lockNonce,
  lease_expires_at_ms: Date.now() + SERVER_LOCK_LEASE_MS,
});
let ownLock = false;

type LockOwner = { pid: number; nonce: string; lease_expires_at_ms: number };

function lockOwnerAt(path: string): LockOwner | null {
  const text = readRegularText(path, 4096);
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    const keys = Object.keys(value).sort().join(",");
    if (
      (keys !== "lease_expires_at_ms,nonce,pid" &&
        keys !== "created_at_ms,nonce,pid" &&
        keys !== "nonce,pid") ||
      !Number.isSafeInteger(value.pid) ||
      (value.pid as number) < 1 ||
      typeof value.nonce !== "string" ||
      value.nonce.length > 128 ||
      (keys === "lease_expires_at_ms,nonce,pid" &&
        (!Number.isSafeInteger(value.lease_expires_at_ms) ||
          (value.lease_expires_at_ms as number) < 0)) ||
      (keys === "created_at_ms,nonce,pid" &&
        (!Number.isSafeInteger(value.created_at_ms) || (value.created_at_ms as number) < 0))
    ) {
      return null;
    }
    return {
      pid: value.pid as number,
      nonce: value.nonce,
      // Pre-lease development locks are recoverable migration input, never immortal.
      lease_expires_at_ms:
        keys === "lease_expires_at_ms,nonce,pid" ? (value.lease_expires_at_ms as number) : 0,
    };
  } catch {
    return null;
  }
}

function sameLockOwner(left: LockOwner | null, right: LockOwner): boolean {
  return (
    left?.pid === right.pid &&
    left.nonce === right.nonce &&
    left.lease_expires_at_ms === right.lease_expires_at_ms
  );
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function acquireLock(): Promise<RunFileV1 | null> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const stage = `${lockFile}.claim.${process.pid}.${crypto.randomUUID()}`;
    try {
      writeFileExclusive(stage, ownLockText);
      linkSync(stage, lockFile);
      ownLock = true;
      return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      try {
        unlinkSync(stage);
      } catch {
        // Linked, never created, or already gone.
      }
    }
    const owner = lockOwnerAt(lockFile);
    if (!owner) {
      try {
        if (lstatSync(lockFile).isFile() && !lstatSync(lockFile).isSymbolicLink()) {
          throw new Error(".webmcp/.server.lock has invalid contents");
        }
        throw new Error(".webmcp/.server.lock is not a valid regular lock file");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
    }
    const now = Date.now();
    const expired =
      owner.lease_expires_at_ms <= now ||
      owner.lease_expires_at_ms > now + 2 * SERVER_LOCK_LEASE_MS;
    if (processExists(owner.pid) && !expired) {
      const candidate = readRun();
      if (candidate && (await isLive(candidate))) return candidate;
      await Bun.sleep(50);
      continue;
    }
    await staleLockTestBarrier();
    const stale = `${lockFile}.stale.${crypto.randomUUID()}`;
    try {
      renameSync(lockFile, stale);
    } catch {
      await Bun.sleep(10);
      continue;
    }
    // `rename` has no compare-and-swap form. Another starter can replace the lock after
    // our read but before this rename, so verify the quarantined inode before deleting it.
    // On a mismatch, put that fresh owner's inode back only if the canonical name is still
    // free, then abort. Its owner independently revalidates the canonical claim below.
    if (!sameLockOwner(lockOwnerAt(stale), owner)) {
      try {
        linkSync(stale, lockFile);
        unlinkSync(stale);
      } catch {
        // A third claimant already owns the canonical name. Leave the mismatched tombstone
        // intact rather than deleting a lock we did not observe.
      }
      throw new Error("the server lock changed during stale-owner takeover");
    }
    unlinkSync(stale);
  }
  throw new Error("another Explorer server is starting in this workspace");
}

// Deterministic regression-test barrier for the stale-observe/takeover interleaving. It is
// inert unless a test process explicitly supplies a private temporary directory.
async function staleLockTestBarrier(): Promise<void> {
  const directory = process.env.WEBMCP_TEST_STALE_LOCK_BARRIER;
  if (!directory) return;
  const observed = join(directory, `observed-${process.pid}`);
  const release = join(directory, `release-${process.pid}`);
  try {
    writeFileExclusive(observed, "observed");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const deadline = Date.now() + 5_000;
  while (readRegularText(release, 32) === null) {
    if (Date.now() >= deadline) throw new Error("stale-lock test barrier timed out");
    await Bun.sleep(5);
  }
}

let competingRun: RunFileV1 | null = null;
try {
  competingRun = await acquireLock();
} catch (error) {
  console.error(`refusing to start: ${(error as Error).message}`);
  process.exit(1);
}
if (competingRun) {
  console.log(`webmcp-explorer already live on ${explorerUrl(competingRun)}  state: ${stateDir}`);
  process.exit(0);
}
if (readRegularText(lockFile, 4096) !== ownLockText) {
  console.error("refusing to start: lost the Explorer server lock before startup");
  process.exit(1);
}

const identity: RunFileV1 = resume
  ? (initialRun as RunFileV1)
  : {
      version: PROTOCOL_VERSION,
      run_id: crypto.randomUUID(),
      capability: crypto.randomUUID(),
      workspace,
      port: 1,
      pid: process.pid,
      started_at: new Date().toISOString(),
    };

function portNumberIn(path: string): number | null {
  const text = readRegularText(path, 16)?.trim();
  if (!text || !/^[0-9]{1,5}$/.test(text)) return null;
  const port = Number(text);
  return port >= 1 && port <= 65535 ? port : null;
}

function maxRecordedOrder(runId: string): number {
  const text = readRegularText(feedbackFile);
  if (text === null) return 0;
  let max = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const envelope = parseRecordedEnvelope(JSON.parse(line));
      if (envelope?.run_id === runId && envelope.order > max) max = envelope.order;
    } catch {
      // Legacy records, fragments, and malformed foreign input never allocate order.
    }
  }
  return max;
}

let lastOrder = maxRecordedOrder(identity.run_id);

// Read per request so an Explorer-page edit does not need a server restart.
function page(): string {
  try {
    return readFileSync(join(import.meta.dir, "explorer.html"), "utf8");
  } catch {
    return "<!doctype html><meta charset=utf-8><title>WebMCP Explorer</title><h1>Explorer unavailable</h1>";
  }
}

function stateFiles(): Record<string, string> {
  const files: Record<string, string> = Object.create(null);
  let names: string[] = [];
  try {
    if (stateDirIsReal()) names = readdirSync(stateDir);
  } catch {
    return files;
  }
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const text = readRegularText(join(stateDir, name));
    if (text !== null) files[name] = text;
  }
  return files;
}

const snapshot = () => JSON.stringify({ type: "snapshot", files: stateFiles() });
let publishedFiles = stateFiles();
let debounce: ReturnType<typeof setTimeout> | undefined;
let server: ReturnType<typeof startServer>;
let watcher: ReturnType<typeof watch> | undefined;
let reconciliation: ReturnType<typeof setInterval> | undefined;
let lockRenewal: ReturnType<typeof setInterval> | undefined;

function publishChanges(): void {
  clearTimeout(debounce);
  debounce = undefined;
  const next = stateFiles();
  const names = [...new Set([...Object.keys(publishedFiles), ...Object.keys(next)])].sort();
  for (const name of names) {
    const present = Object.prototype.hasOwnProperty.call(next, name);
    if (present && next[name] === publishedFiles[name]) continue;
    server.publish("page", JSON.stringify({ type: "file", name, text: present ? next[name] : null }));
  }
  publishedFiles = next;
}

function authorized(url: URL): boolean {
  return (
    url.searchParams.get("capability") === identity.capability &&
    url.searchParams.get("run_id") === identity.run_id
  );
}

function sameOrigin(req: Request, port: number): boolean {
  const origin = req.headers.get("origin");
  return !origin || origin === `http://localhost:${port}` || origin === `http://127.0.0.1:${port}`;
}

function sendError(
  ws: ServerWebSocket<{ role: "page" | "claude" }>,
  message: string,
  requestId?: string,
): void {
  ws.send(JSON.stringify({ type: "error", ...(requestId ? { request_id: requestId } : {}), message }));
}

function journalByteLimit(): number {
  const testLimit = process.env.WEBMCP_TEST_JOURNAL_MAX_BYTES;
  if (testLimit && /^[1-9][0-9]{0,7}$/.test(testLimit)) {
    return Math.min(Number(testLimit), MAX_JOURNAL_BYTES);
  }
  return MAX_JOURNAL_BYTES;
}

// A subscribed claude-role socket at publish time (a Claude Monitor, or any agent listener)
// is the server's only evidence that an automatic wake path exists. Record it per event as
// `waiting` — never `claimed`: a socket publish is not model receipt. Without this record the
// Explorer must assume nobody is listening and shows its manual-recovery fallback even while
// the agent is handling the event. Best-effort: the event itself is already durable in the
// feedback journal, so a failed evidence append must not fail the recording.
let claudeSubscribers = 0;

function recordWaitingDelivery(envelope: RecordedEnvelope): void {
  try {
    appendDurable(
      deliveryFile,
      {
        ts: new Date().toISOString(),
        run_id: envelope.run_id,
        event_id: envelope.event_id,
        order: envelope.order,
        state: "waiting",
      },
      journalByteLimit(),
    );
  } catch (error) {
    console.log(
      `warning: could not record delivery evidence for ${envelope.event_id} (${(error as Error).message})`,
    );
  }
}

function startServer(port: number) {
  return Bun.serve<{ role: "page" | "claude" }>({
    port,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/healthz") {
        if (!authorized(url)) return new Response("not found", { status: 404 });
        return Response.json(
          { service: SERVICE, version: PROTOCOL_VERSION, run_id: identity.run_id, workspace },
          { headers: { "cache-control": "no-store" } },
        );
      }
      if (url.pathname === "/ws") {
        if (!sameOrigin(req, srv.port)) return new Response("forbidden origin", { status: 403 });
        if (!authorized(url)) return new Response("forbidden", { status: 403 });
        const role = url.searchParams.get("role");
        if (role !== "page" && role !== "claude") return new Response("unknown role", { status: 400 });
        if (srv.upgrade(req, { data: { role } })) return;
        return new Response("upgrade failed", { status: 400 });
      }
      if (url.pathname === "/shutdown") {
        if (!sameOrigin(req, srv.port)) return new Response("forbidden origin", { status: 403 });
        if (!authorized(url)) return new Response("forbidden", { status: 403 });
        if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
        publishChanges();
        setTimeout(cleanExit, 100);
        return new Response("bye");
      }
      return new Response(page(), { headers: { "content-type": "text/html; charset=utf-8" } });
    },
    websocket: {
      open(ws) {
        ws.subscribe(ws.data.role);
        if (ws.data.role === "page") ws.send(snapshot());
        if (ws.data.role === "claude") claudeSubscribers++;
        console.log(`ws open: ${ws.data.role}`);
      },
      message(ws, raw) {
        if (ws.data.role !== "page") return;
        const bytes = typeof raw === "string" ? Buffer.byteLength(raw, "utf8") : raw.byteLength;
        if (bytes > MAX_REQUEST_BYTES) {
          sendError(ws, "That request is too large. Keep it under 64 KB.");
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(raw));
        } catch {
          sendError(ws, "Request must be valid JSON.");
          return;
        }
        const checked = validateRequest(parsed);
        if (checked.ok === false) {
          sendError(ws, checked.message, checked.request_id);
          return;
        }
        if (lastOrder >= Number.MAX_SAFE_INTEGER) {
          sendError(ws, "This run has exhausted its event order.", checked.value.request_id);
          return;
        }
        const envelope: RecordedEnvelope = {
          event_id: crypto.randomUUID(),
          run_id: identity.run_id,
          order: lastOrder + 1,
          type: checked.value.type,
          ts: new Date().toISOString(),
          payload: checked.value.payload,
        };
        const line = JSON.stringify(envelope);
        if (Buffer.byteLength(line, "utf8") > MAX_JOURNAL_LINE_BYTES) {
          sendError(ws, "The event is too large to record.", checked.value.request_id);
          return;
        }
        try {
          if (!stateDirIsReal()) throw new Error("state folder is missing or is a symlink");
          appendDurable(feedbackFile, envelope, journalByteLimit());
        } catch (error) {
          console.log(`warning: could not record ${envelope.type} (${(error as Error).message})`);
          sendError(
            ws,
            error instanceof AppendLimitError
              ? "This run's feedback journal is full. Archive or rotate .webmcp/_feedback.ndjson, then start a new run."
              : "The event could not be recorded.",
            checked.value.request_id,
          );
          return;
        }
        lastOrder = envelope.order;
        ws.send(
          JSON.stringify({
            type: "recorded",
            request_id: checked.value.request_id,
            event_id: envelope.event_id,
            run_id: envelope.run_id,
            order: envelope.order,
          }),
        );
        if (ACTIONABLE.has(envelope.type)) {
          server.publish("claude", line);
          if (claudeSubscribers > 0) recordWaitingDelivery(envelope);
        }
        console.log(`event: ${line}`);
      },
      close(ws) {
        if (ws.data.role === "claude") claudeSubscribers--;
        console.log(`ws close: ${ws.data.role}`);
      },
    },
  });
}

const preferredPort = resume
  ? identity.port
  : (portNumberIn(portFile) ?? portNumberIn(lastPortFile) ?? 0);
try {
  server = startServer(preferredPort);
} catch {
  server = startServer(0);
}

const liveRun: RunFileV1 = {
  ...identity,
  port: server.port,
  pid: process.pid,
};

function writeAtomic(path: string, text: string): void {
  if (!stateDirIsReal()) throw new Error("state folder is missing or is a symlink");
  try {
    if (lstatSync(path).isSymbolicLink()) throw new Error(`${path} is a symlink`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}`;
  try {
    writeFileExclusive(temporary, text);
    renameSync(temporary, path);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // Renamed or never created.
    }
  }
}

function ensureRuntimeIgnored(): void {
  const required = [".port*", ".run.json*", ".server.lock*", ".ack.lock*"];
  let existing = readRegularText(gitignoreFile, 64 * 1024) ?? "";
  const lines = new Set(existing.split("\n"));
  const missing = required.filter((line) => !lines.has(line));
  if (missing.length === 0) return;
  if (existing && !existing.endsWith("\n")) existing += "\n";
  writeAtomic(gitignoreFile, `${existing}${missing.join("\n")}\n`);
}

function publishPort(path: string, port: number): void {
  try {
    if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) {
      console.log(`warning: ${path} is not a regular file; leaving it untouched`);
      return;
    }
  } catch {
    // Absent is expected.
  }
  writeAtomic(path, String(port));
}

try {
  if (readRegularText(lockFile, 4096) !== ownLockText) {
    throw new Error("lost the Explorer server lock before runtime publication");
  }
  ensureRuntimeIgnored();
  writeAtomic(runFile, `${JSON.stringify(liveRun)}\n`);
  publishPort(portFile, server.port);
  publishPort(lastPortFile, server.port);
} catch (error) {
  server.stop(true);
  console.error(`refusing to start: could not publish runtime state (${(error as Error).message})`);
  releaseLock();
  process.exit(1);
}

function runtimeIsOurs(): boolean {
  const current = readRun();
  return (
    current?.run_id === liveRun.run_id &&
    current.capability === liveRun.capability &&
    current.pid === process.pid
  );
}

function releaseLock(): void {
  if (!ownLock || readRegularText(lockFile, 4096) !== ownLockText) return;
  try {
    unlinkSync(lockFile);
  } catch {
    // Best-effort cleanup. A crash deliberately leaves this claim behind.
  }
  ownLock = false;
}

function renewServerLock(): boolean {
  if (!ownLock || readRegularText(lockFile, 4096) !== ownLockText) return false;
  const renewedText = JSON.stringify({
    pid: process.pid,
    nonce: lockNonce,
    lease_expires_at_ms: Date.now() + SERVER_LOCK_LEASE_MS,
  });
  const stage = `${lockFile}.renew.${process.pid}.${crypto.randomUUID()}`;
  const tombstone = `${lockFile}.renewing.${crypto.randomUUID()}`;
  let quarantinedOurs = false;
  try {
    writeFileExclusive(stage, renewedText);
    renameSync(lockFile, tombstone);
    if (readRegularText(tombstone, 4096) !== ownLockText) {
      try {
        linkSync(tombstone, lockFile);
        unlinkSync(tombstone);
      } catch {
        // Another owner has the canonical name. Preserve the mismatched tombstone.
      }
      return false;
    }
    quarantinedOurs = true;
    try {
      linkSync(stage, lockFile);
    } catch {
      return false;
    }
    ownLockText = renewedText;
    return true;
  } catch {
    return false;
  } finally {
    try {
      unlinkSync(stage);
    } catch {}
    if (quarantinedOurs) {
      try {
        unlinkSync(tombstone);
      } catch {}
    }
  }
}

function clearLiveness(): void {
  if (runtimeIsOurs()) {
    try {
      unlinkSync(runFile);
    } catch {}
  }
  if (portNumberIn(portFile) === liveRun.port) {
    try {
      unlinkSync(portFile);
    } catch {}
  }
  releaseLock();
}

let shuttingDown = false;
function cleanExit(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  if (reconciliation) clearInterval(reconciliation);
  if (lockRenewal) clearInterval(lockRenewal);
  clearTimeout(debounce);
  watcher?.close();
  server.stop(true);
  clearLiveness();
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, cleanExit);

watcher = watch(stateDir, () => {
  clearTimeout(debounce);
  debounce = setTimeout(publishChanges, 120);
});
watcher.on("error", (error) => console.log(`warning: state folder watch stopped (${error.message})`));

// Some platforms coalesce or omit rename events. Re-read by content every 250 ms so an
// atomic replace still reaches the page exactly once.
reconciliation = setInterval(publishChanges, 250);
lockRenewal = setInterval(() => {
  if (renewServerLock()) return;
  console.log("warning: lost the Explorer server lock during lease renewal; shutting down");
  cleanExit();
}, SERVER_LOCK_RENEW_MS);

console.log(`webmcp-explorer on ${explorerUrl(liveRun)}  state: ${stateDir}`);
