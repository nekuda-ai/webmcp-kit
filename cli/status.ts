import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { CredentialStore } from "./credentials";
import { createCredentialStore } from "./credentials";
import {
  type ConnectFile,
  connectFilePath,
  connectLockPath,
  readConnectFile,
  tokenIdentity,
} from "./connect";
import { CliError, apiBaseFor, type LoginOptions } from "./login";

const SOURCE_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".vue",
  ".svelte",
]);
const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".webmcp",
  ".next",
  ".nuxt",
  ".output",
  ".svelte-kit",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "vendor",
]);

type EntryFact = {
  path: string;
  batches: BatchFact[];
  tracking_api_key: boolean;
  tracking_endpoint: boolean;
};

type BatchFact = {
  index: number;
  tracking_api_key: boolean;
  literal_api_key: string | null;
  tracking_endpoint: boolean;
  literal_endpoint: string | null;
};

export type StatusResult = {
  workspace: string;
  connect_file: { path: string; present: boolean; contents: ConnectFile | null };
  entry_modules: Array<Omit<EntryFact, "batches">>;
  registration_batches: Array<
    Omit<BatchFact, "literal_api_key" | "literal_endpoint"> & {
      path: string;
      tracking_api_key_matches: boolean | null;
      tracking_endpoint_matches: boolean | null;
    }
  >;
  tracking_api_key_present: boolean;
  tracking_api_key_matches: boolean | null;
  tracking_endpoint_matches: boolean | null;
  credentials: { present: boolean; account: string | null; org: string | null };
  online: { checked: boolean; key_enabled: boolean | null };
  flags: {
    already_connected: boolean;
    key_mismatch: boolean;
    key_revoked: boolean;
    another_session_may_be_running: boolean;
  };
};

export type StatusOptions = Pick<LoginOptions, "apiBase" | "fetch"> & {
  workspace: string;
  store?: CredentialStore;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extension(path: string): string {
  const match = path.match(/\.[^.\/]+$/);
  return match?.[0]?.toLowerCase() ?? "";
}

/** Remove comments without damaging quoted strings; enough to keep examples from becoming facts. */
function withoutComments(source: string): string {
  let output = "";
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i] ?? "";
    const next = source[i + 1] ?? "";
    if (quote) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      output += char;
      continue;
    }
    if (char === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      output += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 1;
      output += " ";
      continue;
    }
    output += char;
  }
  return output;
}

function trackingObjectAt(source: string, start: number): { body: string; end: number } | null {
  let depth = 0;
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const char = source[i] ?? "";
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") quote = char;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) {
      return { body: source.slice(start + 1, i), end: i + 1 };
    }
  }
  return null;
}

/** Keep structural punctuation and identifiers while hiding quoted example text. */
function structuralMask(source: string): string {
  let output = "";
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i] ?? "";
    if (quote) {
      output += " ";
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
    } else if (char === "'" || char === '"' || char === "`") {
      quote = char;
      output += " ";
    } else output += char;
  }
  return output;
}

/** Read only a direct `tracking: { ... }` property from an object-literal options arg. */
function topLevelTrackingObject(options: string): string | null {
  const mask = structuralMask(options);
  const outerStart = mask.search(/\S/);
  if (outerStart < 0 || mask[outerStart] !== "{") return null;
  let depth = 0;
  for (let i = outerStart; i < mask.length; i += 1) {
    const char = mask[i] ?? "";
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return null;
      continue;
    }
    if (depth !== 1 || (i > 0 && /[\w$]/.test(mask[i - 1] ?? ""))) continue;
    const property = /^tracking\s*:\s*\{/.exec(mask.slice(i));
    if (!property) continue;
    const brace = i + property[0].lastIndexOf("{");
    return trackingObjectAt(options, brace)?.body ?? null;
  }
  return null;
}

function callAt(source: string, start: number): { body: string; end: number } | null {
  let parentheses = 0;
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const char = source[i] ?? "";
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") quote = char;
    else if (char === "(") parentheses += 1;
    else if (char === ")" && --parentheses === 0) {
      return { body: source.slice(start + 1, i), end: i + 1 };
    }
  }
  return null;
}

function topLevelArguments(body: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i] ?? "";
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") quote = char;
    else if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") depth -= 1;
    else if (char === "," && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}

function registrationBatches(source: string): BatchFact[] {
  const batches: BatchFact[] = [];
  const pattern = /\bregisterTools\s*\(/g;
  const mask = structuralMask(source);
  for (let match = pattern.exec(mask); match; match = pattern.exec(mask)) {
    const previous = mask.slice(0, match.index).trimEnd().at(-1);
    if (previous === ".") continue;
    const start = match.index + match[0].length - 1;
    const call = callAt(source, start);
    if (!call) break;
    const options = topLevelArguments(call.body)[1] ?? "";
    const tracking = topLevelTrackingObject(options) ?? "";
    const apiKeyPresent = /\bapiKey\s*(?::|,|}|$)/.test(tracking);
    const endpointPresent = /\bendpoint\s*(?::|,|}|$)/.test(tracking);
    batches.push({
      index: batches.length + 1,
      tracking_api_key: apiKeyPresent,
      literal_api_key: apiKeyPresent
        ? (/\bapiKey\s*:\s*(["'])([^"']+)\1/.exec(tracking)?.[2] ?? null)
        : null,
      tracking_endpoint: endpointPresent,
      literal_endpoint: endpointPresent
        ? (/\bendpoint\s*:\s*(["'])([^"']+)\1/.exec(tracking)?.[2] ?? null)
        : null,
    });
    pattern.lastIndex = call.end;
  }
  return batches;
}

function entryFact(path: string, source: string): EntryFact | null {
  const code = withoutComments(source);
  const batches = registrationBatches(code);
  if (batches.length === 0) return null;
  return {
    path,
    batches,
    tracking_api_key: batches.every((batch) => batch.tracking_api_key),
    tracking_endpoint: batches.every((batch) => batch.tracking_endpoint),
  };
}

async function findEntryModules(workspace: string): Promise<EntryFact[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (item.isSymbolicLink()) continue;
      const path = join(directory, item.name);
      if (item.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(item.name)) await visit(path);
      } else if (item.isFile() && SOURCE_EXTENSIONS.has(extension(item.name))) {
        files.push(path);
      }
    }
  };
  await visit(workspace);
  const facts: EntryFact[] = [];
  for (const path of files.sort()) {
    if ((await stat(path)).size > 1024 * 1024) continue;
    const fact = entryFact(
      relative(workspace, path).replaceAll("\\", "/"),
      await readFile(path, "utf8"),
    );
    if (fact) facts.push(fact);
  }
  return facts;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function onlineKey(
  base: string,
  domainId: string,
  keyId: string,
  accessToken: string,
  fetcher: typeof fetch,
): Promise<{ checked: boolean; enabled: boolean | null; value: string | null }> {
  try {
    const response = await fetcher(
      `${base}/v1/domains/${encodeURIComponent(domainId)}/api-keys`,
      { headers: { authorization: `Bearer ${accessToken}` } },
    );
    if (!response.ok) return { checked: false, enabled: null, value: null };
    const body = await response.json();
    const items = isRecord(body) && Array.isArray(body.items) ? body.items : null;
    if (!items) return { checked: false, enabled: null, value: null };
    const key = items.find((item) => isRecord(item) && item.id === keyId);
    if (!isRecord(key)) return { checked: true, enabled: false, value: null };
    return {
      checked: true,
      enabled: key.enabled === true,
      value: typeof key.key === "string" ? key.key : null,
    };
  } catch {
    return { checked: false, enabled: null, value: null };
  }
}

export async function status(options: StatusOptions): Promise<StatusResult> {
  let workspace: string;
  try {
    workspace = await realpath(options.workspace);
    if (!(await stat(workspace)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new CliError("workspace_not_found", `Workspace is not a directory: ${options.workspace}`);
  }

  const [connection, connectionPresent, lockPresent, entries] = await Promise.all([
    readConnectFile(workspace),
    pathExists(connectFilePath(workspace)),
    pathExists(connectLockPath(workspace)),
    findEntryModules(workspace),
  ]);
  const store = options.store ?? createCredentialStore();
  const loaded = await store.load();
  const identity = loaded ? tokenIdentity(loaded.credentials) : null;
  const remote =
    connection && loaded
      ? await onlineKey(
          apiBaseFor(options),
          connection.domain_id,
          connection.key_id,
          loaded.credentials.access_token,
          options.fetch ?? fetch,
        )
      : { checked: false, enabled: null, value: null };
  const batches = entries.flatMap((entry) =>
    entry.batches.map((batch) => ({ path: entry.path, ...batch })),
  );
  const matches =
    remote.checked && remote.value && batches.length > 0
      ? batches.every((batch) => batch.literal_api_key === remote.value)
      : null;
  const endpointMatches = connection
    ? batches.length > 0 &&
      batches.every((batch) =>
        connection.ingest_url
          ? batch.literal_endpoint === connection.ingest_url
          : !batch.tracking_endpoint,
      )
    : null;

  return {
    workspace,
    connect_file: {
      path: connectFilePath(workspace),
      present: connectionPresent,
      contents: connection,
    },
    entry_modules: entries.map(({ path, tracking_api_key, tracking_endpoint }) => ({
      path,
      tracking_api_key,
      tracking_endpoint,
    })),
    registration_batches: batches.map(
      ({ path, index, tracking_api_key, literal_api_key, tracking_endpoint, literal_endpoint }) => ({
        path,
        index,
        tracking_api_key,
        tracking_endpoint,
        tracking_api_key_matches:
          remote.checked && remote.value ? literal_api_key === remote.value : null,
        tracking_endpoint_matches: connection
          ? connection.ingest_url
            ? literal_endpoint === connection.ingest_url
            : !tracking_endpoint
          : null,
      }),
    ),
    tracking_api_key_present:
      batches.length > 0 && batches.every((batch) => batch.tracking_api_key),
    tracking_api_key_matches: matches,
    tracking_endpoint_matches: endpointMatches,
    credentials: {
      present: loaded !== null,
      account: identity?.account ?? null,
      org: identity?.org ?? null,
    },
    online: { checked: remote.checked, key_enabled: remote.enabled },
    flags: {
      already_connected: connection !== null,
      key_mismatch: matches === false,
      key_revoked: remote.checked && remote.enabled === false,
      another_session_may_be_running: lockPresent,
    },
  };
}
