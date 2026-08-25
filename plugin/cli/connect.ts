import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import type { CredentialStore, StoredCredentials } from "./credentials";
import { createCredentialStore } from "./credentials";
import { CliError, apiBaseFor, type LoginOptions, loginWithConfig } from "./login";

export const CONNECT_DIRECTORY = ".webmcp";
export const CONNECT_FILE = "connect.json";
export const CONNECT_LOCK_FILE = "connect.lock";

export type ConnectFile = {
  org: string;
  domain_id: string;
  domain_public_id: string;
  display_name: string;
  environment: string;
  key_id: string;
  dashboard_url: string;
  ingest_url?: string;
};

export type TokenIdentity = {
  account: string;
  org: string | null;
};

export type ConnectResult = {
  status: "connected" | "pending_propagation";
  edge_verification: "ready" | "pending" | "disabled";
  account: string;
  org: string;
  domain: { id: string; public_id: string; display_name: string };
  environment: string;
  api_key: { id: string; value: string; enabled: boolean };
  dashboard_url: string;
  ingest_url?: string;
  reused: boolean;
  connection_file: string | null;
};

type ProvisionResponse = {
  domain: { id: string; public_id: string; display_name: string };
  api_key: { id: string; key: string; enabled: boolean };
  reused: boolean;
  edge_ready: boolean;
  edge_verification?: "disabled";
  dashboard_url: string;
};

export type ConnectOptions = LoginOptions & {
  workspace: string;
  siteUrl?: string;
  environment?: string;
  org?: string;
  retryDelayMs?: number;
  maxAttempts?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  projectKey?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

function stringField(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseProvision(value: unknown): ProvisionResponse | null {
  if (!isRecord(value) || !isRecord(value.domain) || !isRecord(value.api_key)) return null;
  const domainId = stringField(value.domain, "id");
  const publicId = stringField(value.domain, "public_id");
  const displayName = stringField(value.domain, "display_name");
  const keyId = stringField(value.api_key, "id");
  const key = stringField(value.api_key, "key");
  const dashboardUrl = stringField(value, "dashboard_url");
  if (
    !domainId ||
    !publicId ||
    !displayName ||
    !keyId ||
    !key ||
    typeof value.api_key.enabled !== "boolean" ||
    typeof value.reused !== "boolean" ||
    typeof value.edge_ready !== "boolean" ||
    !dashboardUrl
  ) {
    return null;
  }
  return {
    domain: { id: domainId, public_id: publicId, display_name: displayName },
    api_key: { id: keyId, key, enabled: value.api_key.enabled },
    reused: value.reused,
    edge_ready: value.edge_ready,
    edge_verification: value.edge_verification === "disabled" ? "disabled" : undefined,
    dashboard_url: dashboardUrl,
  };
}

export function tokenIdentity(credentials: StoredCredentials): TokenIdentity | null {
  try {
    const payload = JSON.parse(
      Buffer.from(credentials.access_token.split(".")[1] ?? "", "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    if (typeof payload.sub !== "string" || !payload.sub) return null;
    return {
      account: payload.sub,
      org: typeof payload.org_id === "string" && payload.org_id ? payload.org_id : null,
    };
  } catch {
    return null;
  }
}

async function workspacePath(raw: string): Promise<string> {
  let path: string;
  try {
    path = await realpath(raw);
    if (!(await stat(path)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new CliError("workspace_not_found", `Workspace is not a directory: ${raw}`);
  }
  return path;
}

function gitOutput(workspace: string, args: string[]): string | null {
  try {
    const result = Bun.spawnSync(["git", ...args], {
      cwd: workspace,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    if (result.exitCode !== 0) return null;
    return result.stdout.toString().trim() || null;
  } catch {
    return null;
  }
}

/** Stable across clones/worktrees when a Git remote exists; path-stable otherwise. */
export async function deriveProjectKey(workspace: string): Promise<string> {
  const resolved = await workspacePath(workspace);
  const root = gitOutput(resolved, ["rev-parse", "--show-toplevel"]);
  const remote = gitOutput(resolved, ["config", "--get", "remote.origin.url"]);
  const identity =
    root && remote
      ? `${remote.replace(/\.git$/, "")}\n${relative(root, resolved).replaceAll("\\", "/") || "."}`
      : resolved;
  const kind = root && remote ? "git" : "path";
  return `${kind}:sha256:${createHash("sha256").update(identity).digest("hex")}`;
}

export function connectFilePath(workspace: string): string {
  return join(workspace, CONNECT_DIRECTORY, CONNECT_FILE);
}

export function connectLockPath(workspace: string): string {
  return join(workspace, CONNECT_DIRECTORY, CONNECT_LOCK_FILE);
}

export async function readConnectFile(workspace: string): Promise<ConnectFile | null> {
  try {
    const value = JSON.parse(await readFile(connectFilePath(workspace), "utf8"));
    if (!isRecord(value)) return null;
    const fields = [
      "org",
      "domain_id",
      "domain_public_id",
      "display_name",
      "environment",
      "key_id",
      "dashboard_url",
    ] as const;
    if (fields.some((field) => !stringField(value, field))) return null;
    if (!isUuid(value.domain_id) || !isUuid(value.key_id)) return null;
    const ingestUrl = value.ingest_url;
    if (ingestUrl !== undefined && typeof ingestUrl !== "string") return null;
    if (ingestUrl !== undefined) {
      try {
        const parsed = new URL(ingestUrl);
        if (
          parsed.toString() !== ingestUrl ||
          !["http:", "https:"].includes(parsed.protocol) ||
          !ingestUrl.endsWith("/v1/collect")
        ) {
          return null;
        }
      } catch {
        return null;
      }
    }
    return {
      ...(Object.fromEntries(fields.map((field) => [field, value[field]])) as ConnectFile),
      ...(typeof ingestUrl === "string" ? { ingest_url: ingestUrl } : {}),
    };
  } catch {
    return null;
  }
}

async function writeConnectFile(workspace: string, value: ConnectFile): Promise<string> {
  const path = connectFilePath(workspace);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  return path;
}

async function apiJson(
  url: string,
  credentials: StoredCredentials,
  init: RequestInit,
  fetcher: typeof fetch,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, {
      ...init,
      headers: {
        authorization: `Bearer ${credentials.access_token}`,
        "content-type": "application/json",
        ...init.headers,
      },
    });
  } catch {
    throw new CliError("api_unavailable", "Could not reach the WebMCP API");
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // The status below remains the useful fact when a proxy returns non-JSON.
  }
  if (!response.ok) {
    const error = isRecord(body) && isRecord(body.error) ? body.error : null;
    const code = error && stringField(error, "code");
    const message = error && stringField(error, "message");
    throw new CliError(
      code ?? "api_error",
      message ?? `WebMCP API request failed (${response.status})`,
    );
  }
  return body;
}

async function authenticated(
  options: ConnectOptions,
  store: CredentialStore,
  forceConsent = false,
): Promise<{ credentials: StoredCredentials; identity: TokenIdentity; ingestUrl?: string }> {
  let login = await loginWithConfig({
    ...options,
    store,
    forceConsent,
  });
  let loaded = await store.load();
  let identity = loaded ? tokenIdentity(loaded.credentials) : null;
  if (!loaded || !identity) {
    throw new CliError("invalid_credentials", "Stored WebMCP credentials are invalid");
  }
  if (!forceConsent && (!identity.org || (options.org && identity.org !== options.org))) {
    login = await loginWithConfig({
      ...options,
      store,
      forceConsent: true,
    });
    loaded = await store.load();
    identity = loaded ? tokenIdentity(loaded.credentials) : null;
  }
  if (!loaded || !identity) {
    throw new CliError("invalid_credentials", "Stored WebMCP credentials are invalid");
  }
  if (!identity.org) {
    throw new CliError(
      "no_active_organization",
      "OAuth login has no selected organization; authorize again and select one",
    );
  }
  if (options.org && identity.org !== options.org) {
    throw new CliError(
      "organization_mismatch",
      `OAuth consent selected ${identity.org}, not requested organization ${options.org}`,
    );
  }
  return {
    credentials: loaded.credentials,
    identity,
    ...(login.config.ingest_url ? { ingestUrl: login.config.ingest_url } : {}),
  };
}

async function withAdvisoryLock<T>(workspace: string, work: () => Promise<T>): Promise<T> {
  const path = connectLockPath(workspace);
  const id = randomUUID();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify({ id, pid: process.pid, started_at: new Date().toISOString() })}\n`,
  );
  try {
    return await work();
  } finally {
    try {
      const current = JSON.parse(await readFile(path, "utf8"));
      if (current?.id === id) await rm(path, { force: true });
    } catch {
      // A missing/replaced advisory belongs to no cleanup protocol.
    }
  }
}

export async function connect(options: ConnectOptions): Promise<ConnectResult> {
  const workspace = await workspacePath(options.workspace);
  const environment = options.environment?.trim().toLowerCase() || "production";
  const siteUrl = options.siteUrl?.trim();
  if (siteUrl) {
    try {
      const url = new URL(siteUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("bad scheme");
    } catch {
      throw new CliError("invalid_site_url", "--site-url must be an http(s) URL");
    }
  }
  const store = options.store ?? createCredentialStore();
  const fetcher = options.fetch ?? fetch;
  const base = apiBaseFor(options);
  const projectKey = options.projectKey ?? (await deriveProjectKey(workspace));
  const sleep = options.sleep ?? ((milliseconds) => Bun.sleep(milliseconds));
  const maxAttempts = Math.max(1, options.maxAttempts ?? 6);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 1_000);

  return withAdvisoryLock(workspace, async () => {
    let auth = await authenticated(options, store);
    const provision = async (): Promise<ProvisionResponse> => {
      const saved = await readConnectFile(workspace);
      const domainBody = {
        project_key: projectKey,
        source: "kit",
        display_name: basename(workspace),
        ...(siteUrl ? { site_url: siteUrl } : {}),
        ...(saved?.org === auth.identity.org ? { domain_id: saved.domain_id } : {}),
      };
      const domainValue = await apiJson(
        `${base}/v1/domains`,
        auth.credentials,
        { method: "POST", body: JSON.stringify(domainBody) },
        fetcher,
      );
      if (!isRecord(domainValue) || !stringField(domainValue, "id")) {
        throw new CliError("invalid_response", "The WebMCP API returned an invalid domain");
      }
      const domainId = domainValue.id as string;
      let last: ProvisionResponse | null = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const keyValue = await apiJson(
          `${base}/v1/domains/${encodeURIComponent(domainId)}/api-keys`,
          auth.credentials,
          { method: "POST", body: JSON.stringify({ environment }) },
          fetcher,
        );
        last = parseProvision(keyValue);
        if (!last) {
          throw new CliError("invalid_response", "The WebMCP API returned an invalid API key");
        }
        if (last.edge_ready || last.edge_verification === "disabled" || attempt === maxAttempts) {
          break;
        }
        await sleep(retryDelayMs);
      }
      return last as ProvisionResponse;
    };

    let provisioned: ProvisionResponse;
    try {
      provisioned = await provision();
    } catch (error) {
      if (!(error instanceof CliError) || error.code !== "unauthenticated") throw error;
      auth = await authenticated(options, store, true);
      provisioned = await provision();
    }

    const edgeVerification = provisioned.edge_ready
      ? "ready"
      : provisioned.edge_verification === "disabled"
        ? "disabled"
        : "pending";
    let path: string | null = null;
    if (provisioned.edge_ready) {
      path = await writeConnectFile(workspace, {
        org: auth.identity.org as string,
        domain_id: provisioned.domain.id,
        domain_public_id: provisioned.domain.public_id,
        display_name: provisioned.domain.display_name,
        environment,
        key_id: provisioned.api_key.id,
        dashboard_url: provisioned.dashboard_url,
        ...(auth.ingestUrl ? { ingest_url: auth.ingestUrl } : {}),
      });
    }
    return {
      status: provisioned.edge_ready ? "connected" : "pending_propagation",
      edge_verification: edgeVerification,
      account: auth.identity.account,
      org: auth.identity.org as string,
      domain: provisioned.domain,
      environment,
      api_key: {
        id: provisioned.api_key.id,
        value: provisioned.api_key.key,
        enabled: provisioned.api_key.enabled,
      },
      dashboard_url: provisioned.dashboard_url,
      ...(auth.ingestUrl ? { ingest_url: auth.ingestUrl } : {}),
      reused: provisioned.reused,
      connection_file: path,
    };
  });
}
