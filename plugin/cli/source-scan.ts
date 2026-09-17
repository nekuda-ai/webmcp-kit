/**
 * Static source scanning shared by `status` (which counts `registerTools` batches) and
 * `manifest` (which reads `defineTool` calls).
 *
 * Both read a developer's entry module WITHOUT importing it. Importing would execute the
 * merchant's module in our process — arbitrary side effects, a bundler-specific resolution
 * graph, and framework globals that are not there — to learn metadata that is written
 * literally in the file. Everything here is therefore a hand-rolled scanner over text: the
 * only thing it has to get right is which characters are inside a string.
 */

/**
 * Regex-literal awareness for the quote machines below.
 *
 * A regex is the one construct that carries an unbalanced quote in ordinary code (`/["\']/`).
 * Without this a machine enters a string that never ends and every later declaration in the
 * file is invisible: total loss refuses (`no_tools_found`), partial loss would publish an
 * inventory the site does not have. `/` is division only when the previous significant token
 * could END a value; `}` reads as a block close, the cheaper mistake.
 */
const VALUE_KEYWORDS = new Set(
  "return typeof instanceof in of new delete void throw case do else yield await".split(" "),
);

function regexStartsAt(src: string, index: number): boolean {
  let i = index - 1;
  while (i >= 0 && /\s/.test(src[i] ?? "")) i -= 1;
  const prev = src[i] ?? "";
  if (i < 0) return true;
  if (prev === ")" || prev === "]") return false;
  if (!/[\w$]/.test(prev)) return true;
  let start = i;
  while (start >= 0 && /[\w$]/.test(src[start] ?? "")) start -= 1;
  return VALUE_KEYWORDS.has(src.slice(start + 1, i + 1));
}

/** Index past the regex literal opening at `index`, or `index` when it is not one. */
function skipRegex(src: string, index: number): number {
  let inClass = false;
  let escaped = false;
  for (let i = index + 1; i < src.length; i += 1) {
    const char = src[i] ?? "";
    if (escaped) escaped = false;
    else if (char === "\\") escaped = true;
    else if (char === "\n") return index;
    else if (char === "[") inClass = true;
    else if (char === "]") inClass = false;
    else if (char === "/" && !inClass) return i + 1;
  }
  return index;
}

/** How far a regex at `i` reaches, or 0 when `i` does not open one. */
function regexAt(src: string, i: number): number {
  if (src[i] !== "/" || !regexStartsAt(src, i)) return 0;
  const end = skipRegex(src, i);
  return end > i ? end : 0;
}

/**
 * Whether a quote-state scan ends INSIDE a string — proof the scanners lost sync and every
 * later declaration is unreadable. Callers refuse rather than publish the prefix they read.
 */
export function scanDesynchronized(source: string): boolean {
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i] ?? "";
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    const skip = regexAt(source, i);
    if (skip) i = skip - 1;
    else if (char === "'" || char === '"' || char === "`") quote = char;
  }
  return quote !== null;
}

/** Remove comments without damaging quoted strings; enough to keep examples from becoming facts. */
export function withoutComments(source: string): string {
  let output = "";
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i] ?? "";
    const next = source[i + 1] ?? "";
    if (quote) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    const skip = next === "/" || next === "*" ? 0 : regexAt(source, i);
    if (skip) {
      output += source.slice(i, skip);
      i = skip - 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      output += char;
      continue;
    }
    if (char === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      output += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 1;
      output += " ";
      continue;
    }
    output += char;
  }
  return output;
}

/** Keep structural punctuation and identifiers while hiding quoted example text. */
export function structuralMask(source: string): string {
  let output = "";
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i] ?? "";
    if (quote) {
      output += " ";
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
    } else if (regexAt(source, i)) {
      const end = regexAt(source, i);
      output += " ".repeat(end - i);
      i = end - 1;
    } else if (char === "'" || char === '"' || char === "`") {
      quote = char;
      output += " ";
    } else output += char;
  }
  return output;
}

/** The parenthesized body of the call whose `(` sits at `start`, and the index past its `)`. */
export function callAt(source: string, start: number): { body: string; end: number } | null {
  let parentheses = 0;
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const char = source[i] ?? "";
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    const skip = regexAt(source, i);
    if (skip) {
      i = skip - 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") quote = char;
    else if (char === "(") parentheses += 1;
    else if (char === ")" && --parentheses === 0) {
      return { body: source.slice(start + 1, i), end: i + 1 };
    }
  }
  return null;
}

/** Split a call body on its top-level commas, leaving nested calls/objects intact. */
export function topLevelArguments(body: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i] ?? "";
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    const skip = regexAt(body, i);
    if (skip) {
      i = skip - 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") quote = char;
    else if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") depth -= 1;
    else if (char === "," && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}
