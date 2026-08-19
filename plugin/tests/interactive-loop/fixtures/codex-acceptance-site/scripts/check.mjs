// Syntax gate: parse every shipped module without executing it. Runs under
// Bun — the plugin's own runtime, so it is always present wherever the
// fixture is exercised. A parse error exits nonzero.
const files = ["server.mjs", "public/app.js", "scripts/smoke.mjs", "scripts/check.mjs"];
const root = new URL("..", import.meta.url);
for (const file of files) {
  const source = await Bun.file(new URL(file, root)).text();
  new Bun.Transpiler({ loader: "js" }).transformSync(source);
}
console.log(`syntax ok (${files.length} files)`);
