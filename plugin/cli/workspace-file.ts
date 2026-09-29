import { realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { CliError } from "./login";

/** Check the actual target, including parent symlinks, before reading or writing contents. */
export async function workspaceFile(workspace: string, path: string, code: string): Promise<string> {
  const root = await realpath(workspace);
  const target = await realpath(path);
  const display = relative(root, target).replaceAll("\\", "/");
  if (display === ".." || display.startsWith("../") || isAbsolute(display)) {
    throw new CliError(code, `Module is outside the workspace: ${path}`);
  }
  return target;
}
