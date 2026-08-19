#!/usr/bin/env bun
/**
 * Lease and deliver WebMCP Explorer events through Codex lifecycle hooks.
 *
 * This file intentionally depends only on Bun and Node's built-in modules so the
 * published Agent Plugin remains a directory-copy install. Hook failures are
 * fail-open: malformed or unsafe local state never interrupts unrelated work.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { dirname, isAbsolute, join, parse } from "node:path";

const VERSION = 1;
const ACTIONABLE = new Set(["comment", "submit", "feedback", "approve", "cancel"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_INPUT_BYTES = 256 * 1024;
const MAX_RUN_BYTES = 16 * 1024;
const MAX_HEALTH_BYTES = 64 * 1024;
const MAX_STATE_BYTES = 16 * 1024;
const MAX_LINE_BYTES = 64 * 1024;
const MAX_JOURNAL_BYTES = 64 * 1024 * 1024;
const MAX_IDENTIFIER_BYTES = 256;
const MAX_TEXT_BYTES = 16 * 1024;
const MAX_PICKS = 100;
const DEFAULT_LEASE_MS = 15_000;
const DEFAULT_STOP_WAIT_MS = 25_000;
const DEFAULT_POLL_MS = 150;
const DEFAULT_HEALTH_TIMEOUT_MS = 500;
// The hook runner kills Stop after 35 seconds. A lock older than this ceiling
// cannot still belong to a supported live hook invocation, even if its PID was
// reused or a killed child remains visible to the OS.
const DEFAULT_LOCK_MAX_AGE_MS = 60_000;
const MIN_LOCK_MAX_AGE_MS = 36_000;
const DEFAULT_LOCK_WAIT_MS = 250;
const LOCK_RETRY_POLL_MS = 10;
const DEFAULT_LAUNCH_INTENT_MS = 60_000;
const DEAD_OWNER_REAP_GRACE_MS = 20;
const ORPHAN_LOCK_REAP_GRACE_MS = 2_000;
const NOFOLLOW = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;

type JsonObject = Record<string, unknown>;
type HookMode = "pre-tool-use" | "stop";
type DeliveryState = "waiting" | "claimed" | "timeout" | "conflict" | "error";

interface HookInput {
  eventName: "PreToolUse" | "Stop";
  sessionId: string;
  cwd: string;
  stopHookActive: boolean;
  toolName: string | null;
  toolCommand: string | null;
}

interface PluginPaths {
  root: string;
  ack: string;
  server: string;
}

interface LaunchIntent {
  version: 1;
  session_id: string;
  workspace: string;
  created_at: string;
  expires_at_ms: number;
  resume_run_id: string | null;
  resume_capability: string | null;
}

interface CanonicalLaunch {
  workspace: string;
  resume: boolean;
}

interface Runtime {
  runId: string;
  capability: string;
  workspace: string;
  port: number;
  pid: number;
  startedAt: string;
  stateDir: string;
  runPath: string;
}

interface Event {
  eventId: string;
  runId: string;
  order: number;
  type: string;
  ts: string;
  payload: JsonObject;
  raw: JsonObject;
  lineNumber: number;
}

interface Claim {
  event_id: string;
  order: number;
  claimed_at: string;
  lease_expires_ms: number;
}

interface State {
  version: 1;
  session_id: string;
  workspace: string;
  run_id: string;
  capability: string;
  claim: Claim | null;
}

type ClaimResult =
  | { kind: "claimed"; event: Event; lastOrder: number }
  | { kind: "empty"; lastOrder: number }
  | { kind: "busy" | "error"; lastOrder: number };

class UnsafeState extends Error {}
class LockBusy extends Error {}

function nowIso(): string {
  return new Date(wallClockMs()).toISOString();
}

function wallClockMs(): number {
  const testValue = process.env.WEBMCP_HOOK_TEST_NOW_MS;
  if (testValue !== undefined) {
    const value = Number(testValue);
    if (Number.isFinite(value)) return value;
  }
  return Date.now();
}

function envMs(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, minimum), maximum);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: JsonObject, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function boundedString(value: unknown, maxBytes: number, allowEmpty = false): value is string {
  return (
    typeof value === "string" &&
    byteLength(value) <= maxBytes &&
    (allowEmpty || value.trim().length > 0)
  );
}

function validIdentifier(value: unknown): value is string {
  return (
    boundedString(value, MAX_IDENTIFIER_BYTES) &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function validSessionId(value: unknown): value is string {
  return boundedString(value, 256) && !/[\u0000-\u001f\u007f]/.test(value);
}

function validIso(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return false;
  const millis = Date.parse(value);
  return Number.isFinite(millis) && new Date(millis).toISOString() === value;
}

function isRealDirectory(path: string): boolean {
  try {
    const info = lstatSync(path);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function sameFileIdentity(before: Stats, opened: Stats): boolean {
  const hasDeviceInode =
    before.dev !== 0 || before.ino !== 0 || opened.dev !== 0 || opened.ino !== 0;
  if (hasDeviceInode) return before.dev === opened.dev && before.ino === opened.ino;
  // Some Windows filesystems do not expose dev/ino. Birth time is stable for
  // an opened file while size and mtime may legitimately change on journals.
  return (
    Number.isFinite(before.birthtimeMs) &&
    before.birthtimeMs > 0 &&
    before.birthtimeMs === opened.birthtimeMs
  );
}

function readRegular(path: string, maxBytes: number): Buffer | null {
  let fd: number | undefined;
  try {
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) {
      throw new UnsafeState(`unsafe size or type for ${path}`);
    }
    fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
    const opened = fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.size > maxBytes ||
      !sameFileIdentity(before, opened)
    ) {
      throw new UnsafeState(`unsafe opened file ${path}`);
    }
    const data = readFileSync(fd);
    if (data.byteLength > maxBytes) throw new UnsafeState(`oversized ${path}`);
    return data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof UnsafeState) throw error;
    throw new UnsafeState(`cannot read ${path}`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

async function readHookInput(): Promise<HookInput | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = Bun.stdin.stream().getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_INPUT_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(Buffer.from(value));
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
  const data = Buffer.concat(chunks, total);
  let value: unknown;
  try {
    value = JSON.parse(data.toString("utf8"));
  } catch {
    return null;
  }
  if (!isObject(value)) return null;
  const eventName = value.hook_event_name;
  const sessionId = value.session_id;
  const cwd = value.cwd;
  const stopHookActive = value.stop_hook_active ?? false;
  const toolName = value.tool_name ?? null;
  const toolInput = value.tool_input ?? null;
  const toolCommand = isObject(toolInput) ? (toolInput.command ?? null) : null;
  if (
    (eventName !== "PreToolUse" && eventName !== "Stop") ||
    !validSessionId(sessionId) ||
    typeof cwd !== "string" ||
    !isAbsolute(cwd) ||
    cwd.includes("\0") ||
    byteLength(cwd) > 4_096 ||
    typeof stopHookActive !== "boolean" ||
    (toolName !== null && !validIdentifier(toolName)) ||
    (toolInput !== null && !isObject(toolInput)) ||
    (toolCommand !== null &&
      (typeof toolCommand !== "string" || byteLength(toolCommand) > MAX_LINE_BYTES))
  ) {
    return null;
  }
  return {
    eventName,
    sessionId,
    cwd,
    stopHookActive,
    toolName: toolName as string | null,
    toolCommand: toolCommand as string | null,
  };
}

function validPayload(type: string, payload: unknown): payload is JsonObject {
  if (!isObject(payload)) return false;
  if (type === "comment" || type === "feedback") {
    return (
      hasExactKeys(payload, ["suggestion", "text"]) &&
      (payload.suggestion === null || validIdentifier(payload.suggestion)) &&
      boundedString(payload.text, MAX_TEXT_BYTES)
    );
  }
  if (type === "submit") {
    if (!hasExactKeys(payload, ["picks"]) || !Array.isArray(payload.picks)) return false;
    if (payload.picks.length > MAX_PICKS) return false;
    return payload.picks.every(
      (pick) =>
        isObject(pick) &&
        hasExactKeys(pick, ["suggestion", "note"]) &&
        validIdentifier(pick.suggestion) &&
        boundedString(pick.note, MAX_TEXT_BYTES, true),
    );
  }
  return (type === "approve" || type === "cancel") && hasExactKeys(payload, []);
}

function runtimeAt(workspace: string): Runtime | null {
  const stateDir = join(workspace, ".webmcp");
  const runPath = join(stateDir, ".run.json");
  if (!isRealDirectory(stateDir)) return null;
  let value: unknown;
  try {
    const data = readRegular(runPath, MAX_RUN_BYTES);
    if (data === null) return null;
    value = JSON.parse(data.toString("utf8"));
  } catch {
    return null;
  }
  if (
    !isObject(value) ||
    !hasExactKeys(value, [
      "version",
      "run_id",
      "capability",
      "workspace",
      "port",
      "pid",
      "started_at",
    ]) ||
    value.version !== VERSION ||
    typeof value.run_id !== "string" ||
    !UUID.test(value.run_id) ||
    typeof value.capability !== "string" ||
    !UUID.test(value.capability) ||
    value.capability === value.run_id ||
    typeof value.workspace !== "string" ||
    !isAbsolute(value.workspace) ||
    !boundedString(value.workspace, 4_096) ||
    !Number.isInteger(value.port) ||
    (value.port as number) < 1 ||
    (value.port as number) > 65_535 ||
    !Number.isSafeInteger(value.pid) ||
    (value.pid as number) < 1 ||
    !validIso(value.started_at)
  ) {
    return null;
  }
  let canonical: string;
  try {
    canonical = realpathSync(workspace);
    if (value.workspace !== canonical || realpathSync(value.workspace) !== canonical) return null;
  } catch {
    return null;
  }
  return {
    runId: value.run_id,
    capability: value.capability,
    workspace: canonical,
    port: value.port as number,
    pid: value.pid as number,
    startedAt: value.started_at,
    stateDir,
    runPath,
  };
}

function discoverRuntime(cwd: string): Runtime | null {
  let current: string;
  try {
    current = realpathSync(cwd);
  } catch {
    return null;
  }
  if (!isRealDirectory(current)) return null;
  const root = parse(current).root;
  while (true) {
    const runtime = runtimeAt(current);
    if (runtime !== null) return runtime;
    if (current === root) return null;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function sameRuntime(left: Runtime, right: Runtime | null): boolean {
  return (
    right !== null &&
    left.runId === right.runId &&
    left.capability === right.capability &&
    left.workspace === right.workspace &&
    left.port === right.port &&
    left.pid === right.pid &&
    left.startedAt === right.startedAt &&
    left.stateDir === right.stateDir &&
    left.runPath === right.runPath
  );
}

async function responseBodyLimited(response: Response, maxBytes: number): Promise<Buffer | null> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isFinite(length) || length < 0 || length > maxBytes) return null;
  }
  if (response.body === null) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

async function liveRuntime(runtime: Runtime): Promise<boolean> {
  const query = new URLSearchParams({
    capability: runtime.capability,
    run_id: runtime.runId,
  });
  const timeout = envMs(
    "WEBMCP_HOOK_HEALTH_TIMEOUT_MS",
    DEFAULT_HEALTH_TIMEOUT_MS,
    25,
    5_000,
  );
  try {
    const response = await fetch(`http://127.0.0.1:${runtime.port}/healthz?${query}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) return false;
    const data = await responseBodyLimited(response, MAX_HEALTH_BYTES);
    if (data === null) return false;
    const value: unknown = JSON.parse(data.toString("utf8"));
    return (
      isObject(value) &&
      value.service === "webmcp-explorer" &&
      value.version === VERSION &&
      value.run_id === runtime.runId &&
      value.workspace === runtime.workspace
    );
  } catch {
    return false;
  }
}

function parseEvent(value: unknown, runtime: Runtime, lineNumber: number): Event | null {
  if (
    !isObject(value) ||
    !hasExactKeys(value, ["event_id", "run_id", "order", "type", "ts", "payload"]) ||
    typeof value.event_id !== "string" ||
    !UUID.test(value.event_id) ||
    value.run_id !== runtime.runId ||
    !Number.isSafeInteger(value.order) ||
    (value.order as number) < 1 ||
    typeof value.type !== "string" ||
    !ACTIONABLE.has(value.type) ||
    !validIso(value.ts) ||
    !validPayload(value.type, value.payload)
  ) {
    return null;
  }
  return {
    eventId: value.event_id,
    runId: runtime.runId,
    order: value.order as number,
    type: value.type,
    ts: value.ts,
    payload: value.payload,
    raw: value,
    lineNumber,
  };
}

function ndjson(path: string): Array<[number, unknown]> {
  const data = readRegular(path, MAX_JOURNAL_BYTES);
  if (data === null) return [];
  const values: Array<[number, unknown]> = [];
  const lines = data.toString("utf8").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim().length === 0 || byteLength(line) > MAX_LINE_BYTES) continue;
    try {
      values.push([index + 1, JSON.parse(line)]);
    } catch {
      // A malformed immutable line is ignored without changing later line identity.
    }
  }
  return values;
}

function feedbackEvents(runtime: Runtime): Event[] {
  const events: Event[] = [];
  const seen = new Set<string>();
  for (const [lineNumber, value] of ndjson(join(runtime.stateDir, "_feedback.ndjson"))) {
    const event = parseEvent(value, runtime, lineNumber);
    if (event === null || seen.has(event.eventId)) continue;
    seen.add(event.eventId);
    events.push(event);
  }
  return events.sort((left, right) => left.order - right.order || left.lineNumber - right.lineNumber);
}

function handledEventIds(runtime: Runtime): Set<string> {
  const handled = new Set<string>();
  for (const [, value] of ndjson(join(runtime.stateDir, "_ack.ndjson"))) {
    if (
      isObject(value) &&
      hasExactKeys(value, ["ts", "run_id", "event_id", "status"]) &&
      value.run_id === runtime.runId &&
      value.status === "handled" &&
      typeof value.event_id === "string" &&
      UUID.test(value.event_id) &&
      validIso(value.ts)
    ) {
      handled.add(value.event_id);
    }
  }
  return handled;
}

function safeAppend(path: string, value: JsonObject): boolean {
  let fd: number | undefined;
  try {
    let before: Stats | null = null;
    if (pathExists(path)) {
      before = lstatSync(path);
      if (!before.isFile() || before.isSymbolicLink()) return false;
      if (before.size > MAX_JOURNAL_BYTES) return false;
    }
    const data = Buffer.from(`\n${JSON.stringify(value)}\n`, "utf8");
    if (data.byteLength > MAX_LINE_BYTES) return false;
    fd = openSync(
      path,
      constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | NOFOLLOW,
      0o644,
    );
    const opened = fstatSync(fd);
    const after = lstatSync(path);
    if (
      !opened.isFile() ||
      !after.isFile() ||
      after.isSymbolicLink() ||
      opened.size + data.byteLength > MAX_JOURNAL_BYTES ||
      (!sameFileIdentity(after, opened) ||
        (before !== null && !sameFileIdentity(before, opened)))
    ) {
      return false;
    }
    const written = writeSync(fd, data, 0, data.byteLength);
    if (written !== data.byteLength) return false;
    fsyncSync(fd);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function atomicReplaceRegular(path: string, data: string, maxBytes: number): void {
  if (byteLength(data) > maxBytes) throw new UnsafeState("private state is oversized");
  if (pathExists(path)) {
    const existing = lstatSync(path);
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new UnsafeState("private state path is unsafe");
    }
  }
  const tempPath = `${path}.tmp.${process.pid}.${randomUUID()}`;
  try {
    writeFileSync(tempPath, data, { encoding: "utf8", flag: "wx", mode: 0o600 });
    let fd: number | undefined;
    try {
      fd = openSync(tempPath, constants.O_RDONLY | NOFOLLOW);
      fsyncSync(fd);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    renameSync(tempPath, path);
  } finally {
    try {
      rmSync(tempPath, { force: true });
    } catch {}
  }
}

function pluginStateBase(): string {
  const pluginData = process.env.PLUGIN_DATA;
  if (!pluginData || !isAbsolute(pluginData)) {
    throw new UnsafeState("PLUGIN_DATA must be an absolute path");
  }
  // Released Codex (<= 0.148.0) points PLUGIN_DATA at a directory it never
  // creates (NEK-779), so create-then-verify — the same discipline as the
  // versioned state dir below. A symlink or non-directory still fails closed:
  // mkdir errors are ignored only because isRealDirectory re-checks the result.
  if (!isRealDirectory(pluginData)) {
    try {
      mkdirSync(pluginData, { recursive: true, mode: 0o700 });
    } catch {}
    if (!isRealDirectory(pluginData)) {
      throw new UnsafeState("PLUGIN_DATA must be a real directory");
    }
  }
  const base = join(pluginData, "webmcp-feedback-v1");
  try {
    mkdirSync(base, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !isRealDirectory(base)) {
      throw new UnsafeState("private state directory is unsafe");
    }
  }
  if (!isRealDirectory(base)) throw new UnsafeState("private state directory is unsafe");
  return base;
}

function appendDelivery(
  runtime: Runtime,
  hookInput: HookInput,
  state: DeliveryState,
  event?: Event,
  emptyQueue?: { queueDepth: 0; lastOrder: number },
): boolean {
  if (!isRealDirectory(runtime.stateDir)) return false;
  const record: JsonObject = {
    ts: nowIso(),
    run_id: runtime.runId,
    state,
    session_id: hookInput.sessionId,
    hook: hookInput.eventName,
  };
  if (event !== undefined) {
    record.event_id = event.eventId;
    record.order = event.order;
  }
  if (state === "waiting" || state === "timeout") {
    if (emptyQueue === undefined || emptyQueue.queueDepth !== 0) return false;
    record.queue_depth = 0;
    record.last_order = emptyQueue.lastOrder;
  }
  return safeAppend(join(runtime.stateDir, "_delivery.ndjson"), record);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface LockOwner {
  version: 1;
  token: string;
  pid: number;
  created_at_ms: number;
}

function parseLockOwner(value: unknown): LockOwner | null {
  if (
    !isObject(value) ||
    !hasExactKeys(value, ["version", "token", "pid", "created_at_ms"]) ||
    value.version !== VERSION ||
    typeof value.token !== "string" ||
    !UUID.test(value.token) ||
    !Number.isSafeInteger(value.pid) ||
    (value.pid as number) < 1 ||
    typeof value.created_at_ms !== "number" ||
    !Number.isFinite(value.created_at_ms)
  ) {
    return null;
  }
  return value as unknown as LockOwner;
}

class PortableLock {
  readonly path: string;
  readonly token = randomUUID();
  private held = false;

  constructor(path: string) {
    this.path = path;
  }

  private tryCreate(): boolean {
    const candidatePath = `${this.path}.candidate.${this.token}`;
    let candidateIdentity: Stats | null = null;
    try {
      mkdirSync(candidatePath, { mode: 0o700 });
      candidateIdentity = lstatSync(candidatePath);
      if (process.env.WEBMCP_HOOK_TEST_CRASH_AFTER_LOCK_CANDIDATE === "1") process.exit(87);
      const owner: LockOwner = {
        version: VERSION,
        token: this.token,
        pid: process.pid,
        created_at_ms: Date.now(),
      };
      writeFileSync(join(candidatePath, "owner.json"), `${JSON.stringify(owner)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      // Publish a fully initialized lock in one filesystem operation. A crash
      // before this rename can leave only a uniquely named candidate, never an
      // ownerless canonical lock that blocks future hook processes.
      renameSync(candidatePath, this.path);
      this.held = true;
      return true;
    } catch (error) {
      try {
        if (candidateIdentity !== null && isRealDirectory(candidatePath)) {
          const currentIdentity = lstatSync(candidatePath);
          if (sameFileIdentity(candidateIdentity, currentIdentity)) {
            rmSync(candidatePath, { recursive: true, force: true });
          }
        }
      } catch {}
      if (pathExists(this.path)) return false;
      throw new UnsafeState("could not create private lock");
    }
  }

  private readOwner(): LockOwner | null {
    if (!isRealDirectory(this.path)) return null;
    try {
      const data = readRegular(join(this.path, "owner.json"), MAX_STATE_BYTES);
      return data === null ? null : parseLockOwner(JSON.parse(data.toString("utf8")));
    } catch {
      return null;
    }
  }

  acquire(): void {
    if (this.tryCreate()) return;
    if (!isRealDirectory(this.path)) throw new UnsafeState("private lock path is unsafe");
    const owner = this.readOwner();
    const maxAge = envMs(
      "WEBMCP_HOOK_LOCK_MAX_AGE_MS",
      DEFAULT_LOCK_MAX_AGE_MS,
      MIN_LOCK_MAX_AGE_MS,
      24 * 60 * 60 * 1_000,
    );
    if (owner === null) {
      let age: number;
      try {
        age = Date.now() - statSync(this.path).mtimeMs;
      } catch {
        throw new LockBusy("private lock changed while being inspected");
      }
      if (age < ORPHAN_LOCK_REAP_GRACE_MS) {
        throw new LockBusy("private lock is initializing");
      }
    } else {
      const age = Date.now() - owner.created_at_ms;
      if (age < DEAD_OWNER_REAP_GRACE_MS || (age < maxAge && isProcessAlive(owner.pid))) {
        throw new LockBusy("private lock is held");
      }
    }

    // Rename first: only one contender can quarantine this crashed owner's
    // directory, and a new owner can acquire the canonical name immediately.
    const tombstone = `${this.path}.reap.${this.token}`;
    try {
      renameSync(this.path, tombstone);
    } catch {
      throw new LockBusy("private lock changed while being recovered");
    }
    try {
      const quarantined = (() => {
        try {
          const data = readRegular(join(tombstone, "owner.json"), MAX_STATE_BYTES);
          return data === null ? null : parseLockOwner(JSON.parse(data.toString("utf8")));
        } catch {
          return null;
        }
      })();
      const quarantineIsObservedOwner =
        owner !== null && quarantined !== null && quarantined.token === owner.token;
      const quarantineIsRecoverableOrphan =
        owner === null &&
        (quarantined === null ||
          (!isProcessAlive(quarantined.pid) &&
            Date.now() - quarantined.created_at_ms >= DEAD_OWNER_REAP_GRACE_MS) ||
          Date.now() - quarantined.created_at_ms >= maxAge);
      if (!quarantineIsObservedOwner && !quarantineIsRecoverableOrphan) {
        // Preserve an object we cannot prove is the crashed lock we observed.
        try {
          renameSync(tombstone, this.path);
        } catch {}
        throw new LockBusy("private lock ownership changed");
      }
      rmSync(tombstone, { recursive: true, force: true });
    } catch (error) {
      if (error instanceof LockBusy) throw error;
      throw new UnsafeState("could not recover private lock");
    }
    if (!this.tryCreate()) throw new LockBusy("private lock was reacquired");
  }

  release(): void {
    if (!this.held) return;
    try {
      const owner = this.readOwner();
      if (owner?.token === this.token) rmSync(this.path, { recursive: true, force: true });
    } catch {
      // A leaked lock is recovered by the next process after this process exits.
    } finally {
      this.held = false;
    }
  }
}

async function acquireWithRetry(lock: PortableLock): Promise<boolean> {
  const waitMs = envMs("WEBMCP_HOOK_LOCK_WAIT_MS", DEFAULT_LOCK_WAIT_MS, 25, 1_000);
  const deadline = performance.now() + waitMs;
  while (true) {
    try {
      lock.acquire();
      return true;
    } catch (error) {
      if (!(error instanceof LockBusy)) throw error;
      const remaining = deadline - performance.now();
      if (remaining <= 0) return false;
      await Bun.sleep(Math.min(LOCK_RETRY_POLL_MS, remaining));
    }
  }
}

function parseLaunchIntent(value: unknown): LaunchIntent | null {
  if (
    !isObject(value) ||
    !hasExactKeys(value, [
      "version",
      "session_id",
      "workspace",
      "created_at",
      "expires_at_ms",
      "resume_run_id",
      "resume_capability",
    ]) ||
    value.version !== VERSION ||
    !validSessionId(value.session_id) ||
    typeof value.workspace !== "string" ||
    !isAbsolute(value.workspace) ||
    !validIso(value.created_at) ||
    typeof value.expires_at_ms !== "number" ||
    !Number.isFinite(value.expires_at_ms) ||
    !(
      (value.resume_run_id === null && value.resume_capability === null) ||
      (typeof value.resume_run_id === "string" &&
        UUID.test(value.resume_run_id) &&
        typeof value.resume_capability === "string" &&
        UUID.test(value.resume_capability) &&
        value.resume_run_id !== value.resume_capability)
    )
  ) {
    return null;
  }
  return value as unknown as LaunchIntent;
}

class LaunchIntentStore {
  readonly statePath: string;
  readonly lock: PortableLock;
  readonly workspace: string;

  constructor(workspace: string) {
    const base = pluginStateBase();
    const binding = createHash("sha256").update(workspace).digest("hex");
    this.statePath = join(base, `launch-${binding}.json`);
    this.lock = new PortableLock(join(base, `launch-${binding}.lock`));
    this.workspace = workspace;
  }

  load(): LaunchIntent | null {
    const data = readRegular(this.statePath, MAX_STATE_BYTES);
    if (data === null) return null;
    let value: unknown;
    try {
      value = JSON.parse(data.toString("utf8"));
    } catch {
      throw new UnsafeState("launch intent is invalid JSON");
    }
    const intent = parseLaunchIntent(value);
    if (intent === null || intent.workspace !== this.workspace) {
      throw new UnsafeState("launch intent binding is invalid");
    }
    return intent;
  }

  save(intent: LaunchIntent): void {
    atomicReplaceRegular(this.statePath, `${JSON.stringify(intent)}\n`, MAX_STATE_BYTES);
  }

  remove(): void {
    if (!pathExists(this.statePath)) return;
    const existing = lstatSync(this.statePath);
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new UnsafeState("launch intent path is unsafe");
    }
    rmSync(this.statePath);
  }
}

class RunStore {
  readonly base: string;
  readonly statePath: string;
  readonly lock: PortableLock;
  readonly runtime: Runtime;
  readonly hookInput: HookInput;

  constructor(runtime: Runtime, hookInput: HookInput) {
    this.base = pluginStateBase();
    const binding = createHash("sha256")
      .update(`${runtime.workspace}\0${runtime.runId}`)
      .digest("hex");
    this.statePath = join(this.base, `${binding}.json`);
    this.lock = new PortableLock(join(this.base, `${binding}.lock`));
    this.runtime = runtime;
    this.hookInput = hookInput;
  }

  initialState(): State {
    return {
      version: VERSION,
      session_id: this.hookInput.sessionId,
      workspace: this.runtime.workspace,
      run_id: this.runtime.runId,
      capability: this.runtime.capability,
      claim: null,
    };
  }

  load(): State | null {
    const data = readRegular(this.statePath, MAX_STATE_BYTES);
    if (data === null) return null;
    let value: unknown;
    try {
      value = JSON.parse(data.toString("utf8"));
    } catch {
      throw new UnsafeState("private state is invalid JSON");
    }
    if (
      !isObject(value) ||
      !hasExactKeys(value, [
        "version",
        "session_id",
        "workspace",
        "run_id",
        "capability",
        "claim",
      ]) ||
      value.version !== VERSION ||
      value.workspace !== this.runtime.workspace ||
      value.run_id !== this.runtime.runId ||
      value.capability !== this.runtime.capability ||
      !validSessionId(value.session_id)
    ) {
      throw new UnsafeState("private state binding is invalid");
    }
    const claim = value.claim;
    if (
      claim !== null &&
      (!isObject(claim) ||
        !hasExactKeys(claim, ["event_id", "order", "claimed_at", "lease_expires_ms"]) ||
        typeof claim.event_id !== "string" ||
        !UUID.test(claim.event_id) ||
        !Number.isSafeInteger(claim.order) ||
        (claim.order as number) < 1 ||
        !validIso(claim.claimed_at) ||
        typeof claim.lease_expires_ms !== "number" ||
        !Number.isFinite(claim.lease_expires_ms))
    ) {
      throw new UnsafeState("private claim is invalid");
    }
    return value as unknown as State;
  }

  save(state: State): void {
    atomicReplaceRegular(this.statePath, `${JSON.stringify(state)}\n`, MAX_STATE_BYTES);
  }
}

async function recordLaunchIntent(
  workspace: string,
  hookInput: HookInput,
  resume: boolean,
  priorRuntime: Runtime | null,
): Promise<void> {
  let store: LaunchIntentStore | undefined;
  let establishedStore: RunStore | undefined;
  try {
    if (resume) {
      if (priorRuntime === null) return;
      establishedStore = new RunStore(priorRuntime, hookInput);
      if (!(await acquireWithRetry(establishedStore.lock))) return;
      const established = establishedStore.load();
      if (established === null || established.session_id !== hookInput.sessionId) return;
    }
    store = new LaunchIntentStore(workspace);
    if (!(await acquireWithRetry(store.lock))) return;
    const now = wallClockMs();
    const existing = store.load();
    if (existing !== null && existing.expires_at_ms > now) {
      // First writer owns the launch. Only that same session may extend the
      // short recovery window while it is actively retrying the canonical
      // command (for example, after a permission prompt or startup lease).
      // Keep created_at as the beginning of this attempt span so a runtime
      // started between retries can still be attributed to it.
      const sameTarget = resume
        ? existing.resume_run_id === priorRuntime?.runId &&
          existing.resume_capability === priorRuntime.capability
        : existing.resume_run_id === null && existing.resume_capability === null;
      if (existing.session_id === hookInput.sessionId && sameTarget) {
        const ttl = envMs(
          "WEBMCP_HOOK_LAUNCH_INTENT_MS",
          DEFAULT_LAUNCH_INTENT_MS,
          1_000,
          5 * 60_000,
        );
        store.save({
          ...existing,
          expires_at_ms: Math.max(existing.expires_at_ms, now + ttl),
        });
      }
      return;
    }
    if (existing !== null) store.remove();
    const ttl = envMs(
      "WEBMCP_HOOK_LAUNCH_INTENT_MS",
      DEFAULT_LAUNCH_INTENT_MS,
      1_000,
      5 * 60_000,
    );
    store.save({
      version: VERSION,
      session_id: hookInput.sessionId,
      workspace,
      created_at: nowIso(),
      expires_at_ms: now + ttl,
      resume_run_id: resume ? priorRuntime!.runId : null,
      resume_capability: resume ? priorRuntime!.capability : null,
    });
  } catch {
    // Launch intents only narrow ownership. Failure to record one must not block
    // the server command or create ownership by fallback.
  } finally {
    store?.lock.release();
    establishedStore?.lock.release();
  }
}

async function consumeMatchingLaunchIntent(runtime: Runtime, sessionId: string): Promise<void> {
  let store: LaunchIntentStore | undefined;
  try {
    store = new LaunchIntentStore(runtime.workspace);
    if (!pathExists(store.statePath)) return;
    if (!(await acquireWithRetry(store.lock))) return;
    const intent = store.load();
    const exactResume =
      intent?.resume_run_id === runtime.runId &&
      intent.resume_capability === runtime.capability;
    const producedNormal =
      intent?.resume_run_id === null && launchIntentProducedRuntime(intent, runtime);
    if (intent?.session_id === sessionId && (exactResume || producedNormal)) {
      store.remove();
    }
  } catch {
    // Existing immutable run ownership is authoritative. Intent cleanup is
    // best-effort and must never disturb delivery for that established owner.
  } finally {
    store?.lock.release();
  }
}

function launchIntentProducedRuntime(intent: LaunchIntent, runtime: Runtime): boolean {
  const createdAtMs = Date.parse(intent.created_at);
  const startedAtMs = Date.parse(runtime.startedAt);
  return startedAtMs >= createdAtMs && startedAtMs <= intent.expires_at_ms;
}

async function pruneMismatchedResumeIntent(runtime: Runtime): Promise<void> {
  let store: LaunchIntentStore | undefined;
  try {
    store = new LaunchIntentStore(runtime.workspace);
    if (!pathExists(store.statePath) || !(await acquireWithRetry(store.lock))) return;
    const intent = store.load();
    if (
      intent !== null &&
      intent.resume_run_id !== null &&
      (intent.resume_run_id !== runtime.runId ||
        intent.resume_capability !== runtime.capability)
    ) {
      store.remove();
    }
  } catch {
    // A stale resume intent is cleanup-only here. Never disturb delivery when
    // its private file or lock cannot be verified safely.
  } finally {
    store?.lock.release();
  }
}

async function claimNext(runtime: Runtime, hookInput: HookInput): Promise<ClaimResult> {
  let events: Event[];
  try {
    events = feedbackEvents(runtime);
  } catch {
    appendDelivery(runtime, hookInput, "error");
    return { kind: "error", lastOrder: 0 };
  }
  let handled: Set<string>;
  try {
    handled = handledEventIds(runtime);
  } catch {
    // Without a trustworthy acknowledgement journal, no event can safely be
    // called unacknowledged. Keep this failure run-level.
    appendDelivery(runtime, hookInput, "error");
    return { kind: "error", lastOrder: 0 };
  }
  const lastOrder = events.reduce((maximum, event) => Math.max(maximum, event.order), 0);
  const oldestUnacked = events.find((candidate) => !handled.has(candidate.eventId));
  let store: RunStore | undefined;
  let intentStore: LaunchIntentStore | undefined;
  try {
    store = new RunStore(runtime, hookInput);
    const lockWaitMs = envMs("WEBMCP_HOOK_LOCK_WAIT_MS", DEFAULT_LOCK_WAIT_MS, 25, 1_000);
    const lockDeadline = performance.now() + lockWaitMs;
    while (true) {
      try {
        store.lock.acquire();
        break;
      } catch (error) {
        if (!(error instanceof LockBusy)) throw error;
        const remaining = lockDeadline - performance.now();
        if (remaining <= 0) {
          appendDelivery(runtime, hookInput, "conflict", oldestUnacked);
          return { kind: "busy", lastOrder };
        }
        await Bun.sleep(Math.min(LOCK_RETRY_POLL_MS, remaining));
      }
    }
    let state = store.load();
    if (state === null) {
      intentStore = new LaunchIntentStore(runtime.workspace);
      if (!(await acquireWithRetry(intentStore.lock))) {
        appendDelivery(runtime, hookInput, "conflict", oldestUnacked);
        return { kind: "busy", lastOrder };
      }
      const intent = intentStore.load();
      const intentProducedRuntime =
        intent !== null &&
        intent.resume_run_id === null &&
        launchIntentProducedRuntime(intent, runtime);
      if (!intentProducedRuntime) {
        if (intent !== null) intentStore.remove();
        if (oldestUnacked !== undefined) {
          appendDelivery(runtime, hookInput, "conflict", oldestUnacked);
        }
        return { kind: "busy", lastOrder };
      }
      if (intent.session_id !== hookInput.sessionId) {
        appendDelivery(runtime, hookInput, "conflict", oldestUnacked);
        return { kind: "busy", lastOrder };
      }
      state = store.initialState();
      store.save(state);
      intentStore.remove();
    }
    if (state.session_id !== hookInput.sessionId) {
      appendDelivery(runtime, hookInput, "conflict", oldestUnacked);
      return { kind: "busy", lastOrder };
    }
    if (intentStore === undefined) {
      // A documented --resume launch records a fresh creator intent before the
      // existing run comes back online. Consume only this established owner's
      // matching intent so it cannot pin the following normal run.
      await consumeMatchingLaunchIntent(runtime, hookInput.sessionId);
    }
    let claim = state.claim;
    const now = wallClockMs();
    if (claim !== null && handled.has(claim.event_id)) {
      state.claim = null;
      claim = null;
    }
    if (claim !== null && claim.lease_expires_ms > now) {
      return { kind: "busy", lastOrder: 0 };
    }
    if (claim !== null) state.claim = null;
    if (oldestUnacked === undefined) {
      store.save(state);
      return { kind: "empty", lastOrder };
    }
    const leaseMs = envMs("WEBMCP_HOOK_LEASE_MS", DEFAULT_LEASE_MS, 25, 300_000);
    state.claim = {
      event_id: oldestUnacked.eventId,
      order: oldestUnacked.order,
      claimed_at: nowIso(),
      lease_expires_ms: now + leaseMs,
    };
    store.save(state);
    if (!appendDelivery(runtime, hookInput, "claimed", oldestUnacked)) {
      state.claim = null;
      store.save(state);
      return { kind: "error", lastOrder };
    }
    if (process.env.WEBMCP_HOOK_TEST_CRASH_AFTER_CLAIM === "1") process.exit(86);
    return { kind: "claimed", event: oldestUnacked, lastOrder };
  } catch (error) {
    if (!(error instanceof LockBusy)) await pruneMismatchedResumeIntent(runtime);
    appendDelivery(runtime, hookInput, "error", oldestUnacked);
    return { kind: "error", lastOrder };
  } finally {
    intentStore?.lock.release();
    store?.lock.release();
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function commandQuote(value: string): string {
  if (process.platform === "win32") return `"${value.replaceAll('"', '""')}"`;
  return shellQuote(value);
}

function installedPluginPaths(): PluginPaths | null {
  const configuredRoot = process.env.PLUGIN_ROOT;
  if (!configuredRoot || !isAbsolute(configuredRoot) || !isRealDirectory(configuredRoot)) return null;
  try {
    const canonicalRoot = realpathSync(configuredRoot);
    const ackPath = join(canonicalRoot, "skills", "implement", "interactive", "ack-event.ts");
    const serverPath = join(canonicalRoot, "skills", "implement", "interactive", "server.ts");
    for (const path of [ackPath, serverPath]) {
      const info = lstatSync(path);
      if (!info.isFile() || info.isSymbolicLink()) return null;
    }
    return { root: canonicalRoot, ack: ackPath, server: serverPath };
  } catch {
    return null;
  }
}

function firstShellCommandWords(command: string): string[] | null {
  const words: string[] = [];
  let word = "";
  let quote: "single" | "double" | null = null;
  let escaped = false;
  const finishWord = () => {
    if (word.length > 0) {
      words.push(word);
      word = "";
    }
  };
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (escaped) {
      word += character;
      escaped = false;
      continue;
    }
    if (quote === "single") {
      if (character === "'") quote = null;
      else word += character;
      continue;
    }
    if (quote === "double") {
      if (character === '"') quote = null;
      else if (character === "\\" && process.platform !== "win32") {
        const next = command[index + 1];
        if (next !== undefined && ['"', "\\", "$", "`", "\n"].includes(next)) {
          escaped = true;
        } else {
          word += character;
        }
      } else word += character;
      continue;
    }
    if (character === "\\" && process.platform !== "win32") {
      escaped = true;
      continue;
    }
    if (character === "'") {
      quote = "single";
      continue;
    }
    if (character === '"') {
      quote = "double";
      continue;
    }
    if (/[;&|<>]/.test(character)) {
      finishWord();
      break;
    }
    if (/\s/.test(character)) {
      finishWord();
      continue;
    }
    word += character;
  }
  if (quote !== null || escaped) return null;
  finishWord();
  return words;
}

function canonicalLaunchWorkspace(hookInput: HookInput, serverPath: string): CanonicalLaunch | null {
  if (
    hookInput.eventName !== "PreToolUse" ||
    hookInput.toolName !== "Bash" ||
    hookInput.toolCommand === null
  ) {
    return null;
  }
  const words = firstShellCommandWords(hookInput.toolCommand);
  if (
    words === null ||
    words[0] !== "bun" ||
    words[1] !== serverPath ||
    (words.length !== 3 && !(words.length === 4 && words[3] === "--resume"))
  ) {
    return null;
  }
  try {
    if (!isAbsolute(words[2]!)) return null;
    const workspace = realpathSync(words[2]!);
    return isRealDirectory(workspace)
      ? { workspace, resume: words.length === 4 }
      : null;
  } catch {
    return null;
  }
}

function eventContext(runtime: Runtime, event: Event, ackPath: string): string {
  const compact = JSON.stringify(event.raw);
  const ackCommand =
    `bun ${commandQuote(ackPath)} ` +
    `${commandQuote(runtime.workspace)} ${commandQuote(runtime.runId)} ${commandQuote(event.eventId)}`;
  return (
    "A WebMCP Explorer action is pending. Handle this immutable event before continuing: " +
    `${compact}. After durably handling it, acknowledge only by running: ${ackCommand}. ` +
    "Never hand-write the acknowledgement journal, and do not acknowledge an intention or failed effect."
  );
}

function emitPreTool(runtime: Runtime, event: Event, ackPath: string): void {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: eventContext(runtime, event, ackPath),
      },
    }),
  );
}

function emitStop(runtime: Runtime, event: Event, ackPath: string): void {
  process.stdout.write(
    JSON.stringify({ decision: "block", reason: eventContext(runtime, event, ackPath) }),
  );
}

async function main(): Promise<void> {
  const mode = process.argv[2] as HookMode | undefined;
  const hookInput = await readHookInput();
  if (hookInput === null) return;
  if (mode === "pre-tool-use" && hookInput.eventName !== "PreToolUse") return;
  if (mode === "stop" && hookInput.eventName !== "Stop") return;
  if (mode !== "pre-tool-use" && mode !== "stop") return;
  if (mode === "stop" && hookInput.stopHookActive) return;
  const pluginPaths = installedPluginPaths();
  if (pluginPaths === null) return;
  if (mode === "pre-tool-use") {
    const launch = canonicalLaunchWorkspace(hookInput, pluginPaths.server);
    if (launch !== null) {
      const previousRuntime = runtimeAt(launch.workspace);
      if (previousRuntime === null || !(await liveRuntime(previousRuntime))) {
        await recordLaunchIntent(launch.workspace, hookInput, launch.resume, previousRuntime);
        return;
      }
    }
  }
  const runtime = discoverRuntime(hookInput.cwd);
  if (runtime === null || !(await liveRuntime(runtime))) return;

  let claim = await claimNext(runtime, hookInput);
  if (claim.kind === "claimed") {
    if (mode === "pre-tool-use") emitPreTool(runtime, claim.event, pluginPaths.ack);
    else emitStop(runtime, claim.event, pluginPaths.ack);
    return;
  }
  if (mode === "pre-tool-use" || claim.kind !== "empty") return;
  if (!appendDelivery(runtime, hookInput, "waiting", undefined, {
    queueDepth: 0,
    lastOrder: claim.lastOrder,
  })) {
    return;
  }

  const waitMs = envMs("WEBMCP_HOOK_STOP_WAIT_MS", DEFAULT_STOP_WAIT_MS, 25, 30_000);
  const pollMs = envMs("WEBMCP_HOOK_POLL_MS", DEFAULT_POLL_MS, 10, 2_000);
  const deadline = performance.now() + waitMs;
  let lastOrder = claim.lastOrder;
  while (performance.now() < deadline) {
    await Bun.sleep(Math.min(pollMs, Math.max(0, deadline - performance.now())));
    if (!sameRuntime(runtime, runtimeAt(runtime.workspace)) || !(await liveRuntime(runtime))) {
      appendDelivery(runtime, hookInput, "error");
      return;
    }
    claim = await claimNext(runtime, hookInput);
    if (claim.kind === "claimed") {
      emitStop(runtime, claim.event, pluginPaths.ack);
      return;
    }
    if (claim.kind !== "empty") return;
    lastOrder = claim.lastOrder;
  }
  appendDelivery(runtime, hookInput, "timeout", undefined, { queueDepth: 0, lastOrder });
}

try {
  await main();
} catch {
  // Hooks are advisory. Invalid state, missing runtimes, and environmental
  // failures must not break unrelated Codex work.
}
