import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { CliError } from "./login";
import {
  callAt,
  scanDesynchronized,
  structuralMask,
  topLevelArguments,
  withoutComments,
} from "./source-scan";
import { workspaceFile } from "./workspace-file";

/**
 * Connect edits tracking settings as text, without executing the module or returning the key
 * to the agent. Ambiguous options refuse before provisioning; concurrent edits refuse at commit.
 */

const MODULE_SIZE_LIMIT = 1024 * 1024;
const KEY_COMMENT = "/* publishable key, safe to commit */";

export type EntryModule = {
  /** Absolute path on disk. */
  path: string;
  /** Workspace-relative display path. */
  display: string;
  /** Preserve the source file's permissions. */
  mode: number;
  batches: number;
  /** The module's bytes with the key wired into every batch. */
  wire(apiKey: string, endpoint?: string): string;
  /** Refuse if the developer changed the file or its target while Connect was pending. */
  assertUnchanged(): Promise<void>;
};

type Edit = { start: number; end: number; text: string };

function notEditable(display: string, problem: string): never {
  throw new CliError(
    "entry_module_not_editable",
    `${display}: ${problem}. webmcp connect edits the source as text, so the options and tracking arguments of every registerTools call must be object literals.`,
  );
}

/** The `{ … }` whose opening brace sits at `start` in the mask: its body span, or null. */
function objectAt(mask: string, start: number): { bodyStart: number; bodyEnd: number } | null {
  let depth = 0;
  for (let i = start; i < mask.length; i += 1) {
    const char = mask[i];
    if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return { bodyStart: start + 1, bodyEnd: i };
  }
  return null;
}

/** Top-level members of an object or argument list body, each with its span in the whole. */
function members(mask: string, bodyStart: number, bodyEnd: number) {
  const parts = topLevelArguments(mask.slice(bodyStart, bodyEnd));
  let offset = bodyStart;
  return parts.map((part) => {
    const span = { text: part, start: offset, end: offset + part.length };
    offset = span.end + 1;
    return span;
  });
}

/** Unknown keys/spreads may override the connection. Refuse rather than guess precedence. */
function editableMembers(display: string, code: string, mask: string, start: number, end: number) {
  const parts = members(mask, start, end);
  const seen = new Set<string>();
  for (const part of parts) {
    const text = code.slice(part.start, part.end).trim();
    if (!text) continue;
    const key = /^([A-Za-z_$][\w$]*)\s*(?::|$)/.exec(text)?.[1];
    if (!key || seen.has(key)) notEditable(display, "an option has an ambiguous or duplicate key");
    seen.add(key);
    if (/^(apiKey|endpoint)$/.test(key) && !text.includes(":")) {
      notEditable(display, "a connection setting is a shorthand property");
    }
  }
  return parts;
}

/** An object body's members laid out the way the original was: one per line, or inline. */
function layoutBody(original: string, items: string[]): string {
  if (!original.includes("\n")) return ` ${items.join(", ")} `;
  const indent = /\n([ \t]*)\S/.exec(original)?.[1] ?? `${closingIndent(original)}  `;
  return `\n${items.map((item) => indent + item).join(",\n")},\n${closingIndent(original)}`;
}

function closingIndent(body: string): string {
  const tail = body.slice(body.lastIndexOf("\n") + 1);
  return tail.trim() === "" ? tail : "";
}

function keyProperties(apiKey: string, endpoint?: string): string[] {
  return [
    `apiKey: ${JSON.stringify(apiKey)} ${KEY_COMMENT}`,
    ...(endpoint ? [`endpoint: ${JSON.stringify(endpoint)}`] : []),
  ];
}

/** Pure, repeatable connection edit of every registration batch, or a refusal. */
export function wireSource(
  display: string,
  source: string,
  apiKey: string,
  endpoint?: string,
): { source: string; batches: number } {
  const blanked = withoutComments(source);
  if (scanDesynchronized(blanked)) {
    notEditable(display, "the module could not be read to the end (an unterminated string)");
  }
  const mask = structuralMask(blanked);
  const edits: Edit[] = [];
  const tracking = `tracking: { ${keyProperties(apiKey, endpoint).join(", ")} }`;
  const pattern = /\bregisterTools\s*\(/g;
  for (let match = pattern.exec(mask); match; match = pattern.exec(mask)) {
    if (mask.slice(0, match.index).trimEnd().endsWith(".")) continue;
    const open = match.index + match[0].length - 1;
    const call = callAt(mask, open);
    if (!call) break;
    pattern.lastIndex = call.end;
    const args = members(mask, open + 1, call.end - 1);
    const first = args[0];
    const options = args[1];
    if (!first) notEditable(display, "a registerTools call has no arguments");
    if (!options || options.text.trim() === "") {
      const at = first.start + first.text.trimEnd().length;
      edits.push({ start: at, end: at, text: `, { ${tracking} }` });
      continue;
    }
    const brace = options.start + options.text.search(/\S/);
    const object = mask[brace] === "{" ? objectAt(mask, brace) : null;
    if (!object) notEditable(display, "a registerTools options argument is not an object literal");
    const property = editableMembers(display, blanked, mask, object.bodyStart, object.bodyEnd).find(
      (member) => /^\s*tracking\s*(:|$)/.test(member.text),
    );
    if (property && !property.text.includes(":")) {
      // `{ tracking }` names a variable: its value lives elsewhere in the file.
      notEditable(display, "a registerTools tracking option is a shorthand property");
    }
    if (!property) {
      const body = source.slice(object.bodyStart, object.bodyEnd);
      const text = body.includes("\n")
        ? `\n${/\n([ \t]*)\S/.exec(body)?.[1] ?? "  "}${tracking},`
        : ` ${tracking},`;
      edits.push({ start: object.bodyStart, end: object.bodyStart, text });
      continue;
    }
    const valueAt = property.start + property.text.indexOf(":") + 1;
    const valueBrace = valueAt + mask.slice(valueAt, property.end).search(/\S/);
    const value = mask[valueBrace] === "{" ? objectAt(mask, valueBrace) : null;
    if (!value) notEditable(display, "a registerTools tracking option is not an object literal");
    const kept = editableMembers(display, blanked, mask, value.bodyStart, value.bodyEnd)
      .filter((member) => member.text.trim() !== "" && !/^\s*(apiKey|endpoint)\s*:/.test(member.text))
      .map((member) => {
        const text = source.slice(member.start, member.end).trim();
        // A terminal comment must not swallow the separator layoutBody adds next.
        return withoutComments(text).trimEnd().length < text.length ? `${text}\n` : text;
      });
    edits.push({
      start: value.bodyStart,
      end: value.bodyEnd,
      text: layoutBody(source.slice(value.bodyStart, value.bodyEnd), [
        ...keyProperties(apiKey, endpoint),
        ...kept,
      ]),
    });
  }
  if (edits.length === 0) {
    throw new CliError(
      "entry_module_no_registration",
      `${display} has no registerTools call to connect; pass the entry module that registers the tools`,
    );
  }
  let output = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
  }
  return { source: output, batches: edits.length };
}

/** Validate the entry before provisioning, retaining its snapshot for the commit check. */
export async function loadEntryModule(workspace: string, entry: string): Promise<EntryModule> {
  const requestedPath = isAbsolute(entry) ? resolve(entry) : resolve(join(workspace, entry));
  const display = relative(workspace, requestedPath).replaceAll("\\", "/");
  if (display === "" || display.startsWith("..")) {
    throw new CliError(
      "entry_module_outside_workspace",
      `Entry module is outside the workspace: ${entry}`,
    );
  }
  let source: string;
  let mode: number;
  let path: string;
  try {
    path = await workspaceFile(workspace, requestedPath, "entry_module_outside_workspace");
    const info = await stat(path);
    if (!info.isFile() || info.size > MODULE_SIZE_LIMIT) throw new Error("not a source file");
    mode = info.mode & 0o777;
    source = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError("entry_module_not_found", `Entry module not found: ${display}`);
  }
  // Wired once with a placeholder to surface every refusal now; the real key comes later.
  const { batches } = wireSource(display, source, "wmk_placeholder");
  return {
    path,
    display,
    mode,
    batches,
    wire: (apiKey, endpoint) => wireSource(display, source, apiKey, endpoint).source,
    async assertUnchanged() {
      try {
        if (
          (await workspaceFile(workspace, requestedPath, "entry_module_outside_workspace")) === path &&
          (await readFile(path, "utf8")) === source
        ) {
          return;
        }
      } catch {
        // Missing files and changed symlink targets are changes too; never restore old bytes.
      }
      throw new CliError(
        "entry_module_changed",
        `${display} changed during Connect; retry with the current source`,
      );
    },
  };
}
