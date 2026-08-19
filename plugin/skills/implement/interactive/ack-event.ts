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
import { join } from "node:path";
import {
  MAX_JOURNAL_BYTES,
  appendDurable,
  isIsoTimestamp,
  isPlainObject,
  isUuid,
  parseRecordedEnvelope,
  parseRunFile,
  readRegularText,
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
const lockFile = join(stateDir, ".ack.lock");
const ACK_LOCK_MAX_AGE_MS = 5 * 60 * 1_000;
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

function eventExists(): boolean {
  const text = readRegularText(feedbackFile);
  if (text === null) return false;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const envelope = parseRecordedEnvelope(JSON.parse(line));
      if (envelope?.run_id === runId && envelope.event_id === eventId) return true;
    } catch {
      // Legacy, malformed, and partial lines can never authorize an acknowledgement.
    }
  }
  return false;
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
    if (!eventExists()) {
      throw new Error("event_id is not a canonical event in the matching current run");
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
