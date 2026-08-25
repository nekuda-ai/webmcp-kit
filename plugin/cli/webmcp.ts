#!/usr/bin/env bun

import { type ConnectOptions, connect } from "./connect";
import { CliError, type LoginOptions, login } from "./login";
import { status } from "./status";

const USAGE = `Usage:
  webmcp login [--json]
  webmcp connect --workspace <dir> [--site-url <url>] [--environment <name>] [--org <id>] [--json]
  webmcp status --workspace <dir> [--json]`;

type Io = {
  stdout: (value: string) => void;
  stderr: (value: string) => void;
};

export type MainOptions = LoginOptions &
  Pick<ConnectOptions, "retryDelayMs" | "maxAttempts" | "sleep" | "projectKey"> & {
    io?: Io;
  };

type Parsed = {
  command: string | null;
  json: boolean;
  help: boolean;
  values: Record<string, string>;
  invalid: boolean;
};

function parseArgs(args: string[]): Parsed {
  const parsed: Parsed = {
    command: null,
    json: false,
    help: false,
    values: {},
    invalid: false,
  };
  const valueOptions = new Set(["--workspace", "--site-url", "--environment", "--org"]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--json") parsed.json = true;
    else if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (valueOptions.has(arg)) {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) parsed.invalid = true;
      else {
        parsed.values[arg] = value;
        index += 1;
      }
    } else if (arg.startsWith("-")) parsed.invalid = true;
    else if (parsed.command === null) parsed.command = arg;
    else parsed.invalid = true;
  }
  return parsed;
}

export async function main(args: string[], options: MainOptions = {}): Promise<number> {
  const parsed = parseArgs(args);
  const io = options.io ?? {
    stdout: (value) => console.log(value),
    stderr: (value) => console.error(value),
  };
  if (parsed.help) {
    io.stdout(USAGE);
    return 0;
  }

  const allowedValues =
    parsed.command === "connect"
      ? new Set(["--workspace", "--site-url", "--environment", "--org"])
      : parsed.command === "status"
        ? new Set(["--workspace"])
        : new Set<string>();
  const unsupportedValue = Object.keys(parsed.values).some((key) => !allowedValues.has(key));
  const requiresWorkspace = parsed.command === "connect" || parsed.command === "status";
  if (
    parsed.invalid ||
    unsupportedValue ||
    !["login", "connect", "status"].includes(parsed.command ?? "") ||
    (requiresWorkspace && !parsed.values["--workspace"])
  ) {
    const message =
      parsed.command && !["login", "connect", "status"].includes(parsed.command)
        ? `Unknown command: ${parsed.command}`
        : USAGE;
    if (parsed.json) io.stdout(JSON.stringify({ ok: false, error: { code: "usage", message } }));
    else io.stderr(message === USAGE ? USAGE : `${message}\n${USAGE}`);
    return 2;
  }

  try {
    if (parsed.command === "login") {
      const result = await login({
        ...options,
        showAuthorizationUrl:
          options.showAuthorizationUrl ??
          ((url) => io.stderr(`Open this URL if your browser did not open:\n${url}`)),
      });
      if (parsed.json) io.stdout(JSON.stringify({ ok: true, command: "login", ...result }));
      else if (result.status === "logged_in") io.stdout("Logged in to WebMCP.");
      else if (result.status === "refreshed") io.stdout("WebMCP login refreshed.");
      return 0;
    }

    if (parsed.command === "connect") {
      const result = await connect({
        ...options,
        workspace: parsed.values["--workspace"] as string,
        siteUrl: parsed.values["--site-url"],
        environment: parsed.values["--environment"],
        org: parsed.values["--org"],
        showAuthorizationUrl:
          options.showAuthorizationUrl ??
          ((url) => io.stderr(`Open this URL if your browser did not open:\n${url}`)),
      });
      if (parsed.json) {
        io.stdout(
          JSON.stringify({ ok: result.status === "connected", command: "connect", ...result }),
        );
      }
      else if (result.status === "connected") {
        io.stdout(
          `Connection ready for ${result.domain.display_name} (${result.environment}). Return to your agent to finish setup.`,
        );
      } else {
        io.stderr(
          result.edge_verification === "disabled"
            ? "WebMCP edge verification is disabled; the application source was not changed."
            : "WebMCP key propagation is still pending; retry connect before changing source.",
        );
      }
      if (result.status === "connected") return 0;
      return result.edge_verification === "disabled" ? 1 : 3;
    }

    const result = await status({
      workspace: parsed.values["--workspace"] as string,
      apiBase: options.apiBase,
      fetch: options.fetch,
      store: options.store,
    });
    if (parsed.json) io.stdout(JSON.stringify({ ok: true, command: "status", ...result }));
    else {
      io.stdout(
        result.flags.already_connected
          ? `Connected to ${result.connect_file.contents?.display_name ?? "WebMCP"}.`
          : "This workspace is not connected to WebMCP.",
      );
    }
    return 0;
  } catch (error) {
    const known = error instanceof CliError;
    const code = known ? error.code : `${parsed.command}_failed`;
    const message = known ? error.message : `WebMCP ${parsed.command} failed`;
    if (parsed.json) io.stdout(JSON.stringify({ ok: false, error: { code, message } }));
    else io.stderr(`webmcp: ${message}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main(Bun.argv.slice(2));
}
