#!/usr/bin/env bun

import { browserMain } from "./browser";

const USAGE = `Usage:
  webmcp browser <command> [...args]`;

/** The kit's own login, Connect, status and publish were removed: the account steps now run
 * through AgentLane's hosted MCP server, which ships with this plugin and signs in once in
 * the AI app. A kit user who still runs one of them gets this one message. */
export const SIGN_IN_AGAIN =
  "webmcp: this command was removed. AgentLane now works through its MCP server, which comes with this plugin: sign in again through your AI app (in Claude Code, /mcp, then agentlane), then ask your agent to connect the site.";

const RETIRED = new Set(["login", "connect", "status", "publish"]);

/** The 0.9 parser's value flags: each takes the next word, which is its value, never the command. */
const VALUE_FLAGS = new Set([
  "--workspace",
  "--site-url",
  "--environment",
  "--org",
  "--entry",
  "--scope",
  "--skill",
  "--name",
]);

/** The command word as the 0.9 parser read it: the first word that is not a flag or a flag's value. */
function commandWord(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (VALUE_FLAGS.has(arg)) i += 1;
    else if (!arg.startsWith("-")) return arg;
  }
  return undefined;
}

type Io = {
  stdout: (value: string) => void;
  stderr: (value: string) => void;
};

export type MainOptions = { io?: Io };

export async function main(args: string[], options: MainOptions = {}): Promise<number> {
  if (args[0] === "browser") return browserMain(args.slice(1));
  const io = options.io ?? {
    stdout: (value) => console.log(value),
    stderr: (value) => console.error(value),
  };
  // The command word only, read as 0.9 read it: value flags may come first
  // (`webmcp --workspace /repo connect`), and a retired word elsewhere (`webmcp deploy connect`,
  // `--name status`) is not the command.
  const command = commandWord(args);
  const json = args.includes("--json");
  if (command !== undefined && RETIRED.has(command)) {
    if (json)
      io.stdout(JSON.stringify({ ok: false, error: { code: "moved_to_mcp", message: SIGN_IN_AGAIN } }));
    else io.stderr(SIGN_IN_AGAIN);
    return 2;
  }
  if (!command && (args.includes("--help") || args.includes("-h"))) {
    io.stdout(USAGE);
    return 0;
  }
  io.stderr(command ? `Unknown command: ${command}\n${USAGE}` : USAGE);
  return 2;
}

if (import.meta.main) {
  process.exitCode = await main(Bun.argv.slice(2));
}
