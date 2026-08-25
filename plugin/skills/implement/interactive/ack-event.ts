// Safely mark one recorded Explorer event handled.
// Usage: bun ack-event.ts <workspace> <run_id> <event_id>
import {
  closeSync,
  constants,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  MAX_JOURNAL_BYTES,
  appendDurable,
  isIsoTimestamp,
  isPlainObject,
  isUuid,
  parseRecordedEnvelope,
  parseRunFile,
  readRegularText,
  type RecordedEnvelope,
  type RunFileV1,
} from "./protocol";

const [workspaceArgument, runId, eventId, ...extra] = process.argv.slice(2);
if (!workspaceArgument || !runId || !eventId || extra.length > 0) {
  console.error("usage: bun ack-event.ts <workspace> <run_id> <event_id>");
  process.exit(2);
}
if (!isUuid(runId) || !isUuid(eventId)) {
  console.error("refusing to acknowledge: run_id and event_id must be UUIDs");
  process.exit(2);
}

let workspace: string;
try {
  workspace = realpathSync(workspaceArgument);
  if (!lstatSync(workspace).isDirectory()) throw new Error("not a directory");
} catch (error) {
  console.error(`refusing to acknowledge: invalid workspace (${(error as Error).message})`);
  process.exit(1);
  throw error;
}

const stateDir = join(workspace, ".webmcp");
const runFile = join(stateDir, ".run.json");
const feedbackFile = join(stateDir, "_feedback.ndjson");
const ackFile = join(stateDir, "_ack.ndjson");
const statusFile = join(stateDir, "_status.ndjson");
const lockFile = join(stateDir, ".ack.lock");
const ACK_LOCK_MAX_AGE_MS = 5 * 60 * 1_000;
const MAX_REVIEW_COPY_BYTES = 64 * 1024;
const lockNonce = crypto.randomUUID();
const ownLockText = JSON.stringify({
  pid: process.pid,
  nonce: lockNonce,
  created_at_ms: Date.now(),
});
let ownLock = false;

type LockOwner = { pid: number; nonce: string; created_at_ms: number };

function stateDirIsReal(): boolean {
  try {
    return lstatSync(stateDir).isDirectory() && !lstatSync(stateDir).isSymbolicLink();
  } catch {
    return false;
  }
}

function writeExclusive(path: string, text: string): void {
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

function lockOwnerAt(path: string): LockOwner | null {
  const text = readRegularText(path, 4096);
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (
      Object.keys(value).sort().join(",") !== "created_at_ms,nonce,pid" ||
      !Number.isSafeInteger(value.pid) ||
      (value.pid as number) < 1 ||
      typeof value.nonce !== "string" ||
      value.nonce.length > 128 ||
      !Number.isSafeInteger(value.created_at_ms) ||
      (value.created_at_ms as number) < 0
    ) {
      return null;
    }
    return value as LockOwner;
  } catch {
    return null;
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function acquireLock(): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt++) {
    const stage = `${lockFile}.claim.${process.pid}.${crypto.randomUUID()}`;
    try {
      writeExclusive(stage, ownLockText);
      linkSync(stage, lockFile);
      ownLock = true;
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      try {
        unlinkSync(stage);
      } catch {
        // Linked, never created, or already gone.
      }
    }
    const observed = lockOwnerAt(lockFile);
    if (!observed) {
      try {
        if (lstatSync(lockFile).isFile() && !lstatSync(lockFile).isSymbolicLink()) {
          throw new Error(".webmcp/.ack.lock has invalid contents");
        }
        throw new Error(".webmcp/.ack.lock is not a valid regular lock file");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
    }
    const age = Date.now() - observed.created_at_ms;
    const expired = age > ACK_LOCK_MAX_AGE_MS || age < -ACK_LOCK_MAX_AGE_MS;
    if (processExists(observed.pid) && !expired) {
      await Bun.sleep(20);
      continue;
    }
    const stale = `${lockFile}.stale.${crypto.randomUUID()}`;
    try {
      renameSync(lockFile, stale);
    } catch {
      await Bun.sleep(5);
      continue;
    }
    const quarantined = lockOwnerAt(stale);
    if (
      quarantined?.pid !== observed.pid ||
      quarantined.nonce !== observed.nonce ||
      quarantined.created_at_ms !== observed.created_at_ms
    ) {
      try {
        linkSync(stale, lockFile);
        unlinkSync(stale);
      } catch {
        // Never delete a mismatched lock when another claimant owns the canonical name.
      }
      await Bun.sleep(5);
      continue;
    }
    unlinkSync(stale);
  }
  throw new Error("timed out waiting for another acknowledgement writer");
}

function releaseLock(): void {
  if (!ownLock || readRegularText(lockFile, 4096) !== ownLockText) return;
  try {
    unlinkSync(lockFile);
  } catch {
    // A crash leaves a recoverable PID/nonce lock.
  }
  ownLock = false;
}

function currentRun(): RunFileV1 | null {
  const text = readRegularText(runFile, 16 * 1024);
  if (text === null) return null;
  try {
    const run = parseRunFile(JSON.parse(text));
    return run?.workspace === workspace && run.run_id === runId ? run : null;
  } catch {
    return null;
  }
}

function canonicalEvent(): RecordedEnvelope | null {
  const text = readRegularText(feedbackFile);
  if (text === null) return null;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const envelope = parseRecordedEnvelope(JSON.parse(line));
      if (envelope?.run_id === runId && envelope.event_id === eventId) return envelope;
    } catch {
      // Legacy, malformed, and partial lines can never authorize an acknowledgement.
    }
  }
  return null;
}

function submitBuildStarted(event: RecordedEnvelope): boolean {
  if (event.type !== "submit") return true;
  const status = readRegularText(statusFile);
  if (status === null) return false;
  const entries: Array<Record<string, unknown>> = [];
  for (const line of status.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (isPlainObject(value)) entries.push(value);
    } catch {
      // Malformed lines can never prove the submit effect.
    }
  }
  if (!entries.some((entry) => entry.phase === "build")) return false;
  const firstPick = (event.payload as { picks: Array<{ suggestion: string }> }).picks[0];
  return (
    !firstPick ||
    entries.some(
      (entry) =>
        entry.suggestion === firstPick.suggestion &&
        entry.step === "code" &&
        entry.state === "start",
    )
  );
}

function feedbackSourceMatchesReview(event: RecordedEnvelope): boolean {
  if (event.type !== "feedback") return true;
  const suggestion = (event.payload as { suggestion: string | null }).suggestion;
  if (suggestion === null) return true;
  const planText = readRegularText(join(stateDir, "plan.json"), MAX_REVIEW_COPY_BYTES);
  if (planText === null) return false;
  let sourceModule: string | null = null;
  try {
    const value = JSON.parse(planText) as unknown;
    if (!isPlainObject(value) || !Array.isArray(value.suggestions)) return false;
    const planned = value.suggestions.find(
      (item) => isPlainObject(item) && item.id === suggestion,
    );
    if (
      !isPlainObject(planned) ||
      typeof planned.source_module !== "string" ||
      planned.source_module.length === 0 ||
      planned.source_module.includes("\\")
    ) {
      return false;
    }
    sourceModule = planned.source_module;
  } catch {
    return false;
  }

  if (sourceModule === null) return false;
  const sourcePath = resolve(workspace, sourceModule);
  if (sourcePath === workspace || !sourcePath.startsWith(`${workspace}${sep}`)) return false;
  try {
    if (realpathSync(sourcePath) !== sourcePath) return false;
  } catch {
    return false;
  }
  const reviewPath = resolve(stateDir, `${suggestion}.code.md`);
  if (!reviewPath.startsWith(`${stateDir}${sep}`)) return false;
  const source = readRegularText(sourcePath, MAX_REVIEW_COPY_BYTES);
  const review = readRegularText(reviewPath, MAX_REVIEW_COPY_BYTES);
  return source !== null && source === review;
}

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const pattern of [
    /\b(?:import|export)\s+(?:[^"'()]*?\s+from\s*)?["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ]) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]) specifiers.push(match[1]);
    }
  }
  return specifiers;
}

function approvalBrowserDeliveryIssue(event: RecordedEnvelope): string | null {
  if (event.type !== "approve") return null;
  const planText = readRegularText(join(stateDir, "plan.json"), MAX_REVIEW_COPY_BYTES);
  if (planText === null) return null;
  let entryModule: string;
  try {
    const value = JSON.parse(planText) as unknown;
    if (!isPlainObject(value) || typeof value.entry_module !== "string") return null;
    entryModule = value.entry_module;
  } catch {
    return null;
  }
  if (entryModule.includes("\\") || !/\.(?:m?js)$/i.test(entryModule)) return null;
  const segments = entryModule.split("/");
  const publicIndex = segments.lastIndexOf("public");
  if (publicIndex < 0) return null;
  const publicRoot = resolve(workspace, ...segments.slice(0, publicIndex + 1));
  const entryPath = resolve(workspace, entryModule);
  if (entryPath === publicRoot || !entryPath.startsWith(`${publicRoot}${sep}`)) {
    return "planned public entry module escapes its public root";
  }

  const pending = [entryPath];
  const visited = new Set<string>();
  while (pending.length > 0 && visited.size < 128) {
    const path = pending.pop()!;
    if (visited.has(path)) continue;
    visited.add(path);
    try {
      if (realpathSync(path) !== path) return "planned public module graph contains a symlink";
    } catch {
      return `planned public module is not a readable real file: ${relative(workspace, path)}`;
    }
    const source = readRegularText(path, MAX_REVIEW_COPY_BYTES);
    if (source === null) {
      return `planned public module is not a bounded regular file: ${relative(workspace, path)}`;
    }
    for (const specifier of importSpecifiers(source)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(specifier) || specifier.startsWith("//")) continue;
      if (!specifier.startsWith(".") && !specifier.startsWith("/")) {
        return `browser-unresolvable bare import ${JSON.stringify(specifier)} in ${relative(workspace, path)}`;
      }
      const clean = specifier.split(/[?#]/, 1)[0] ?? "";
      const imported = specifier.startsWith("/")
        ? resolve(publicRoot, clean.replace(/^\/+/, ""))
        : resolve(dirname(path), clean);
      if (imported !== publicRoot && !imported.startsWith(`${publicRoot}${sep}`)) {
        return `planned public module import escapes its public root: ${specifier}`;
      }
      if (/\.(?:m?js)$/i.test(imported)) pending.push(imported);
    }
  }
  return null;
}

function acknowledgementExists(): boolean {
  const text = readRegularText(ackFile);
  if (text === null) return false;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (
        isPlainObject(value) &&
        Object.keys(value).sort().join(",") === "event_id,run_id,status,ts" &&
        value.run_id === runId &&
        value.event_id === eventId &&
        value.status === "handled" &&
        isIsoTimestamp(value.ts)
      ) {
        return true;
      }
    } catch {
      // Legacy and malformed lines do not satisfy idempotency.
    }
  }
  return false;
}

async function main(): Promise<void> {
  if (!stateDirIsReal()) throw new Error(".webmcp is not a real directory");
  if (!currentRun()) throw new Error(".webmcp/.run.json is not the matching current run");
  await acquireLock();
  try {
    if (readRegularText(lockFile, 4096) !== ownLockText) {
      throw new Error("lost the acknowledgement lock");
    }
    if (!stateDirIsReal() || !currentRun()) {
      throw new Error(".webmcp/.run.json is no longer the matching current run");
    }
    const event = canonicalEvent();
    if (!event) {
      throw new Error("event_id is not a canonical event in the matching current run");
    }
    if (!submitBuildStarted(event)) {
      throw new Error("submit effect has no durable phase-build and first code-start records");
    }
    if (!feedbackSourceMatchesReview(event)) {
      throw new Error(
        "feedback effect must update the suggestion's exact plan.json source_module first, then mechanically regenerate its matching review copy",
      );
    }
    const browserDeliveryIssue = approvalBrowserDeliveryIssue(event);
    if (browserDeliveryIssue) {
      throw new Error(
        `approval effect is not browser-deliverable: ${browserDeliveryIssue}; vendor the SDK behind a relative browser URL or add a matching import map, then cold-restart verification before acknowledging`,
      );
    }
    if (acknowledgementExists()) return;
    if (!currentRun()) throw new Error("the current run changed before acknowledgement");
    appendDurable(
      ackFile,
      {
        ts: new Date().toISOString(),
        run_id: runId,
        event_id: eventId,
        status: "handled",
      },
      MAX_JOURNAL_BYTES,
    );
  } finally {
    releaseLock();
  }
}

try {
  await main();
  console.log(JSON.stringify({ run_id: runId, event_id: eventId, status: "handled" }));
} catch (error) {
  console.error(`refusing to acknowledge: ${(error as Error).message}`);
  process.exit(1);
}
