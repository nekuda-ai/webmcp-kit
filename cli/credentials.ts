import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic-write";

const KEYCHAIN_SERVICE = "ai.nekuda.webmcp.cli";
const KEYCHAIN_ACCOUNT = "oauth";

export type StoredCredentials = {
  version: 1;
  access_token: string;
  refresh_token: string;
  expires_at: number;
  client_id: string;
  token_endpoint: string;
};

export type CredentialBackend = "keychain" | "file";

export type LoadedCredentials = {
  credentials: StoredCredentials;
  backend: CredentialBackend;
};

export interface CredentialStore {
  load(): Promise<LoadedCredentials | null>;
  save(credentials: StoredCredentials): Promise<CredentialBackend>;
}

type CommandResult = { code: number; stdout: string };

/** Runs a secure-storage helper; `null` when the helper is absent or crashed. */
export type CommandRunner = (
  command: string[],
  stdin?: string,
) => Promise<CommandResult | null>;

/**
 * What `security find-generic-password -w` printed, as the value that was stored.
 *
 * It echoes the password verbatim ONLY while every byte is printable ASCII;
 * anything else and it prints the item as lowercase hex with no marker, no flag
 * and no way to ask for the raw bytes. `JSON.stringify` emits non-ASCII
 * characters raw, so one accented character anywhere in a token — or in the
 * OAuth issuer's URL — makes the stored value come back in the other encoding.
 *
 * That is not cosmetic here: the read-back below treats a disagreement as a
 * keychain that refused the write, so it would write the plaintext fallback and
 * then DELETE the item it had just correctly stored, pinning the user to the
 * mode-0600 file on every later login — the exact outcome F01 exists to prevent,
 * arriving through the check meant to prevent it. Decoded conservatively: an
 * even-length all-hex string that decodes to valid UTF-8, which JSON text
 * (always starting `{`) can never itself be mistaken for.
 */
function decodeSecurityOutput(stdout: string): string {
  const value = stdout.trim();
  if (value.length === 0 || value.length % 2 !== 0 || !/^[0-9a-f]+$/.test(value)) return value;
  const decoded = Buffer.from(value, "hex");
  const text = decoded.toString("utf8");
  // Round-trip, so a value that merely LOOKS like hex is not silently mangled.
  return Buffer.from(text, "utf8").equals(decoded) ? text : value;
}

function parseCredentials(value: string): StoredCredentials | null {
  try {
    const parsed = JSON.parse(value) as Partial<StoredCredentials>;
    if (
      parsed.version !== 1 ||
      typeof parsed.access_token !== "string" ||
      !parsed.access_token ||
      typeof parsed.refresh_token !== "string" ||
      !parsed.refresh_token ||
      typeof parsed.expires_at !== "number" ||
      !Number.isFinite(parsed.expires_at) ||
      typeof parsed.client_id !== "string" ||
      !parsed.client_id ||
      typeof parsed.token_endpoint !== "string" ||
      !parsed.token_endpoint
    ) {
      return null;
    }
    return parsed as StoredCredentials;
  } catch {
    return null;
  }
}

async function runCommand(command: string[], stdin?: string): Promise<CommandResult | null> {
  try {
    const process = Bun.spawn(command, {
      stdin: stdin === undefined ? "ignore" : "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    if (stdin !== undefined) {
      process.stdin.write(stdin);
      process.stdin.end();
    }
    const [code, stdout] = await Promise.all([process.exited, new Response(process.stdout).text()]);
    return { code, stdout };
  } catch {
    return null;
  }
}

/**
 * Quotes one argument for `security -i`, whose reader is shell-like: double
 * quotes group a token and a backslash escapes the next byte.
 */
function quoteForSecurity(value: string): string {
  return `"${value.replace(/[\\"]/g, "\\$&")}"`;
}

/**
 * The most bytes one line fed to `security -i` may carry.
 *
 * Its reader tokenizes a FIXED 4096-byte buffer and CUTS there — no error, no short
 * read: the inner command runs with a truncated argument and the tail becomes a second,
 * bogus one. Verified against the real `security(1)`: a 4163-byte line stored a 4035-char
 * password (4096 less the 61-byte prefix), then reported `unknown command`.
 *
 * Here that truncated argument is a CREDENTIAL. The read-back below does catch it, but
 * its recovery is destructive by design — write the plaintext file, delete the keychain
 * item — so a token wide enough to cross this line pins the user to the mode-0600
 * fallback on every login, the outcome F01 exists to prevent. Refuse a write that cannot
 * be expressed rather than issue one and repair it.
 */
const SECURITY_MAX_LINE_BYTES = 4095;

export function secureStorageCommands(platform: NodeJS.Platform): {
  load: string[];
  /** `null` when the value cannot be handed to the helper — see {@link SECURITY_MAX_LINE_BYTES}. */
  save: (value: string) => { command: string[]; stdin?: string } | null;
  clear: string[];
} | null {
  if (platform === "darwin") {
    return {
      load: [
        "security",
        "find-generic-password",
        "-a",
        KEYCHAIN_ACCOUNT,
        "-s",
        KEYCHAIN_SERVICE,
        "-w",
      ],
      clear: [
        "security",
        "delete-generic-password",
        "-a",
        KEYCHAIN_ACCOUNT,
        "-s",
        KEYCHAIN_SERVICE,
      ],
      // `-w <secret>` on the command line would publish the tokens to the process
      // table for the call's lifetime, so the add runs through `security -i`,
      // which takes the whole command — secret included — on stdin. JSON.stringify
      // never emits a raw newline, so the script stays the single line the reader
      // expects.
      save: (value) => {
        const script = `add-generic-password -a ${quoteForSecurity(
          KEYCHAIN_ACCOUNT,
        )} -s ${quoteForSecurity(KEYCHAIN_SERVICE)} -U -w ${quoteForSecurity(value)}`;
        if (Buffer.byteLength(script, "utf8") > SECURITY_MAX_LINE_BYTES) return null;
        return { command: ["security", "-i"], stdin: `${script}\n` };
      },
    };
  }
  if (platform === "linux") {
    return {
      load: ["secret-tool", "lookup", "service", KEYCHAIN_SERVICE, "account", KEYCHAIN_ACCOUNT],
      clear: ["secret-tool", "clear", "service", KEYCHAIN_SERVICE, "account", KEYCHAIN_ACCOUNT],
      save: (value) => ({
        command: [
          "secret-tool",
          "store",
          "--label",
          "WebMCP CLI",
          "service",
          KEYCHAIN_SERVICE,
          "account",
          KEYCHAIN_ACCOUNT,
        ],
        stdin: value,
      }),
    };
  }
  return null;
}

export function credentialsFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.WEBMCP_CONFIG_DIR?.trim();
  if (override) return join(override, "credentials.json");
  const home = env.HOME?.trim() || env.USERPROFILE?.trim();
  if (!home) throw new Error("Cannot locate the home directory for credential storage");
  return join(home, ".config", "webmcp", "credentials.json");
}

export function createFileCredentialStore(path: string): CredentialStore {
  return {
    async load() {
      try {
        const credentials = parseCredentials(await readFile(path, "utf8"));
        return credentials ? { credentials, backend: "file" } : null;
      } catch {
        return null;
      }
    },
    async save(credentials) {
      await writeFileAtomic(path, JSON.stringify(credentials), {
        mode: 0o600,
        directoryMode: 0o700,
      });
      return "file";
    },
  };
}

export function createCredentialStore(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  run: CommandRunner = runCommand,
): CredentialStore {
  const filePath = credentialsFilePath(env);
  const fileStore = createFileCredentialStore(filePath);
  const commands = env.WEBMCP_DISABLE_SECURE_STORAGE ? null : secureStorageCommands(platform);

  return {
    async load() {
      if (commands) {
        const result = await run(commands.load);
        const credentials =
          result?.code === 0 ? parseCredentials(decodeSecurityOutput(result.stdout)) : null;
        if (credentials) return { credentials, backend: "keychain" };
      }
      return fileStore.load();
    },
    async save(credentials) {
      if (commands) {
        const value = JSON.stringify(credentials);
        const save = commands.save(value);
        // `null` = the helper cannot carry this value (see `SECURITY_MAX_LINE_BYTES`).
        // Skip the write, NOT the rest: the read-back still runs, so a stale item already
        // in the keychain is found, disagrees, and is cleared down the same path a refused
        // UPDATE takes — without which `load` would keep preferring those older tokens
        // over the file copy written here.
        if (save) await run(save.command, save.stdin);
        // `security -i` reports the inner command's status, but only as the exit
        // code of the whole session — read the item back before dropping the file
        // fallback, so a keychain that silently refused the write cannot log the
        // user out with nothing on disk.
        // Read back unconditionally, NOT only when the write claimed success. A write
        // that honestly reported failure is exactly when a stale entry is most likely
        // to survive — macOS grants read but refuses update on a per-item ACL after a
        // Deny click — and gating the read-back on success skips the cleanup below in
        // precisely that case.
        const stored = await run(commands.load);
        // The READ-BACK is authoritative, and `result.code` is deliberately not part of
        // this condition: the comment above is the reason — `security -i` reports the
        // SESSION's status, so a non-zero exit alongside a keychain that provably holds
        // exactly what we just wrote is a successful write. Requiring both discarded that
        // write, fell back to the plaintext file, and then — because `stored.code === 0` —
        // ran `commands.clear` and DELETED the correct keychain item, pinning the user to
        // the mode-0600 fallback on every subsequent login (F01).
        if (stored?.code === 0 && decodeSecurityOutput(stored.stdout) === value) {
          await rm(filePath, { force: true });
          return "keychain";
        }
        // The read-back disagreed, so what the keychain holds is not what we just wrote — and
        // on a re-login that is an OLDER, still-parseable entry, which is the shape a refused
        // UPDATE leaves behind. `load` prefers the keychain, so leaving it there means every
        // later read returns the tokens this save replaced: the file copy below would be
        // written and never read, and the user sees 401s after a login that reported success.
        // Best-effort — a keychain that also refuses the delete leaves us exactly where
        // refusing the write already did. The file copy is written FIRST: clearing the
        // keychain before a file write that then fails would leave the credentials in
        // neither store, logging the user out of a login that otherwise worked.
        const backend = await fileStore.save(credentials);
        if (stored?.code === 0) await run(commands.clear);
        return backend;
      }
      return fileStore.save(credentials);
    },
  };
}
