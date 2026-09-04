import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

export const SERVICE = "webmcp-explorer";
export const PROTOCOL_VERSION = 1;
export const MAX_JOURNAL_LINE_BYTES = 64 * 1024;
export const MAX_JOURNAL_BYTES = 64 * 1024 * 1024;
export const MAX_REQUEST_BYTES = MAX_JOURNAL_LINE_BYTES;
export const MAX_REQUEST_ID_BYTES = 128;
export const MAX_IDENTIFIER_BYTES = 256;
export const MAX_TEXT_BYTES = 16 * 1024;
export const MAX_PICKS = 100;

export const REQUEST_TYPES = [
  "pick",
  "comment",
  "feedback",
  "submit",
  "approve",
  "cancel",
  "connect",
] as const;
export type RequestType = (typeof REQUEST_TYPES)[number];

export type CanonicalPayload =
  | { suggestion: string; picked: boolean }
  | { suggestion: string | null; text: string }
  | { picks: Array<{ suggestion: string; note: string }> }
  | { action: "connect" | "skip" }
  | Record<string, never>;

export interface RecordedEnvelope {
  event_id: string;
  run_id: string;
  order: number;
  type: RequestType;
  ts: string;
  payload: CanonicalPayload;
}

export interface RunFileV1 {
  version: 1;
  run_id: string;
  capability: string;
  workspace: string;
  port: number;
  pid: number;
  started_at: string;
}

export interface ValidRequest {
  request_id: string;
  type: RequestType;
  payload: CanonicalPayload;
}

export type RequestValidation =
  | { ok: true; value: ValidRequest }
  | { ok: false; request_id?: string; message: string };

export class AppendLimitError extends Error {
  constructor() {
    super("append would exceed the journal byte limit");
    this.name = "AppendLimitError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TYPES = new Set<string>(REQUEST_TYPES);

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

export function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, i) => key === expected[i]);
}

function boundedString(
  value: unknown,
  maxBytes: number,
  options: { allowEmpty?: boolean; identifier?: boolean } = {},
): value is string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maxBytes) return false;
  if (!options.allowEmpty && value.trim().length === 0) return false;
  if (options.identifier && (value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value))) return false;
  return true;
}

function validSuggestion(value: unknown): value is string {
  return boundedString(value, MAX_IDENTIFIER_BYTES, { identifier: true });
}

function canonicalPayload(type: RequestType, payload: unknown): CanonicalPayload | null {
  if (!isPlainObject(payload)) return null;
  if (type === "pick") {
    if (!hasOnlyKeys(payload, ["suggestion", "picked"])) return null;
    if (!validSuggestion(payload.suggestion) || typeof payload.picked !== "boolean") return null;
    return { suggestion: payload.suggestion, picked: payload.picked };
  }
  if (type === "comment" || type === "feedback") {
    if (!hasOnlyKeys(payload, ["suggestion", "text"])) return null;
    if (payload.suggestion !== null && !validSuggestion(payload.suggestion)) return null;
    if (!boundedString(payload.text, MAX_TEXT_BYTES)) return null;
    return { suggestion: payload.suggestion, text: payload.text } as {
      suggestion: string | null;
      text: string;
    };
  }
  if (type === "submit") {
    if (!hasOnlyKeys(payload, ["picks"]) || !Array.isArray(payload.picks)) return null;
    if (payload.picks.length > MAX_PICKS) return null;
    const picks: Array<{ suggestion: string; note: string }> = [];
    for (const pick of payload.picks) {
      if (!isPlainObject(pick) || !hasOnlyKeys(pick, ["suggestion", "note"])) return null;
      if (!validSuggestion(pick.suggestion)) return null;
      if (!boundedString(pick.note, MAX_TEXT_BYTES, { allowEmpty: true })) return null;
      picks.push({ suggestion: pick.suggestion, note: pick.note });
    }
    return { picks };
  }
  if (type === "connect") {
    if (!hasOnlyKeys(payload, ["action"])) return null;
    if (payload.action !== "connect" && payload.action !== "skip") return null;
    return { action: payload.action };
  }
  if (!hasOnlyKeys(payload, [])) return null;
  return {};
}

export function validateRequest(value: unknown): RequestValidation {
  if (!isPlainObject(value)) return { ok: false, message: "Request must be a JSON object." };
  const candidateRequestId = boundedString(value.request_id, MAX_REQUEST_ID_BYTES, {
    identifier: true,
  })
    ? value.request_id
    : undefined;
  if (!hasOnlyKeys(value, ["request_id", "type", "payload"])) {
    return { ok: false, request_id: candidateRequestId, message: "Invalid request envelope." };
  }
  if (!candidateRequestId) return { ok: false, message: "Invalid request_id." };
  if (typeof value.type !== "string" || !TYPES.has(value.type)) {
    return { ok: false, request_id: candidateRequestId, message: "Unknown event type." };
  }
  const type = value.type as RequestType;
  const payload = canonicalPayload(type, value.payload);
  if (payload === null) {
    return { ok: false, request_id: candidateRequestId, message: `Invalid ${type} payload.` };
  }
  return { ok: true, value: { request_id: candidateRequestId, type, payload } };
}

export function parseRunFile(value: unknown): RunFileV1 | null {
  if (!isPlainObject(value)) return null;
  if (
    !hasOnlyKeys(value, [
      "version",
      "run_id",
      "capability",
      "workspace",
      "port",
      "pid",
      "started_at",
    ]) ||
    value.version !== PROTOCOL_VERSION ||
    !isUuid(value.run_id) ||
    !isUuid(value.capability) ||
    value.run_id === value.capability ||
    typeof value.workspace !== "string" ||
    value.workspace.length === 0 ||
    !Number.isInteger(value.port) ||
    (value.port as number) < 1 ||
    (value.port as number) > 65535 ||
    !Number.isSafeInteger(value.pid) ||
    (value.pid as number) < 1 ||
    !isIsoTimestamp(value.started_at)
  ) {
    return null;
  }
  return value as unknown as RunFileV1;
}

export function parseRecordedEnvelope(value: unknown): RecordedEnvelope | null {
  if (!isPlainObject(value)) return null;
  if (
    !hasOnlyKeys(value, ["event_id", "run_id", "order", "type", "ts", "payload"]) ||
    !isUuid(value.event_id) ||
    !isUuid(value.run_id) ||
    !Number.isSafeInteger(value.order) ||
    (value.order as number) < 1 ||
    typeof value.type !== "string" ||
    !TYPES.has(value.type) ||
    !isIsoTimestamp(value.ts)
  ) {
    return null;
  }
  const payload = canonicalPayload(value.type as RequestType, value.payload);
  if (payload === null) return null;
  return {
    event_id: value.event_id,
    run_id: value.run_id,
    order: value.order as number,
    type: value.type as RequestType,
    ts: value.ts,
    payload,
  };
}

export function readRegularText(path: string, maxBytes = Number.POSITIVE_INFINITY): string | null {
  let before;
  try {
    before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) return null;
  } catch {
    return null;
  }
  portablePathTestBarrier("read", path);
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | noFollowFlag());
    const after = fstatSync(fd);
    if (
      !after.isFile() ||
      after.size > maxBytes ||
      !sameFile(before, after) ||
      !pathNamesFile(path, after)
    ) {
      return null;
    }
    return readFileSync(fd, "utf8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function appendDurable(
  path: string,
  value: unknown,
  maxBytes = Number.POSITIVE_INFINITY,
): void {
  const buffer = Buffer.from(`\n${JSON.stringify(value)}\n`, "utf8");
  for (let attempt = 0; attempt < 8; attempt++) {
    let before;
    try {
      before = lstatSync(path);
      if (!before.isFile() || before.isSymbolicLink()) {
        throw new Error("destination is not a regular file");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (before) portablePathTestBarrier("append", path);

    let fd: number | undefined;
    try {
      if (before) {
        try {
          fd = openSync(path, constants.O_APPEND | constants.O_WRONLY | noFollowFlag());
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        const opened = fstatSync(fd);
        if (!opened.isFile() || !sameFile(before, opened) || !pathNamesFile(path, opened)) {
          throw new Error("destination identity changed before append");
        }
      } else {
        try {
          fd = openSync(
            path,
            constants.O_APPEND |
              constants.O_CREAT |
              constants.O_EXCL |
              constants.O_WRONLY |
              noFollowFlag(),
            0o644,
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
          throw error;
        }
        const opened = fstatSync(fd);
        if (!opened.isFile() || !pathNamesFile(path, opened)) {
          throw new Error("new append destination lost its identity");
        }
      }
      // Identity is proven before the first byte reaches either a pre-existing or newly
      // created file. This is the Windows fallback for O_NOFOLLOW and defense in depth on
      // platforms that provide it.
      if (fstatSync(fd).size + buffer.length > maxBytes) throw new AppendLimitError();
      const written = writeSync(fd, buffer, 0, buffer.length);
      if (written !== buffer.length) throw new Error(`short write (${written}/${buffer.length} bytes)`);
      fsyncSync(fd);
      return;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  throw new Error("destination stayed contended during append");
}

function noFollowFlag(): number {
  if (process.env.WEBMCP_TEST_DISABLE_NOFOLLOW === "1") return 0;
  return (constants as unknown as Record<string, number | undefined>).O_NOFOLLOW ?? 0;
}

function sameFile(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function pathNamesFile(path: string, opened: { dev: number; ino: number }): boolean {
  try {
    const current = lstatSync(path);
    return current.isFile() && !current.isSymbolicLink() && sameFile(current, opened);
  } catch {
    return false;
  }
}

// Deterministic test seam for swapping a final path after lstat but before open while
// O_NOFOLLOW is disabled. It is inert outside a deliberately configured subprocess.
function portablePathTestBarrier(operation: "read" | "append", path: string): void {
  const directory = process.env.WEBMCP_TEST_PATH_BARRIER;
  if (
    !directory ||
    process.env.WEBMCP_TEST_PATH_OPERATION !== operation ||
    process.env.WEBMCP_TEST_PATH_TARGET !== path
  ) {
    return;
  }
  const observed = join(directory, `${operation}-observed-${process.pid}`);
  const release = join(directory, `${operation}-release-${process.pid}`);
  let marker: number | undefined;
  try {
    marker = openSync(observed, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    if (marker !== undefined) closeSync(marker);
  }
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      if (lstatSync(release).isFile()) return;
    } catch {
      // Wait below.
    }
    if (Date.now() >= deadline) throw new Error("portable-path test barrier timed out");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}
