import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileCredentialStore, type StoredCredentials } from "../../cli/credentials";
import { apiBaseFor, login } from "../../cli/login";
import { main } from "../../cli/webmcp";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function temporaryCredentials() {
  const directory = await mkdtemp(join(tmpdir(), "webmcp-cli-test-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "nested", "credentials.json");
  return { path, store: createFileCredentialStore(path) };
}

function fakeOAuthServer() {
  let challenge = "";
  let lastAuthorizationUrl = "";
  let authorizationCount = 0;
  let exchangeCount = 0;
  let refreshCount = 0;
  let connectStartCount = 0;
  let organizationCreated = false;
  let callbackPage = "";
  let detachedNavigation: Promise<boolean> | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const base = `http://127.0.0.1:${server.port}`;
      if (url.pathname === "/v1/connect/config") {
        return Response.json({
          oauth: {
            issuer: base,
            client_id: "fake-public-client",
            scopes: ["openid", "offline_access"],
            authorization_endpoint: `${base}/authorize`,
            token_endpoint: `${base}/token`,
          },
          dashboard_url: `${base}/dashboard`,
          connect_start_url: `${base}/connect/start`,
        });
      }
      if (url.pathname === "/connect/start") {
        connectStartCount++;
        const next = url.searchParams.get("next");
        if (!next) return new Response("Missing next", { status: 400 });
        // Model the portal's fresh-account branch: organization creation happens
        // before the browser is allowed to continue to Clerk authorization.
        if (!organizationCreated) organizationCreated = true;
        return Response.redirect(next, 302);
      }
      if (url.pathname === "/token") {
        const form = new URLSearchParams(await request.text());
        expect(form.get("client_id")).toBe("fake-public-client");
        if (form.get("grant_type") === "refresh_token") {
          refreshCount++;
          expect(form.get("refresh_token")).toBe("fake-refresh-token");
          return Response.json({ access_token: "refreshed-access-token", expires_in: 3600 });
        }
        exchangeCount++;
        expect(form.get("grant_type")).toBe("authorization_code");
        expect(form.get("code")).toBe("fake-authorization-code");
        const verifier = form.get("code_verifier") ?? "";
        expect(createHash("sha256").update(verifier).digest("base64url")).toBe(challenge);
        return Response.json({
          access_token: "fake-access-token",
          refresh_token: "fake-refresh-token",
          expires_in: 3600,
        });
      }
      return new Response("Not found", { status: 404 });
    },
  });

  async function authorize(url: string): Promise<boolean> {
    authorizationCount++;
    const connectStart = new URL(url);
    expect(connectStart.pathname).toBe("/connect/start");
    const hop = await fetch(connectStart, { redirect: "manual" });
    expect(hop.status).toBe(302);
    expect(organizationCreated).toBe(true);
    const authorize = new URL(hop.headers.get("location") ?? "");
    lastAuthorizationUrl = authorize.toString();
    expect(authorize.pathname).toBe("/authorize");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    challenge = authorize.searchParams.get("code_challenge") ?? "";
    const callback = new URL(authorize.searchParams.get("redirect_uri") ?? "");
    expect(callback.hostname).toBe("127.0.0.1");
    const wrongState = new URL(callback);
    wrongState.searchParams.set("code", "wrong-state-code");
    wrongState.searchParams.set("state", "wrong-state");
    expect((await fetch(wrongState)).status).toBe(400);
    callback.searchParams.set("code", "fake-authorization-code");
    callback.searchParams.set("state", authorize.searchParams.get("state") ?? "");
    const response = await fetch(callback);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    callbackPage = await response.text();
    return true;
  }

  return {
    base: `http://127.0.0.1:${server.port}`,
    server,
    counts: () => ({ authorizationCount, exchangeCount, refreshCount }),
    connectState: () => ({ connectStartCount, organizationCreated }),
    lastAuthorizationUrl: () => lastAuthorizationUrl,
    callbackPage: () => callbackPage,
    authorize,
    async authorizeDetached(url: string) {
      // Match xdg-open/open: report launch immediately while navigation continues.
      detachedNavigation = authorize(url);
      return true;
    },
    async waitForDetachedNavigation() {
      expect(detachedNavigation).toBeDefined();
      await detachedNavigation;
    },
  };
}

describe("webmcp login", () => {
  test("defaults public installs to the production API", () => {
    const previous = process.env.WEBMCP_API_BASE;
    try {
      delete process.env.WEBMCP_API_BASE;
      expect(apiBaseFor()).toBe("https://api.agentlane.com");
    } finally {
      if (previous === undefined) delete process.env.WEBMCP_API_BASE;
      else process.env.WEBMCP_API_BASE = previous;
    }
  });

  test("uses S256, exchanges at the configured endpoint, caches, and refreshes without consent", async () => {
    const oauth = fakeOAuthServer();
    const { path, store } = await temporaryCredentials();
    try {
      const first = await login({
        apiBase: oauth.base,
        store,
        openBrowser: oauth.authorizeDetached,
        showAuthorizationUrl: () => {},
      });
      expect(first).toEqual({ status: "logged_in", credential_store: "file" });
      expect(oauth.counts()).toEqual({
        authorizationCount: 1,
        exchangeCount: 1,
        refreshCount: 0,
      });
      await oauth.waitForDetachedNavigation();
      expect(oauth.connectState()).toEqual({ connectStartCount: 1, organizationCreated: true });
      expect(oauth.callbackPage()).toContain("Authorization complete");
      expect(oauth.callbackPage()).toContain("finishes connecting your project");

      const cached = await login({
        apiBase: oauth.base,
        store,
        openBrowser: async () => {
          throw new Error("cached login must not open a browser");
        },
      });
      expect(cached.status).toBe("authenticated");
      expect(oauth.counts().authorizationCount).toBe(1);

      const expired = JSON.parse(await readFile(path, "utf8")) as StoredCredentials;
      expired.expires_at = 0;
      await store.save(expired);
      const refreshed = await login({
        apiBase: oauth.base,
        store,
        openBrowser: async () => {
          throw new Error("refresh must not open a browser");
        },
      });
      expect(refreshed.status).toBe("refreshed");
      expect(oauth.counts()).toEqual({
        authorizationCount: 1,
        exchangeCount: 1,
        refreshCount: 1,
      });
      expect((JSON.parse(await readFile(path, "utf8")) as StoredCredentials).refresh_token).toBe(
        "fake-refresh-token",
      );
    } finally {
      await oauth.server.stop(true);
    }
  });

  test("writes fallback credentials atomically with private permissions", async () => {
    const { path, store } = await temporaryCredentials();
    const credentials: StoredCredentials = {
      version: 1,
      access_token: "private-access",
      refresh_token: "private-refresh",
      expires_at: Date.now() + 60_000,
      client_id: "client",
      token_endpoint: "https://example.test/token",
    };

    expect(await store.save(credentials)).toBe("file");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await store.load())?.credentials).toEqual(credentials);
  });

  test("forced re-consent cannot be satisfied by the cached grant", async () => {
    const oauth = fakeOAuthServer();
    const { store } = await temporaryCredentials();
    try {
      await login({
        apiBase: oauth.base,
        store,
        forceConsent: true,
        openBrowser: oauth.authorize,
      });
      const authorization = new URL(oauth.lastAuthorizationUrl());
      expect(authorization.searchParams.get("prompt")).toBe("consent");
    } finally {
      await oauth.server.stop(true);
    }
  });

  test("emits structured token-free JSON and stable exit codes", async () => {
    const oauth = fakeOAuthServer();
    const { store } = await temporaryCredentials();
    const stdout: string[] = [];
    const stderr: string[] = [];
    try {
      const code = await main(["login", "--json"], {
        apiBase: oauth.base,
        store,
        openBrowser: oauth.authorize,
        io: { stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value) },
      });
      expect(code).toBe(0);
      expect(JSON.parse(stdout[0])).toEqual({
        ok: true,
        command: "login",
        status: "logged_in",
        credential_store: "file",
      });
      expect(`${stdout.join("\n")}\n${stderr.join("\n")}`).not.toContain("fake-access-token");
      expect(`${stdout.join("\n")}\n${stderr.join("\n")}`).not.toContain("fake-refresh-token");

      stdout.length = 0;
      expect(
        await main(["connect", "--json"], {
          io: { stdout: (v) => stdout.push(v), stderr: () => {} },
        }),
      ).toBe(2);
      expect(JSON.parse(stdout[0]).error.code).toBe("usage");
    } finally {
      await oauth.server.stop(true);
    }
  });
});
