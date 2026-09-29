# WebMCP Kit

WebMCP Kit makes a website or web app agent-ready. It adds
[WebMCP](https://github.com/webmachinelearning/webmcp) tools, which browser agents can call
instead of clicking through the page. It works inside your own project: it reads the repo,
proposes a small plan of tools, **waits for your approval**, implements them with
[`@nekuda/webmcp-sdk`](https://www.npmjs.com/package/@nekuda/webmcp-sdk), and checks each one
in a real browser.

## Skills

- **implement** adds WebMCP tools to your app, from the plan through to a verified pull request.
- **verify** checks that a site's existing WebMCP tools register and run in a browser.
- **connect-existing-tools** moves tools your site already has onto the SDK without changing
  their names, schemas or handlers, and then shows that each one still behaves as before.
- **/star** prints the link to the GitHub repo in case you want to star it.

## What it runs on your machine

- **The `webmcp` CLI**: readable TypeScript in `cli/`, run by [Bun](https://bun.sh). It has
  no dependencies and imports nothing from outside the plugin.
- **A browser for verification**: `npm exec` runs the pinned `chrome-devtools-mcp@1.10.1`
  against an isolated, headless Chrome 150+, with usage statistics and CrUX turned off and
  network headers redacted. If there is no supported Chrome, it downloads Chrome for Testing
  once into your user cache using the pinned `@puppeteer/browsers@3.2.3`. These child
  processes get only the environment they need to run and reach the network (`PATH`, `HOME`,
  proxy and certificate settings, and similar). Your tokens and API keys are never passed to
  them.
- **The Explorer**: an optional review page served from `127.0.0.1` on a random port while a
  run is active. It uses a random per-run value to recognise its own browser tab. That value is
  not a credential and never leaves your machine. The page loads one library, `driver.js@1.8.0`,
  from jsDelivr, pinned by version and integrity hash.
- **Your package manager**: after you approve the plan, it adds `@nekuda/webmcp-sdk` to your
  project.
- **Codex only**: a lifecycle hook that passes Explorer feedback back into the session. It only
  talks to the local Explorer.

## What it sends, and where

- **Your code stays local.** No part of your source is uploaded or scanned by a hosted
  service.
- **The SDK's anonymous telemetry.** Once the SDK is installed, your site sends anonymous usage
  telemetry by default: SDK version, tool names and outcomes, never inputs, results or URLs.
  This happens whether or not you connect. The SDK README explains exactly what is sent and how
  to turn it off.
- **Connect to AgentLane (optional).** Once your tools are verified, the kit offers to connect
  the site to [AgentLane](https://docs.nekuda.ai), nekuda's dashboard for tool activity. If you
  accept, you sign in with OAuth in your browser. The resulting login is kept in your operating
  system's secure storage and sent only to `api.agentlane.com`, to create or reuse a project
  and its publishable key. The kit then writes that key, which grants nothing, into one
  entry module. Connecting ties the SDK's activity to your account; it is not what starts
  network activity. If you skip it, nothing changes.
- **Publish (optional, asked separately).** This sends the tool descriptions you approved
  (name, description and input schema) so the tools appear in your AgentLane catalog. Handler
  code and credentials are never sent.
- **GitHub.** The kit never uses your GitHub credentials and never stars anything for you. It
  only shows you the repo link.

## Install

- **Claude Code:** `/plugin marketplace add nekuda-ai/webmcp-kit`, then
  `/plugin install webmcp-kit@nekuda`.
- **Codex:** `codex plugin marketplace add nekuda-ai/webmcp-kit`, then
  `codex plugin add webmcp-kit`.

## License

MIT. Source: <https://github.com/nekuda-ai/webmcp-kit>.
