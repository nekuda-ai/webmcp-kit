import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createCredentialStore,
  createFileCredentialStore,
  secureStorageCommands,
  type StoredCredentials,
} from "../../cli/credentials";
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

const SECRET_CREDENTIALS: StoredCredentials = {
  version: 1,
  access_token: 'argv-access "token"\\1',
  refresh_token: "argv-refresh-token",
  expires_at: 1_800_000_000_000,
  client_id: "client",
  token_endpoint: "https://example.test/token",
};

// Mirror `security -i`'s shell-like tokenizer (double quotes group a token,
// backslash escapes the next byte) so the fake keychain proves our quoting
// round-trips rather than just accepting whatever we emit.
function securityScriptArguments(script: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quoted = false;
  let started = false;
  for (let index = 0; index < script.length; index++) {
    const character = script[index];
    if (character === "\\") {
      current += script[++index] ?? "";
      started = true;
    } else if (character === '"') {
      quoted = !quoted;
      started = true;
    } else if (!quoted && (character === " " || character === "\n")) {
      if (started) tokens.push(current);
      current = "";
      started = false;
    } else {
      current += character;
      started = true;
    }
  }
  if (started) tokens.push(current);
  return tokens;
}

/**
 * `failSave` is the honest refusal — a non-zero exit with nothing stored. `silentSave` is
 * the one the read-back exists for: `security -i` reports the SESSION's status, not the
 * inner `add-generic-password`'s, so a refused write comes back `code: 0` with nothing
 * stored. Both must land on the file store.
 *
 * `noisySave` is that same decoupling in the OTHER direction, and the reason `result.code`
 * is not part of the accept condition at all: the write LANDED and a non-zero session
 * status still came back. Trusting the code there discards a provably-correct keychain
 * item, writes the plaintext fallback, and then — because the read-back succeeded —
 * deletes the correct item, pinning the user to the mode-0600 store on every later login.
 */
function fakeSecureStorage(
  options: {
    failSave?: boolean;
    silentSave?: boolean;
    noisySave?: boolean;
    seed?: string;
    failClear?: boolean;
  } = {},
) {
  const calls: { command: string[]; stdin?: string }[] = [];
  let stored: string | null = options.seed ?? null;
  return {
    calls,
    stored: () => stored,
    run: async (command: string[], stdin?: string) => {
      calls.push({ command, stdin });
      const script = securityScriptArguments(stdin ?? "");
      const clear = command.includes("delete-generic-password") || command.includes("clear");
      if (clear) {
        if (options.failClear) return { code: 1, stdout: "" };
        stored = null;
        return { code: 0, stdout: "" };
      }
      const write = command.includes("-i") || command.includes("store");
      if (!write) return stored === null ? { code: 44, stdout: "" } : { code: 0, stdout: stored };
      if (options.failSave) return { code: 1, stdout: "" };
      if (options.silentSave) return { code: 0, stdout: "" };
      stored = command.includes("-i") ? (script[script.indexOf("-w") + 1] ?? "") : (stdin ?? "");
      return { code: options.noisySave ? 1 : 0, stdout: "" };
    },
  };
}

describe("secure credential storage", () => {
  // The process table is readable by every same-uid process (and captured verbatim
  // by argv-logging EDR), so no platform may pass the token as an argument.
  test.each(["darwin", "linux"] as const)("%s save keeps the secret out of argv", (platform) => {
    const secret = JSON.stringify(SECRET_CREDENTIALS);
    const save = secureStorageCommands(platform)?.save(secret);
    expect(save).toBeDefined();
    for (const argument of save?.command ?? []) expect(argument).not.toContain("argv-access");
    expect(save?.stdin ?? "").toContain("argv-access");
  });

  test.each(["darwin", "linux"] as const)("%s round-trips through the store", async (platform) => {
    const { path } = await temporaryCredentials();
    const keychain = fakeSecureStorage();
    const store = createCredentialStore(
      { WEBMCP_CONFIG_DIR: dirname(path) },
      platform,
      keychain.run,
    );

    expect(await store.save(SECRET_CREDENTIALS)).toBe("keychain");
    expect(await store.load()).toEqual({ credentials: SECRET_CREDENTIALS, backend: "keychain" });
    // The keychain owns the credentials now — no plaintext copy may survive beside it.
    expect(await stat(path).catch(() => null)).toBeNull();
  });

  test("a failing keychain write falls back to the file store without leaking the secret", async () => {
    const { path } = await temporaryCredentials();
    const keychain = fakeSecureStorage({ failSave: true });
    const store = createCredentialStore({ WEBMCP_CONFIG_DIR: dirname(path) }, "darwin", keychain.run);
    const logged: string[] = [];
    const console_ = { error: console.error, warn: console.warn, log: console.log };
    const capture = (value: unknown) => logged.push(String(value));
    console.error = capture;
    console.warn = capture;
    console.log = capture;

    try {
      expect(await store.save(SECRET_CREDENTIALS)).toBe("file");
    } finally {
      Object.assign(console, console_);
    }

    expect(logged.join("\n")).not.toContain("argv-access");
    expect(logged.join("\n")).not.toContain("argv-refresh-token");
    expect(keychain.calls.flatMap((call) => call.command).join(" ")).not.toContain("argv-access");
    expect((await store.load())?.backend).toBe("file");
  });

  // The hazard `security -i` creates: the session exits 0 whatever the inner
  // add-generic-password did. Trusting that code alone deletes the file fallback
  // and reports "keychain" for credentials that are nowhere — a silent logout with
  // no copy to recover from. Only the read-back can tell the two apart, so this is
  // the case that pins it; the honest non-zero refusal above passes either way.
  test("a keychain write that silently stored nothing keeps the file store", async () => {
    const { path } = await temporaryCredentials();
    const keychain = fakeSecureStorage({ silentSave: true });
    const store = createCredentialStore({ WEBMCP_CONFIG_DIR: dirname(path) }, "darwin", keychain.run);

    expect(await store.save(SECRET_CREDENTIALS)).toBe("file");
    expect(keychain.stored()).toBeNull();
    expect(await stat(path).catch(() => null)).not.toBeNull();
    expect(await store.load()).toEqual({ credentials: SECRET_CREDENTIALS, backend: "file" });
  });

  // The same decoupling, inverted — and the reason the read-back is the ONLY authority.
  // The write landed; the session still exited non-zero. Requiring both signals threw the
  // good item away, wrote the plaintext fallback, and then deleted the correct keychain
  // entry (the read-back had succeeded, so the cleanup fired), silently demoting every
  // subsequent login to the mode-0600 file store — the outcome F01 exists to prevent.
  test("a keychain write that landed is kept even when the session reports failure", async () => {
    const { path } = await temporaryCredentials();
    const keychain = fakeSecureStorage({ noisySave: true });
    const store = createCredentialStore({ WEBMCP_CONFIG_DIR: dirname(path) }, "darwin", keychain.run);

    expect(await store.save(SECRET_CREDENTIALS)).toBe("keychain");
    expect(keychain.stored()).toBe(JSON.stringify(SECRET_CREDENTIALS));
    // No plaintext copy left behind, and nothing cleared the item we just proved good.
    expect(await stat(path).catch(() => null)).toBeNull();
    expect(await store.load()).toEqual({ credentials: SECRET_CREDENTIALS, backend: "keychain" });
  });

  // The same silent refusal on a RE-login, which is the likelier shape: the keychain still
  // holds the PREVIOUS, perfectly parseable entry. `load` prefers the keychain, so leaving it
  // means the fresh file copy is written and never read again — the user is handed the tokens
  // this login replaced and sees 401s after a login that reported success.
  test.each(["darwin", "linux"] as const)(
    "%s: a silently refused update does not leave stale credentials shadowing the file",
    async (platform) => {
      const { path } = await temporaryCredentials();
      const stale = JSON.stringify({ ...SECRET_CREDENTIALS, access_token: "stale-access-token" });
      const keychain = fakeSecureStorage({ silentSave: true, seed: stale });
      const store = createCredentialStore({ WEBMCP_CONFIG_DIR: dirname(path) }, platform, keychain.run);

      expect(await store.save(SECRET_CREDENTIALS)).toBe("file");
      expect(keychain.stored()).toBeNull();
      expect(await store.load()).toEqual({ credentials: SECRET_CREDENTIALS, backend: "file" });
    },
  );

  // The SAME re-login, but with the honest non-zero refusal instead of the silent one —
  // a macOS per-item ACL that allows read and denies update after a Deny click, or a real
  // `secret-tool store` failure. Gating the read-back on `code === 0` skipped the cleanup
  // in exactly this case, so the stale entry survived, `load` kept preferring it, and the
  // fresh file copy was written and never read: the 401 loop the silent case fixed,
  // reached by the other door. The case above misses it because it seeds no prior entry.
  test.each(["darwin", "linux"] as const)(
    "%s: an openly refused update does not leave stale credentials shadowing the file",
    async (platform) => {
      const { path } = await temporaryCredentials();
      const stale = JSON.stringify({ ...SECRET_CREDENTIALS, access_token: "stale-access-token" });
      const keychain = fakeSecureStorage({ failSave: true, seed: stale });
      const store = createCredentialStore({ WEBMCP_CONFIG_DIR: dirname(path) }, platform, keychain.run);

      expect(await store.save(SECRET_CREDENTIALS)).toBe("file");
      expect(keychain.stored()).toBeNull();
      expect(await store.load()).toEqual({ credentials: SECRET_CREDENTIALS, backend: "file" });
    },
  );

  // Ordering: the keychain is only cleared once the file copy is on disk. Clearing first
  // and then failing the write leaves the credentials in NEITHER store — a login that
  // reported success and logged the user out.
  test("a failing file write never clears the keychain out from under it", async () => {
    const { path } = await temporaryCredentials();
    const stale = JSON.stringify({ ...SECRET_CREDENTIALS, access_token: "stale-access-token" });
    const keychain = fakeSecureStorage({ silentSave: true, seed: stale });
    // A directory where the credentials file must go: the atomic write cannot succeed.
    await mkdir(join(dirname(path), "credentials.json"), { recursive: true });
    const store = createCredentialStore({ WEBMCP_CONFIG_DIR: dirname(path) }, "darwin", keychain.run);

    await expect(store.save(SECRET_CREDENTIALS)).rejects.toBeDefined();
    expect(keychain.stored()).toBe(stale);
  });

  // A keychain that refuses the delete too leaves us exactly where refusing the write did —
  // stale credentials still win, but the file copy exists, so `webmcp logout` can recover.
  // What must NOT happen is the save reporting "keychain" or deleting the file.
  test("a keychain that refuses the delete still keeps the file copy", async () => {
    const { path } = await temporaryCredentials();
    const stale = JSON.stringify({ ...SECRET_CREDENTIALS, access_token: "stale-access-token" });
    const keychain = fakeSecureStorage({ silentSave: true, seed: stale, failClear: true });
    const store = createCredentialStore({ WEBMCP_CONFIG_DIR: dirname(path) }, "darwin", keychain.run);

    expect(await store.save(SECRET_CREDENTIALS)).toBe("file");
    expect(await stat(path).catch(() => null)).not.toBeNull();
  });

  // `security -i` reads a FIXED 4096-byte line buffer and CUTS there — no error, no short
  // read: the inner `add-generic-password` runs with a truncated `-w`, and the tail becomes
  // a second, bogus command. Verified against the real binary. The fake tokenizer above
  // models the quoting but not the cap, so nothing else here can see it. A Clerk token with
  // fat org claims crosses the line, the keychain silently holds a corrupt credential, the
  // read-back disagrees, and the recovery path deletes the item and pins the user to the
  // mode-0600 file store on every login — the outcome F01 exists to prevent. Refuse the
  // write instead of issuing one that is guaranteed to be wrong.
  test("darwin refuses a keychain write no single security(1) line can carry", () => {
    const commands = secureStorageCommands("darwin");
    const fat = JSON.stringify({ ...SECRET_CREDENTIALS, access_token: "x".repeat(4_096) });

    expect(commands?.save(fat)).toBeNull();
    // Everything the helper CAN carry stays within one line, newline included.
    const ordinary = commands?.save(JSON.stringify(SECRET_CREDENTIALS));
    expect(Buffer.byteLength(ordinary?.stdin ?? "", "utf8")).toBeLessThanOrEqual(4_096);
  });

  // ...and the store degrades cleanly rather than reporting a keychain it never wrote.
  // The stale item still has to go: `load` prefers the keychain, so leaving the previous
  // login's tokens there would shadow the fresh file copy written beside them.
  test.each([
    ["with no prior item", undefined],
    ["with a stale prior item", JSON.stringify({ ...SECRET_CREDENTIALS, access_token: "stale" })],
  ] as const)("an unwritable-length credential falls back to the file store %s", async (_, seed) => {
    const { path } = await temporaryCredentials();
    const keychain = fakeSecureStorage(seed ? { seed } : {});
    const store = createCredentialStore({ WEBMCP_CONFIG_DIR: dirname(path) }, "darwin", keychain.run);
    const fat = { ...SECRET_CREDENTIALS, access_token: "x".repeat(4_096) };

    expect(await store.save(fat)).toBe("file");
    // No `security -i` session was ever opened for a write that could only corrupt.
    expect(keychain.calls.some((call) => call.command.includes("-i"))).toBe(false);
    expect(keychain.stored()).toBeNull();
    expect(await store.load()).toEqual({ credentials: fat, backend: "file" });
  });

  // The other half of the same guard: a keychain that stores a DIFFERENT value
  // (an older item the write did not replace) reads back 0 with the wrong bytes.
  test("a keychain read-back that disagrees with what we wrote keeps the file store", async () => {
    const { path } = await temporaryCredentials();
    const keychain = fakeSecureStorage();
    const stale = JSON.stringify({ ...SECRET_CREDENTIALS, access_token: "argv-access-stale" });
    const store = createCredentialStore(
      { WEBMCP_CONFIG_DIR: dirname(path) },
      "darwin",
      async (command: string[], stdin?: string) => {
        const result = await keychain.run(command, stdin);
        // The write "succeeds"; every read answers the stale item instead.
        return command.includes("-i") ? result : { code: 0, stdout: stale };
      },
    );

    expect(await store.save(SECRET_CREDENTIALS)).toBe("file");
    expect(await stat(path).catch(() => null)).not.toBeNull();
  });
});
