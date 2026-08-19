# WebMCP Kit

Make your web app agent-ready. WebMCP Kit is a coding-agent plugin that adds [WebMCP](https://github.com/webmachinelearning/webmcp) tools to your site, so browser agents act through your app's own logic instead of scraping the page.

It reads your repo, proposes a tool plan, **waits for your approval**, implements the tools with [`@nekuda/webmcp-sdk`](https://www.npmjs.com/package/@nekuda/webmcp-sdk), and verifies them in a real browser.

Works with **Claude Code** and **Codex**.

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
- A web app you can run locally — any stack, the plugin adapts
- [Bun](https://bun.sh) *(optional)* — powers the live review UI; without it you review the plan in chat
- Chrome 150+ with the WebMCP flag enabled (`chrome://flags`) — used to verify tools in a real browser

## Use

Open your app's repo in your agent and ask it to make the site agent-ready (in Claude Code: `/webmcp-kit:implement`). Then:

1. **Plan** — it maps your routes, forms, and data layer, and proposes a small set of tools.
2. **Approve** — nothing is written until you say yes.
3. **Implement** — typed tools wired to your app's own client logic.
4. **Verify** — every tool is checked in a real browser before the PR.

Already have WebMCP tools? The `verify` skill (`/webmcp-kit:verify`) checks they register and work.

## License

[MIT](LICENSE)
