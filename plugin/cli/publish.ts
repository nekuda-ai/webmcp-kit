import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  apiJson,
  authenticated,
  PUBLISHER_SCOPE_PATTERN,
  readConnectFile,
  writeConnectFile,
} from "./connect";
import { createCredentialStore } from "./credentials";
import { extractManifest, type ManifestEntry } from "./manifest";
import { apiBaseFor, CliError, type LoginOptions } from "./login";

/**
 * `webmcp publish` — put an entry module's declared tools in the AgentLane catalog.
 *
 * Until now a tool authored or migrated through the plugin existed on the platform only as
 * a name in a telemetry rollup: observed, never described. This sends the metadata the
 * merchant already approved — stable key, wire name, description, input schema,
 * annotations — to the publisher plane, which mints the identity and a per-deployment
 * contract for it.
 *
 * Three things it does NOT send, each of them a rule rather than an omission:
 *
 * - NO CODE. The manifest is metadata read out of `defineTool` calls; handler bodies are
 *   skipped by the parser, not filtered out later (see `manifest.ts`).
 * - NO `wmk_` KEY. The publishable key is the browser's credential for reporting usage; the
 *   publisher plane refuses it by design. This path authenticates with the OAuth grant
 *   `webmcp login` already stored, and never reads the key out of the connection file.
 * - NO FILESYSTEM PATH AS IDENTITY. The registration scope is declared in
 *   `.webmcp/connect.json` and reused verbatim, so moving `src/tools/` to `app/tools/`
 *   does not mint a second publisher whose declarations collide with the first's.
 */

/** Every published tool runs in the merchant's own page — we deliver nothing for it. */
const EXECUTION_OWNER = "site";

/**
 * What the CLI can honestly say about where a tool is reachable. The entry module does not
 * declare its routes, and inventing them would take a name site-wide (an empty route list
 * overlaps everything, which is exactly what "not known to be route-scoped" means).
 */
const AVAILABILITY = { routes: [] as string[], auth: "unknown" as const };

export type PublishOptions = LoginOptions & {
  workspace: string;
  /** The approved entry module, workspace-relative or absolute. One run, one module. */
  entry: string;
  /** Declares the registration scope on a first publish; must match a declared one after. */
  scope?: string;
  environment?: string;
  org?: string;
  /** Skip the confirmation. Required for a run with nobody to answer it. */
  yes?: boolean;
  interactive?: boolean;
  confirm?: (plan: PublishPlan) => Promise<boolean>;
};

/** What the run is about to send, as the confirmation prompt describes it. */
export type PublishPlan = {
  entry_module: string;
  publisher_scope: string;
  environment: string;
  display_name: string;
  tools: Array<{ stable_key: string; name: string }>;
};

export type PublishedEntry = {
  stable_key: string;
  tool_id: string;
  contract_revision: number;
  status: string;
};

export type PublishResult = {
  status: "published" | "skipped";
  /** Why nothing was sent. Absent on a publish. */
  reason?: "non_interactive" | "declined";
  workspace: string;
  entry_module: string;
  publisher_scope: string;
  environment: string;
  idempotency_key: string;
  publisher_revision: number | null;
  entries: PublishedEntry[];
};

type PublishResponse = {
  publisher_revision: number;
  environment: { id: string; name: string };
  entries: PublishedEntry[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The publisher plane's answer, or null when it is not one. Parsed rather than cast for the
 * same reason `connect` parses its provision response: a proxy, a stale deployment or an
 * error page reaching this far must fail as "invalid response", not as `undefined` printed
 * to an operator who then reports a tool id nobody minted.
 */
export function parsePublishResponse(value: unknown): PublishResponse | null {
  if (!isRecord(value) || !isRecord(value.environment) || !Array.isArray(value.entries)) return null;
  if (typeof value.publisher_revision !== "number") return null;
  const { id, name } = value.environment;
  if (typeof id !== "string" || !id || typeof name !== "string" || !name) return null;
  const entries: PublishedEntry[] = [];
  for (const item of value.entries) {
    if (!isRecord(item)) return null;
    const { stable_key: stableKey, tool_id: toolId, contract_revision: revision, status } = item;
    if (typeof stableKey !== "string" || !stableKey) return null;
    if (typeof toolId !== "string" || !toolId) return null;
    if (typeof revision !== "number" || !Number.isInteger(revision)) return null;
    if (typeof status !== "string" || !status) return null;
    entries.push({ stable_key: stableKey, tool_id: toolId, contract_revision: revision, status });
  }
  return { publisher_revision: value.publisher_revision, environment: { id, name }, entries };
}

/** Object keys sorted, no whitespace — so the same manifest hashes the same everywhere. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * The idempotency key for one publish: a digest of exactly what is being published.
 *
 * Derived from the manifest rather than minted per run, because the retry this protects
 * against is a re-run — a CI job that failed after the write, a dropped response, an
 * operator running the command twice. A random key would make each of those a second
 * revision of every contract in the manifest; a manifest digest converges on the rows the
 * first attempt already wrote. It covers the scope and the deployment too: the same tools
 * published to `dev` and to `prod` are two different statements.
 */
export function manifestIdempotencyKey(
  scope: string,
  environment: string,
  entries: ManifestEntry[],
): string {
  const digest = createHash("sha256")
    .update(canonicalJson({ scope, environment, entries }))
    .digest("hex");
  return `sha256:${digest}`;
}

function publishBody(environment: string, key: string, entries: ManifestEntry[]) {
  return {
    environment,
    idempotency_key: key,
    entries: entries.map((entry) => ({
      stable_key: entry.stable_key,
      name: entry.name,
      description: entry.description,
      source: entry.source,
      execution_owner: EXECUTION_OWNER,
      input_schema: entry.input_schema,
      ...(entry.annotations ? { annotations: entry.annotations } : {}),
      availability: AVAILABILITY,
      // A tool whose module declares no `inputSchema` is published as a draft: an agent
      // cannot call it correctly without guessing, which is the distinction this flag
      // carries. Declaring `inputSchema: {}` is how a genuinely argument-free tool says so.
      contract_complete: Object.keys(entry.input_schema).length > 0,
    })),
  };
}

async function directory(raw: string): Promise<string> {
  try {
    const path = await realpath(raw);
    if (!(await stat(path)).isDirectory()) throw new Error("not a directory");
    return path;
  } catch {
    throw new CliError("workspace_not_found", `Workspace is not a directory: ${raw}`);
  }
}

/** The approved entry module, refused when it escapes the workspace. */
function entryModulePath(workspace: string, entry: string): { path: string; display: string } {
  const path = isAbsolute(entry) ? resolve(entry) : resolve(join(workspace, entry));
  const display = relative(workspace, path).replaceAll("\\", "/");
  if (display === "" || display.startsWith("..")) {
    throw new CliError("entry_module_outside_workspace", `Entry module is outside the workspace: ${entry}`);
  }
  return { path, display };
}

async function askOnStdin(plan: PublishPlan): Promise<boolean> {
  process.stderr.write(
    `Publish ${plan.tools.length} tool${plan.tools.length === 1 ? "" : "s"} from ${plan.entry_module} to ${plan.display_name} (${plan.environment})? [y/N] `,
  );
  const reader = Bun.stdin.stream().getReader();
  try {
    const { value } = await reader.read();
    const answer = new TextDecoder().decode(value ?? new Uint8Array()).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    reader.releaseLock();
  }
}

export async function publish(options: PublishOptions): Promise<PublishResult> {
  const workspace = await directory(options.workspace);
  const connection = await readConnectFile(workspace);
  if (!connection) {
    throw new CliError(
      "not_connected",
      "This workspace is not connected to WebMCP; run `webmcp connect` first",
    );
  }

  const requested = options.scope?.trim();
  if (requested !== undefined && !PUBLISHER_SCOPE_PATTERN.test(requested)) {
    throw new CliError(
      "invalid_publisher_scope",
      "--scope must be 1-128 characters of [A-Za-z0-9._-], starting alphanumeric",
    );
  }
  const declared = connection.publisher_scope;
  if (declared && requested && declared !== requested) {
    // Publishing the same module under a second scope does not rename a publisher: it
    // creates one, and the first scope keeps every tool it owns — which the next publish
    // then hits as `key_owned_elsewhere` against the merchant's own earlier run.
    throw new CliError(
      "publisher_scope_mismatch",
      `This workspace already publishes as "${declared}"; --scope ${requested} would create a second publisher that cannot claim its tools`,
    );
  }
  const scope = declared ?? requested;
  if (!scope) {
    throw new CliError(
      "publisher_scope_required",
      "No registration scope is declared for this workspace; pass --scope <name> once and it is remembered",
    );
  }

  const { path, display } = entryModulePath(workspace, options.entry);
  const manifest = await extractManifest(path, display);
  if (manifest.entries.length === 0) {
    throw new CliError("no_tools_found", `No defineTool calls found in ${display}`);
  }

  const environment = (options.environment ?? connection.environment).trim().toLowerCase();
  const idempotencyKey = manifestIdempotencyKey(scope, environment, manifest.entries);
  const plan: PublishPlan = {
    entry_module: display,
    publisher_scope: scope,
    environment,
    display_name: connection.display_name,
    tools: manifest.entries.map(({ stable_key, name }) => ({ stable_key, name })),
  };
  const skipped = (reason: "non_interactive" | "declined"): PublishResult => ({
    status: "skipped",
    reason,
    workspace,
    entry_module: display,
    publisher_scope: scope,
    environment,
    idempotency_key: idempotencyKey,
    publisher_revision: null,
    entries: [],
  });

  if (!options.yes) {
    // A run with nobody to answer publishes nothing. Publishing is the one plugin action
    // that puts the merchant's tool metadata on our servers, so silence is a "no" here even
    // though it is a "take the default" almost everywhere else in the kit.
    const interactive = options.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
    if (!interactive) return skipped("non_interactive");
    const confirmed = await (options.confirm ?? askOnStdin)(plan);
    if (!confirmed) return skipped("declined");
  }

  const store = options.store ?? createCredentialStore();
  const fetcher = options.fetch ?? fetch;
  const base = apiBaseFor(options);
  const auth = await authenticated(options, store);
  const url = `${base}/v2/domains/${encodeURIComponent(connection.domain_id)}/tool-publishers/${encodeURIComponent(scope)}/contracts`;

  let value: unknown;
  try {
    value = await apiJson(
      url,
      auth.credentials,
      { method: "PUT", body: JSON.stringify(publishBody(environment, idempotencyKey, manifest.entries)) },
      fetcher,
    );
  } catch (error) {
    throw ownershipHint(error, scope);
  }
  const response = parsePublishResponse(value);
  if (!response) {
    throw new CliError("invalid_response", "The WebMCP API returned an invalid publish result");
  }

  if (!declared) {
    // Persisted only now: a scope bound by a run that never published would durably record
    // a typo, and the refusal above makes that unrecoverable without hand-editing the file.
    await writeConnectFile(workspace, { ...connection, publisher_scope: scope });
  }

  return {
    status: "published",
    workspace,
    entry_module: display,
    publisher_scope: scope,
    environment: response.environment.name,
    idempotency_key: idempotencyKey,
    publisher_revision: response.publisher_revision,
    entries: response.entries,
  };
}

/**
 * Restate `key_owned_elsewhere` as the action it asks for. The refusal means another
 * registration scope already owns that stable key in this deployment, and the merchant's
 * next move is not "retry" but "adopt it, or publish under the owning scope" — so the
 * owning scope has to be in the sentence.
 */
function ownershipHint(error: unknown, scope: string): unknown {
  if (!(error instanceof CliError) || error.code !== "key_owned_elsewhere") return error;
  const details = isRecord(error.details) ? error.details : {};
  const owner = typeof details.owner_scope === "string" ? details.owner_scope : null;
  const key = typeof details.stable_key === "string" ? details.stable_key : null;
  if (!owner) return error;
  return new CliError(
    error.code,
    `${key ? `"${key}"` : "A tool in this manifest"} is already published by registration scope "${owner}", not "${scope}". Publish under "${owner}", or transfer the tool to "${scope}" first.`,
    error.details,
  );
}
