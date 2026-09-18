import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The host manifests a released copy of this plugin may ship, in precedence order —
 * `.claude-plugin/plugin.json` is the version source of truth wherever it exists. Which
 * ones are present depends on the build: the plugin folder synced to the public repo
 * carries both, and the OpenAI skills bundle (`scripts/package-openai-skills.py`) copies
 * `skills, assets, cli, scripts` and writes only the Codex manifest. So naming one of
 * them in a static JSON import resolves at build time against the monorepo and then
 * fails at IMPORT time on the host that ships the other — taking every `webmcp` command
 * down before argv is parsed. Read whichever is actually there instead. */
const HOST_MANIFESTS = [".claude-plugin/plugin.json", ".codex-plugin/plugin.json"];

function manifestVersion(): string {
  const root = join(import.meta.dir, "..");
  for (const rel of HOST_MANIFESTS) {
    const path = join(root, rel);
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      continue; // Absent is expected — a build ships the manifests its host reads.
    }
    // Present but unusable is not: falling through would quietly attribute this
    // release to whatever the next manifest happens to say.
    let version: unknown;
    try {
      version = (JSON.parse(raw) as { version?: unknown }).version;
    } catch (error) {
      throw new Error(`${path}: invalid JSON (${error})`);
    }
    if (typeof version !== "string" || version.length === 0)
      throw new Error(`${path}: no "version" string`);
    return version;
  }
  throw new Error(
    `no plugin manifest beside the CLI: looked for ${HOST_MANIFESTS.join(" and ")} under ${root}`,
  );
}

/** Sent on every API request so the server can attribute a Connect to a plugin release
 * (`kit_connected.kit_version`); without it the access log shows a bare `Bun/x`. */
export const KIT_USER_AGENT = `webmcp-kit/${manifestVersion()}`;

/** Names the skill behind a Connect (`implement` | `connect-existing-tools`). */
export const KIT_SKILL_HEADER = "x-webmcp-kit-skill";
