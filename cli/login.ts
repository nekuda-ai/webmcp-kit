import { createHash, randomBytes } from "node:crypto";
import type { CredentialBackend, CredentialStore, StoredCredentials } from "./credentials";
import { createCredentialStore } from "./credentials";

const DEFAULT_API_BASE = "https://api.agentlane.com";
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1_000;
const EXPIRY_SKEW_MS = 60_000;

export type ConnectConfig = {
  oauth: {
    issuer: string;
    client_id: string;
    scopes: string[];
    authorization_endpoint: string;
    token_endpoint: string;
  };
  dashboard_url: string;
  connect_start_url: string;
  ingest_url?: string;
};

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
};

export type LoginStatus = "authenticated" | "refreshed" | "logged_in";

export type LoginResult = {
  status: LoginStatus;
  credential_store: CredentialBackend;
};

export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CliError";
  }
}

export type LoginOptions = {
  apiBase?: string;
  store?: CredentialStore;
  fetch?: typeof fetch;
  openBrowser?: (url: string) => Promise<boolean>;
  showAuthorizationUrl?: (url: string) => void;
  callbackTimeoutMs?: number;
  now?: () => number;
  /** Ignore a cached/refreshable grant and show Clerk consent again. */
  forceConsent?: boolean;
};

export function apiBaseFor(options: Pick<LoginOptions, "apiBase"> = {}): string {
  return (options.apiBase ?? process.env.WEBMCP_API_BASE ?? DEFAULT_API_BASE).replace(/\/+$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function requiredCollectUrl(value: unknown): string | null {
  const url = requiredUrl(value);
  return url?.endsWith("/v1/collect") ? url : null;
}

function parseConnectConfig(value: unknown): ConnectConfig | null {
  if (!isRecord(value) || !isRecord(value.oauth)) return null;
  const { oauth } = value;
  const issuer = requiredUrl(oauth.issuer);
  const authorizationEndpoint = requiredUrl(oauth.authorization_endpoint);
  const tokenEndpoint = requiredUrl(oauth.token_endpoint);
  const dashboardUrl = requiredUrl(value.dashboard_url);
  const connectStartUrl = requiredUrl(value.connect_start_url);
  const ingestUrl = value.ingest_url === undefined ? undefined : requiredCollectUrl(value.ingest_url);
  if (!Array.isArray(oauth.scopes)) return null;
  const scopes = oauth.scopes.filter(
    (scope): scope is string => typeof scope === "string" && !!scope,
  );
  if (
    !issuer ||
    !authorizationEndpoint ||
    !tokenEndpoint ||
    !dashboardUrl ||
    !connectStartUrl ||
    ingestUrl === null ||
    typeof oauth.client_id !== "string" ||
    !oauth.client_id ||
    scopes.length === 0 ||
    scopes.length !== oauth.scopes.length
  ) {
    return null;
  }
  return {
    oauth: {
      issuer,
      client_id: oauth.client_id,
      scopes,
      authorization_endpoint: authorizationEndpoint,
      token_endpoint: tokenEndpoint,
    },
    dashboard_url: dashboardUrl,
    connect_start_url: connectStartUrl,
    ...(ingestUrl ? { ingest_url: ingestUrl } : {}),
  };
}

async function fetchConnectConfig(apiBase: string, fetcher: typeof fetch): Promise<ConnectConfig> {
  let response: Response;
  try {
    response = await fetcher(`${apiBase.replace(/\/+$/, "")}/v1/connect/config`);
  } catch {
    throw new CliError("config_unavailable", "Could not reach the WebMCP API");
  }
  if (!response.ok) {
    throw new CliError(
      "config_unavailable",
      `WebMCP login is unavailable in this environment (${response.status})`,
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new CliError("invalid_config", "The WebMCP API returned invalid login configuration");
  }
  const config = parseConnectConfig(body);
  if (!config) {
    throw new CliError("invalid_config", "The WebMCP API returned invalid login configuration");
  }
  return config;
}

function base64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function jwtExpiry(token: string): number | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString());
    return typeof payload.exp === "number" ? payload.exp * 1_000 : null;
  } catch {
    return null;
  }
}

function credentialsFromTokens(
  tokens: TokenResponse,
  config: ConnectConfig,
  refreshToken: string | undefined,
  now: number,
): StoredCredentials {
  const refresh = tokens.refresh_token ?? refreshToken;
  if (!refresh) {
    throw new CliError(
      "token_exchange_failed",
      "The OAuth response did not include offline access",
    );
  }
  const expiresAt =
    typeof tokens.expires_in === "number" && tokens.expires_in > 0
      ? now + tokens.expires_in * 1_000
      : jwtExpiry(tokens.access_token);
  if (!expiresAt) {
    throw new CliError("token_exchange_failed", "The OAuth response did not include token expiry");
  }
  return {
    version: 1,
    access_token: tokens.access_token,
    refresh_token: refresh,
    expires_at: expiresAt,
    client_id: config.oauth.client_id,
    token_endpoint: config.oauth.token_endpoint,
  };
}

async function requestTokens(
  endpoint: string,
  body: URLSearchParams,
  fetcher: typeof fetch,
  rejectionCode: string,
): Promise<TokenResponse> {
  let response: Response;
  try {
    response = await fetcher(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch {
    throw new CliError("token_endpoint_unavailable", "Could not reach the OAuth token endpoint");
  }
  if (!response.ok) {
    throw new CliError(
      rejectionCode,
      `The OAuth token endpoint rejected the request (${response.status})`,
    );
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new CliError("token_exchange_failed", "The OAuth token endpoint returned invalid JSON");
  }
  if (!isRecord(value) || typeof value.access_token !== "string" || !value.access_token) {
    throw new CliError(
      "token_exchange_failed",
      "The OAuth response did not include an access token",
    );
  }
  return {
    access_token: value.access_token,
    refresh_token: typeof value.refresh_token === "string" ? value.refresh_token : undefined,
    expires_in: typeof value.expires_in === "number" ? value.expires_in : undefined,
  };
}

async function defaultOpenBrowser(url: string): Promise<boolean> {
  const override = process.env.WEBMCP_BROWSER?.trim();
  const command = override
    ? [override, url]
    : process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd.exe", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    const child = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

async function authorizationCode(
  config: ConnectConfig,
  challenge: string,
  state: string,
  options: LoginOptions,
): Promise<{ code: string; redirectUri: string }> {
  let callbackHandled = false;
  let resolveCallback: (code: string) => void;
  let rejectCallback: (error: Error) => void;
  const callback = new Promise<string>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== "/callback") return new Response("Not found", { status: 404 });
      if (url.searchParams.get("state") !== state) {
        return new Response("OAuth state did not match. You can close this window.", {
          status: 400,
        });
      }
      const error = url.searchParams.get("error");
      if (error) {
        callbackHandled = true;
        rejectCallback(new CliError("authorization_failed", "OAuth authorization was not granted"));
        return new Response("OAuth authorization was not granted. You can close this window.", {
          status: 400,
        });
      }
      const code = url.searchParams.get("code");
      if (!code) return new Response("Missing authorization code.", { status: 400 });
      callbackHandled = true;
      resolveCallback(code);
      return new Response(
        `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>WebMCP authorization complete</title>
    <style>
      :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
      body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: #0b0c0f; color: #f6f7f9; }
      main { width: min(28rem, calc(100% - 3rem)); text-align: center; }
      .mark { width: 3rem; height: 3rem; margin: 0 auto 1.25rem; border-radius: 999px; display: grid; place-items: center; background: #d7ff66; color: #111; font-size: 1.5rem; }
      h1 { margin: 0 0 .75rem; font-size: 1.75rem; }
      p { margin: 0; color: #a9adb7; line-height: 1.6; }
    </style>
  </head>
  <body>
    <main>
      <div class="mark" aria-hidden="true">✓</div>
      <h1>Authorization complete</h1>
      <p>Return to your terminal while WebMCP Kit finishes connecting your project.</p>
    </main>
  </body>
</html>`,
        {
          headers: {
            "cache-control": "no-store",
            "content-type": "text/html; charset=utf-8",
          },
        },
      );
    },
  });
  const redirectUri = `http://127.0.0.1:${server.port}/callback`;
  const authorize = new URL(config.oauth.authorization_endpoint);
  const authorizeParams = new URLSearchParams({
    response_type: "code",
    client_id: config.oauth.client_id,
    redirect_uri: redirectUri,
    scope: config.oauth.scopes.join(" "),
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  if (options.forceConsent) authorizeParams.set("prompt", "consent");
  authorize.search = authorizeParams.toString();
  const connectStart = new URL(config.connect_start_url);
  connectStart.searchParams.set("next", authorize.toString());
  const authorizationUrl = connectStart.toString();
  options.showAuthorizationUrl?.(authorizationUrl);
  await (options.openBrowser ?? defaultOpenBrowser)(authorizationUrl).catch(() => false);

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const code = await Promise.race([
      callback,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new CliError("authorization_timeout", "Timed out waiting for OAuth login")),
          options.callbackTimeoutMs ?? CALLBACK_TIMEOUT_MS,
        );
      }),
    ]);
    return { code, redirectUri };
  } finally {
    if (timer) clearTimeout(timer);
    // A completed callback still has a response in flight. Let Bun flush the
    // success/error page; only a timeout needs to tear the listener down forcibly.
    await server.stop(!callbackHandled);
  }
}

export async function loginWithConfig(
  options: LoginOptions = {},
): Promise<{ result: LoginResult; config: ConnectConfig }> {
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const config = await fetchConnectConfig(
    apiBaseFor(options),
    fetcher,
  );
  const store = options.store ?? createCredentialStore();
  const loaded = await store.load();
  const matchesClient =
    loaded?.credentials.client_id === config.oauth.client_id &&
    loaded.credentials.token_endpoint === config.oauth.token_endpoint;
  if (
    !options.forceConsent &&
    loaded &&
    matchesClient &&
    loaded.credentials.expires_at > now() + EXPIRY_SKEW_MS
  ) {
    return {
      result: { status: "authenticated", credential_store: loaded.backend },
      config,
    };
  }

  if (!options.forceConsent && loaded && matchesClient) {
    try {
      const tokens = await requestTokens(
        config.oauth.token_endpoint,
        new URLSearchParams({
          grant_type: "refresh_token",
          client_id: config.oauth.client_id,
          refresh_token: loaded.credentials.refresh_token,
        }),
        fetcher,
        "refresh_rejected",
      );
      const credentials = credentialsFromTokens(
        tokens,
        config,
        loaded.credentials.refresh_token,
        now(),
      );
      return {
        result: { status: "refreshed", credential_store: await store.save(credentials) },
        config,
      };
    } catch (error) {
      if (!(error instanceof CliError) || error.code !== "refresh_rejected") throw error;
    }
  }

  const verifier = base64Url(randomBytes(48));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  const state = base64Url(randomBytes(24));
  const { code, redirectUri } = await authorizationCode(config, challenge, state, options);
  const tokens = await requestTokens(
    config.oauth.token_endpoint,
    new URLSearchParams({
      grant_type: "authorization_code",
      client_id: config.oauth.client_id,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      code,
    }),
    fetcher,
    "token_exchange_failed",
  );
  const credentials = credentialsFromTokens(tokens, config, undefined, now());
  return {
    result: { status: "logged_in", credential_store: await store.save(credentials) },
    config,
  };
}

export async function login(options: LoginOptions = {}): Promise<LoginResult> {
  return (await loginWithConfig(options)).result;
}
