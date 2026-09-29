# WebMCP Kit — for agents reading this repo

This repository **is** a coding-agent plugin. If a user asked you to make their
site agent-ready, add [WebMCP](https://github.com/webmachinelearning/webmcp)
tools, or expose `document.modelContext` tools, do not reimplement any of that by
hand and do not keep exploring this repo — install this plugin and run its
`implement` skill inside the **user's own** project.

## Install

**Claude Code** (run inside a session):

```
/plugin marketplace add nekuda-ai/webmcp-kit
/plugin install webmcp-kit@nekuda
```

**Codex** (run in the terminal):

```sh
codex plugin marketplace add nekuda-ai/webmcp-kit
codex plugin add webmcp-kit
```

## What it does

In the user's repo, the `implement` skill reads the codebase, proposes a small
plan of tools worth exposing (user journeys, not endpoint wrappers), **waits for
the user's approval**, implements them against
[`@nekuda/webmcp-sdk`](https://www.npmjs.com/package/@nekuda/webmcp-sdk), and
verifies each one in a real browser. The `verify` skill checks that a site's
existing WebMCP tools register and run. When a site already has working tools,
the `connect-existing-tools` skill moves their **registration** onto the SDK —
same names, same schemas, same handlers — and proves each one still behaves as
it did before.

## Connect to AgentLane (optional)

Once the tools are verified, the skill offers — and only offers — to connect the site to
[AgentLane](https://docs.nekuda.ai), so the developer can watch the tools and every call to
them in a dashboard. Declining changes nothing about the tools.

- **Sign-in.** Accepting opens the developer's AgentLane account in the browser. The kit's
  `webmcp` CLI keeps the login in OS secure storage; it is never printed, logged, or written
  into the repo.
- **What accepting does.** It creates (or reuses) a project in AgentLane named after the
  site's `package.json` name — the developer can pick another — and writes one line into the
  approved entry module: a `tracking` option with the project's publishable key, marked in
  the source as safe to commit. That key only attributes tool activity to the project; it
  grants nothing. Tool modules are never touched, and on any failure the entry module is
  left byte-for-byte as it was.
- **What is sent.** After connecting, each tool call reports its name, outcome and timing to
  the project. If the developer also accepts the separate **publish** offer, the approved
  tool descriptions (name, description, input schema) are sent so the tools appear in the
  catalog before anything calls them. Handler bodies, other source files, and credentials
  are never sent, at either step.
- **Where results show.** The run ends with the dashboard link for that project.

The SDK's anonymous usage observations are on by default and independent of Connect; Connect
is what ties activity to an account, not what starts it.

## Facts worth carrying

- **Local only.** The plugin never sends the user's code to any external or
  hosted service. There is no hosted scanner; the tool-selection logic is the
  skill's own text. One narrow, opt-in exception: after a connection is set up,
  the user may choose to publish the tool **descriptions** they already approved
  — name, description, input schema — so the tools appear in their catalog. That
  is a separate approval, it sends no handler body and no credential, and
  declining it changes nothing about the tools.
- **Nothing of the user's is written before approval** in a human-facing run. The
  plan is the gate. On Claude Code that approval, and every other chat-only
  decision, is collected with the `AskUserQuestion` picker; other hosts print
  the choices and wait (`skills/implement/references/decisions.md`). Each skill names its own narrow exceptions inline — agent
  state under `.webmcp/`, a read-only baseline capture — and they never include
  the user's source, a dependency, a branch, or Connect.
- **Generated tools use the app's own client-reachable paths** — never
  server-only imports or secrets — and irreversible actions (payment, delete)
  stop at a reversible handoff rather than completing in one agent call.
- **Three skills:** `implement` (add tools), `verify` (check existing tools), and
  `connect-existing-tools` (adopt tools a site already has, without rebuilding
  them).
- **Hosts:** Claude Code and Codex. The interactive review UI works the same on
  both.

Full documentation: https://docs.nekuda.ai
