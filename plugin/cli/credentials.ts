import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

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

function secureStorageCommands(platform: NodeJS.Platform): {
  load: string[];
  save: (value: string) => { command: string[]; stdin?: string };
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
      save: (value) => ({
        command: [
          "security",
          "add-generic-password",
          "-a",
          KEYCHAIN_ACCOUNT,
          "-s",
          KEYCHAIN_SERVICE,
          "-U",
          "-w",
          value,
        ],
      }),
    };
  }
  if (platform === "linux") {
    return {
      load: ["secret-tool", "lookup", "service", KEYCHAIN_SERVICE, "account", KEYCHAIN_ACCOUNT],
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
      const directory = dirname(path);
      const temporary = join(directory, `.credentials-${randomUUID()}.tmp`);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      try {
        const file = await open(temporary, "wx", 0o600);
        try {
          await file.writeFile(JSON.stringify(credentials));
          await file.sync();
        } finally {
          await file.close();
        }
        await chmod(temporary, 0o600);
        await rename(temporary, path);
        await chmod(path, 0o600);
      } finally {
        await rm(temporary, { force: true });
      }
      return "file";
    },
  };
}

export function createCredentialStore(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): CredentialStore {
  const filePath = credentialsFilePath(env);
  const fileStore = createFileCredentialStore(filePath);
  const commands = env.WEBMCP_DISABLE_SECURE_STORAGE ? null : secureStorageCommands(platform);

  return {
    async load() {
      if (commands) {
        const result = await runCommand(commands.load);
        const credentials = result?.code === 0 ? parseCredentials(result.stdout.trim()) : null;
        if (credentials) return { credentials, backend: "keychain" };
      }
      return fileStore.load();
    },
    async save(credentials) {
      if (commands) {
        const save = commands.save(JSON.stringify(credentials));
        const result = await runCommand(save.command, save.stdin);
        if (result?.code === 0) {
          await rm(filePath, { force: true });
          return "keychain";
        }
      }
      return fileStore.save(credentials);
    },
  };
}
