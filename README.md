# WebMCP Kit

Make your website or web app agent-ready. WebMCP Kit is a coding-agent plugin that adds [WebMCP](https://github.com/webmachinelearning/webmcp) tools to your site or application, so browser agents can act through your app's own logic instead of scraping the page.

It reads your repo, proposes a tool plan, **waits for your approval**, implements the tools with [`@nekuda/webmcp-sdk`](https://www.npmjs.com/package/@nekuda/webmcp-sdk), and verifies them in a real browser. Everything runs locally — **your code never leaves your machine**; there is no hosted scanner.

Works with **Claude Code** and **Codex**.

📖 Full documentation: **[docs.nekuda.ai](https://docs.nekuda.ai)**

## Install

**Claude Code**

```
/plugin marketplace add nekuda-ai/webmcp-kit
/plugin install webmcp-kit@nekuda
```

**Codex**

```sh
codex plugin marketplace add nekuda-ai/webmcp-kit
codex plugin add webmcp-kit
```

Or run `/plugins` inside Codex and install it from the browser there.

## Prerequisites

- [Claude Code](https://claude.com/claude-code) or [Codex](https://developers.openai.com/codex)
- A website or web app you can run locally — any stack, the plugin adapts
- [Bun](https://bun.sh) *(optional)* — powers the live review UI; without it you review the plan in chat
- Chrome 150+ with the WebMCP flag enabled (`chrome://flags`) — used to verify tools in a real browser

## Use

Open your repo in your agent and ask it to make your website or web app agent-ready (in Claude Code: `/webmcp-kit:implement`). Then:

1. **Plan** — it maps your routes, forms, and data layer, and proposes a small set of tools.
2. **Approve** — nothing is written until you say yes.
3. **Implement** — typed tools wired to your app's own client logic.
4. **Verify** — each tool is checked in a real browser and reported as **verified**, **failed**, or **could-not-verify**. Failed never ships.

Already have WebMCP tools? The `verify` skill (`/webmcp-kit:verify` in Claude Code) checks they register and work.

## Reviewing the plan

Instead of reading a plan in chat, the plugin can open a local review page: your
proposed tools laid out by page, each with the reasoning behind it. Comment on
individual tools, pick which ones to build, and approve when you are happy.
Nothing is written until you do.

This works the same on both hosts. Each one has its own way for the browser to
hand your decision back to the agent — on Codex that is the plugin's bundled
`PreToolUse`/`Stop` lifecycle hooks, registered when you install and inspectable
anytime with `/hooks`; they only carry your review actions back to the agent.
Prefer chat? Review there instead and skip the browser entirely.

## Package for the OpenAI Platform

Build the skills-only ZIP accepted by the OpenAI Platform plugin uploader:

```sh
python3 scripts/package-openai-skills.py
```

The archive is written to `dist/webmcp-kit-<version>.zip`. It includes the Codex manifest, brand assets, and both skills, and leaves out repository files and the lifecycle hooks used by the full marketplace install.

## License

[MIT](LICENSE)
