# WebMCP Kit

Make your website or web app agent-ready. WebMCP Kit is a coding-agent plugin that adds [WebMCP](https://github.com/webmachinelearning/webmcp) tools to your site or application, so browser agents can act through your app's own logic instead of scraping the page.

It reads your repo, proposes a tool plan, **waits for your approval**, implements the tools with [`@nekuda/webmcp-sdk`](https://www.npmjs.com/package/@nekuda/webmcp-sdk), and verifies them in a real browser. Everything runs locally — **your code never leaves your machine**; there is no hosted scanner.

Works with **Claude Code**, **Codex**, and **Cursor**.

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

**Cursor**

```sh
npx skills add nekuda-ai/webmcp-kit --skill '*' --agent cursor
```

This installs all three Agent Skills for Cursor: `implement`, `verify`, and `connect-existing-tools`.

## Prerequisites

- [Claude Code](https://claude.com/claude-code), [Codex](https://developers.openai.com/codex), or [Cursor](https://cursor.com/)
- A website or web app you can run locally — any stack, the plugin adapts
- [Bun](https://bun.sh) *(optional)* — powers the live review UI; without it you review the plan in chat
- Chrome 150+ with the WebMCP flag enabled (`chrome://flags`) — used to verify tools in a real browser

## Use

Open your repo in your agent and ask it to make your website or web app agent-ready (Claude Code: `/webmcp-kit:implement`; Cursor: `/implement`). Then:

1. **Plan** — it maps your routes, forms, and data layer, and proposes a small set of tools.
2. **Approve** — nothing is written until you say yes.
3. **Implement** — typed tools wired to your app's own client logic.
4. **Verify** — each tool is checked in a real browser and reported as **verified**, **failed**, or **could-not-verify**. Failed never ships.

Already have WebMCP tools? The `verify` skill (`/webmcp-kit:verify`) checks they register and work.

## Reviewing the plan

Instead of reading the plan in chat, the plugin can open a local review page: the proposed tools laid out by page, each with the reasoning behind it. Comment on individual tools, pick which ones to build, and approve when you are happy. Nothing is written until you do.

The page opens the same way on every host. What differs is how your decision gets back to the agent:

- **Claude Code** wakes the agent through a background monitor.
- **Codex** uses the plugin's bundled `PreToolUse`/`Stop` lifecycle hooks, registered at install. They only carry your review actions back to the agent; inspect them anytime with `/hooks`.
- **Cursor** has neither, so after you approve, tell the agent to continue and it picks up your decision.

Prefer chat? Review there instead and skip the browser entirely.

## Package for the OpenAI Platform

Build the skills-only ZIP accepted by the OpenAI Platform plugin uploader:

```sh
python3 scripts/package-openai-skills.py
```

The archive is written to `dist/webmcp-kit-<version>.zip`. It includes the Codex manifest, brand assets, and all three skills, and leaves out repository files and the lifecycle hooks used by the full marketplace install.

## License

[MIT](LICENSE)
