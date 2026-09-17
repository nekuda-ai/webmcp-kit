import { readFile } from "node:fs/promises";
import { CliError } from "./login";
import {
  callAt,
  scanDesynchronized,
  structuralMask,
  topLevelArguments,
  withoutComments,
} from "./source-scan";

/**
 * The publish manifest: what an entry module DECLARES about its tools, read out of the
 * source text without running it.
 *
 * Never imported, always parsed. Importing the merchant's entry module to enumerate its
 * tools would run their code in our process — module-level fetches, framework globals that
 * are not there, a bundler-specific resolution graph — to learn metadata that is written
 * literally in the file. It would also make "what gets published" depend on what happened
 * to execute, which is exactly the property a publish must not have.
 *
 * The cost is that only STATIC definitions can be published, and that is stated as a
 * refusal rather than a silent omission: a tool built in a loop or spread from a shared
 * constant is a tool this manifest cannot describe, and quietly dropping it would publish
 * an inventory the site does not have.
 */

/**
 * The two catalog sources a plugin-published tool can be born with. The CLI stays
 * self-contained; these values must match the publisher API's source vocabulary.
 */
export type ManifestSource = "sdk_created" | "sdk_imported";

/**
 * The SDK's `source` → a catalog source code, applied
 * client-side so the published body says what it means.
 *
 * `scanner_generated` is the SDK's word for "codegen wrote this file", which through the
 * plugin means the `implement` skill authored it. Everything else — `merchant_authored`, an
 * absent value, a value a later SDK gains — lands on `sdk_imported`, which understates
 * provenance rather than inventing it. Byte-identical in behavior to the server's
 * `mapSdkSource`, and pinned to it.
 *
 * IDEMPOTENT, and that clause is load-bearing on BOTH sides. This runs client-side and the
 * endpoint runs its copy again on arrival, so without it the second application rewrites
 * `sdk_created` to `sdk_imported` and every tool the `implement` skill authored is recorded
 * as one the merchant already had. `tools.source` is immutable creation provenance — there
 * is no later write that corrects it.
 */
export function mapSdkSource(sdkSource: string | null | undefined): ManifestSource {
  if (sdkSource === "sdk_created" || sdkSource === "sdk_imported") return sdkSource;
  return sdkSource === "scanner_generated" ? "sdk_created" : "sdk_imported";
}

/**
 * The SDK's two identity patterns must match the publisher API. Checking them here
 * turns a whole publish's 422 into one named tool and one line.
 */
export const STABLE_KEY_PATTERN = "^[a-z0-9_]+(\\.[a-z0-9_]+)+$";
export const TOOL_NAME_PATTERN = "^[A-Za-z0-9_.-]{1,128}$";

/** One tool as its entry module declares it — the publishable subset, never its code. */
export type ManifestEntry = {
  stable_key: string;
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  source: ManifestSource;
};

export type Manifest = {
  /** Workspace-relative, POSIX-separated: what the run published, for the operator. */
  entry_module: string;
  entries: ManifestEntry[];
};

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function refuse(entryModule: string, subject: string, problem: string): never {
  throw new CliError(
    "dynamic_tool_definition",
    `${entryModule}: ${subject} ${problem}. webmcp publish reads defineTool calls from the source text and never runs the module, so every published field must be a literal.`,
  );
}

/**
 * A property's raw source text, keyed by name. Values are NOT evaluated here: a tool may
 * legitimately carry keys this manifest never publishes (`execute` above all, which is a
 * function by definition), and failing on those would refuse every real tool.
 *
 * `null` means the object itself cannot be read statically — a spread or a computed key,
 * either of which can contribute properties this scanner cannot see.
 */
function objectProperties(literal: string): Map<string, string> | null {
  const trimmed = literal.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  const body = trimmed.slice(1, -1);
  const properties = new Map<string, string>();
  for (const part of topLevelArguments(body)) {
    const text = part.trim();
    if (text === "") continue;
    if (text.startsWith("...") || text.startsWith("[")) return null;
    const mask = structuralMask(text);
    // A method or accessor (`execute(input: Cart): Promise<void> {}`) is recognized by its
    // parameter list, BEFORE any colon is looked for: a TypeScript return-type annotation
    // sits at depth 0 too, and reading it as the key/value separator turns the most ordinary
    // handler in the SDK into an unreadable object.
    const method = /^(?:async\s+)?\*?\s*(?:get\s+|set\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/.exec(
      mask,
    );
    const separator = method ? -1 : topLevelColon(mask);
    if (separator < 0) {
      // A method, or a shorthand (`{ description }`). Both are recorded as
      // present-but-unreadable, so a REQUIRED field lands on the refusal below rather than
      // on "missing" — which would be a different, wronger message.
      const name = method?.[1] ?? (IDENTIFIER.test(text) ? text : null);
      if (!name) return null;
      properties.set(name, "");
      continue;
    }
    const rawKey = text.slice(0, separator).trim();
    const quoted = literalValue(rawKey);
    const key = IDENTIFIER.test(rawKey) ? rawKey : typeof quoted === "string" ? quoted : null;
    if (key === null) return null;
    properties.set(key, text.slice(separator + 1));
  }
  return properties;
}

/**
 * The index of the `:` that separates a property's key from its value, or -1.
 *
 * Depth-aware, because a TypeScript entry module writes `execute(input: Cart) {}` and a
 * naive `indexOf(":")` finds the parameter's annotation — reading the key as `execute(input`
 * and refusing a tool that is perfectly static.
 */
function topLevelColon(mask: string): number {
  let depth = 0;
  for (let i = 0; i < mask.length; i += 1) {
    const char = mask[i] ?? "";
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") depth -= 1;
    else if (char === ":" && depth === 0) return i;
  }
  return -1;
}

const UNREADABLE = Symbol("unreadable");

/** A JS literal as its value, or {@link UNREADABLE} for anything that needs evaluation. */
function literalValue(text: string): unknown {
  const cursor = { text, index: 0 };
  const value = readValue(cursor);
  skipSpace(cursor);
  return cursor.index === text.length ? value : UNREADABLE;
}

type Cursor = { text: string; index: number };

function skipSpace(cursor: Cursor): void {
  while (cursor.index < cursor.text.length && /\s/.test(cursor.text[cursor.index] ?? "")) {
    cursor.index += 1;
  }
}

const ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  b: "\b",
  f: "\f",
  v: "\v",
  "0": "\0",
};

function readString(cursor: Cursor, quote: string): unknown {
  let value = "";
  cursor.index += 1;
  while (cursor.index < cursor.text.length) {
    const char = cursor.text[cursor.index] ?? "";
    if (char === quote) {
      cursor.index += 1;
      return value;
    }
    if (char === "\\") {
      const next = cursor.text[cursor.index + 1] ?? "";
      if (next === "u" || next === "x") {
        const width = next === "u" ? 4 : 2;
        const digits = cursor.text.slice(cursor.index + 2, cursor.index + 2 + width);
        if (!/^[0-9a-fA-F]+$/.test(digits) || digits.length !== width) return UNREADABLE;
        value += String.fromCharCode(Number.parseInt(digits, 16));
        cursor.index += 2 + width;
        continue;
      }
      value += ESCAPES[next] ?? next;
      cursor.index += 2;
      continue;
    }
    // A template that interpolates is a value only the runtime knows.
    if (quote === "`" && char === "$" && cursor.text[cursor.index + 1] === "{") return UNREADABLE;
    value += char;
    cursor.index += 1;
  }
  return UNREADABLE;
}

function readValue(cursor: Cursor): unknown {
  skipSpace(cursor);
  const char = cursor.text[cursor.index];
  if (char === undefined) return UNREADABLE;
  if (char === '"' || char === "'" || char === "`") return readString(cursor, char);
  if (char === "[") {
    cursor.index += 1;
    const items: unknown[] = [];
    for (;;) {
      skipSpace(cursor);
      if (cursor.text[cursor.index] === "]") {
        cursor.index += 1;
        return items;
      }
      if (cursor.index >= cursor.text.length) return UNREADABLE;
      const item = readValue(cursor);
      if (item === UNREADABLE) return UNREADABLE;
      items.push(item);
      skipSpace(cursor);
      if (cursor.text[cursor.index] === ",") cursor.index += 1;
      else if (cursor.text[cursor.index] !== "]") return UNREADABLE;
    }
  }
  if (char === "{") {
    cursor.index += 1;
    const object: Record<string, unknown> = {};
    for (;;) {
      skipSpace(cursor);
      if (cursor.text[cursor.index] === "}") {
        cursor.index += 1;
        return object;
      }
      if (cursor.index >= cursor.text.length) return UNREADABLE;
      const keyChar = cursor.text[cursor.index] ?? "";
      let key: string;
      if (keyChar === '"' || keyChar === "'" || keyChar === "`") {
        const read = readString(cursor, keyChar);
        if (typeof read !== "string") return UNREADABLE;
        key = read;
      } else {
        const identifier = IDENTIFIER.exec(cursor.text.slice(cursor.index).split(/[\s:]/)[0] ?? "");
        if (!identifier) return UNREADABLE;
        key = identifier[0];
        cursor.index += key.length;
      }
      skipSpace(cursor);
      if (cursor.text[cursor.index] !== ":") return UNREADABLE;
      cursor.index += 1;
      const value = readValue(cursor);
      if (value === UNREADABLE) return UNREADABLE;
      object[key] = value;
      skipSpace(cursor);
      if (cursor.text[cursor.index] === ",") cursor.index += 1;
      else if (cursor.text[cursor.index] !== "}") return UNREADABLE;
    }
  }
  const word = /^(?:true|false|null)\b/.exec(cursor.text.slice(cursor.index));
  if (word) {
    cursor.index += word[0].length;
    return word[0] === "true" ? true : word[0] === "false" ? false : null;
  }
  const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(cursor.text.slice(cursor.index));
  if (number) {
    cursor.index += number[0].length;
    return Number(number[0]);
  }
  return UNREADABLE;
}

function readField(
  entryModule: string,
  subject: string,
  properties: Map<string, string>,
  field: string,
): unknown {
  const raw = properties.get(field);
  if (raw === undefined) return undefined;
  const value = literalValue(raw);
  if (value === UNREADABLE) refuse(entryModule, `${subject}'s \`${field}\``, "is not a literal");
  return value;
}

/**
 * The index of the call's `(`, skipping a type argument list of ANY depth.
 *
 * `defineTool<Record<string, unknown>>(...)` is ordinary TypeScript, and the single-level
 * `<[^<>()]*>` this replaced could not match it — the tool vanished from the manifest with
 * no refusal. Null when the brackets never close: the same answer as a missing `(`.
 */
function callParenAfter(mask: string, from: number): number | null {
  let i = from;
  while (i < mask.length && /\s/.test(mask[i] ?? "")) i += 1;
  if (mask[i] === "<") {
    let depth = 0;
    for (; i < mask.length; i += 1) {
      const char = mask[i] ?? "";
      if (char === "<") depth += 1;
      else if (char === ">") {
        depth -= 1;
        if (depth === 0) {
          i += 1;
          break;
        }
      } else if (char === "(" || char === ")" || char === ";") return null;
    }
    if (depth !== 0) return null;
    while (i < mask.length && /\s/.test(mask[i] ?? "")) i += 1;
  }
  return mask[i] === "(" ? i : null;
}

/** Every `defineTool({...})` call in one entry module, as publishable metadata. */
export function parseManifest(entryModule: string, source: string): ManifestEntry[] {
  const code = withoutComments(source);
  const mask = structuralMask(code);
  // FAIL CLOSED first: a scan that ends inside a string lost sync, so what it read is a
  // PREFIX — published wholesale as the scope's complete statement, and indistinguishable
  // from a merchant who deleted the missing tools. Total loss already refuses.
  if (scanDesynchronized(code)) {
    refuse(
      entryModule,
      "the module",
      "could not be read to the end — an unterminated string or template leaves the rest of the file unreadable",
    );
  }
  // Bracket-matched rather than character-classed — see `callParenAfter`.
  const pattern = /\bdefineTool\s*(?=[<(])/g;
  const entries: ManifestEntry[] = [];
  const seen = new Set<string>();
  for (let match = pattern.exec(mask); match; match = pattern.exec(mask)) {
    if (mask.slice(0, match.index).trimEnd().endsWith(".")) continue;
    const start = callParenAfter(mask, match.index + match[0].length);
    if (start === null) break;
    const call = callAt(code, start);
    if (!call) break;
    pattern.lastIndex = call.end;
    const position = `defineTool call #${entries.length + 1}`;
    const args = topLevelArguments(call.body).filter((part) => part.trim() !== "");
    if (args.length !== 1) refuse(entryModule, position, "does not take a single object literal");
    const properties = objectProperties(args[0] as string);
    if (!properties) {
      refuse(entryModule, position, "is built from a spread, a computed key, or a variable");
    }

    const stableKey = readField(entryModule, position, properties, "stableKey");
    if (typeof stableKey !== "string") refuse(entryModule, position, "declares no static stableKey");
    const subject = `"${stableKey}"`;
    if (!new RegExp(STABLE_KEY_PATTERN).test(stableKey)) {
      refuse(entryModule, subject, 'is not a dot-namespaced "domain.action" stable key');
    }
    if (seen.has(stableKey)) refuse(entryModule, subject, "is declared twice in this module");
    seen.add(stableKey);

    const description = readField(entryModule, subject, properties, "description");
    if (typeof description !== "string" || description.trim() === "") {
      refuse(entryModule, subject, "declares no static, non-empty description");
    }
    const declaredName = readField(entryModule, subject, properties, "name");
    if (declaredName !== undefined && typeof declaredName !== "string") {
      refuse(entryModule, subject, "declares a non-string name");
    }
    // The SDK's own fallback: an omitted `name` is the stable key on the wire.
    const name = (declaredName as string | undefined) ?? stableKey;
    if (!new RegExp(TOOL_NAME_PATTERN).test(name)) {
      refuse(entryModule, subject, `resolves to the invalid wire name "${name}"`);
    }
    const inputSchema = readField(entryModule, subject, properties, "inputSchema");
    if (inputSchema !== undefined && !isPlainObject(inputSchema)) {
      refuse(entryModule, subject, "declares an inputSchema that is not a plain object");
    }
    const annotations = readField(entryModule, subject, properties, "annotations");
    if (annotations !== undefined && !isPlainObject(annotations)) {
      refuse(entryModule, subject, "declares annotations that are not a plain object");
    }
    const declaredSource = readField(entryModule, subject, properties, "source");
    if (declaredSource !== undefined && typeof declaredSource !== "string") {
      refuse(entryModule, subject, "declares a non-string source");
    }

    entries.push({
      stable_key: stableKey,
      name,
      description,
      // An omitted `inputSchema` is a tool that takes nothing, which is a contract, not a
      // gap — the empty schema says so where `null` would leave a reader guessing.
      input_schema: (inputSchema as Record<string, unknown> | undefined) ?? {},
      ...(annotations ? { annotations: annotations as Record<string, unknown> } : {}),
      source: mapSdkSource(declaredSource as string | undefined),
    });
  }
  return entries;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read one entry module and return what it declares. Never imports it. */
export async function extractManifest(
  entryModulePath: string,
  displayPath = entryModulePath,
): Promise<Manifest> {
  let source: string;
  try {
    source = await readFile(entryModulePath, "utf8");
  } catch {
    throw new CliError("entry_module_not_found", `Entry module not found: ${displayPath}`);
  }
  return { entry_module: displayPath, entries: parseManifest(displayPath, source) };
}
