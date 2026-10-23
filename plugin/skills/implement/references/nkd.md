# nkd — the AgentLane command line

Use `nkd` to read or change the developer's AgentLane account from the terminal: who is logged
in, their Projects, tools, scans and agent activity. Each command is one AgentLane API operation.
Connect and publish run through the AgentLane MCP server's tools (`connect.md`), and the
browser driver through this kit's `webmcp browser` entry (`verify.md`); `nkd` replaces neither.

## Install

`nkd --version` prints `nkd <version> (API <date>)` when it is installed. When it is not, ask the
developer before you install anything globally, then run `npm i -g @nekuda/cli@0.1.0`. For one call
without an install, use `npx @nekuda/cli@0.1.0 <command>`. The npm package is `@nekuda/cli` and the
command is `nkd`. Do not run `npx nkd`: that is a different package. It needs Node.js 22.12 or
later.

## Log in

Run `nkd whoami --json` first. It names the organization, the credential kind (`oauth` for a
login, `api_key` for `NKD_API_KEY`) and the granted scopes. Exit 3 means not logged in.

- **A person at the machine:** run `nkd login`. It opens the dashboard in the browser, where the
  developer picks the areas nkd may use and approves; the login stays in the OS keychain.
  `nkd login --force` asks for consent again, for example to grant another area. `nkd logout`
  forgets the login.
- **CI, scripts, a non-interactive run:** the developer sets `NKD_API_KEY` to an API key they made
  in the dashboard. It wins over a stored login. Never ask for the key in the conversation, and
  never write it into a command, a file or a log; the developer exports it. nkd never creates or
  shows an API key.

With no credential in a non-interactive run, do not log in: report that the account could not be
checked.

## Find a command

Never guess a command name. Search, then read its help:

```sh
nkd search which tools are failing
nkd --help
nkd projects --help
nkd projects delete --help
nkd commands --json
```

`nkd search <words>` prints the best matching commands with one line each. `nkd --help` lists
the commands in 7 sections, one per area: Projects, Publishable keys, Tools, Scans, Agent
activity, Evals and Support; a last section, Account and local, holds `whoami`, `login`,
`logout`, `search`, `commands`, `completion` and `help`. `nkd <group> --help` shows a group's
commands and their flags. A command's own help ends with its **Effect** (`read`, `write`,
`destructive` or `irreversible`), the **Permission** it needs and the **API** route it calls.
`nkd commands --json` lists every command as data.

## Output and exit codes

Always pass `--json`. The data goes to stdout. An error is one JSON object on stderr, such as
`{"error":{"code":"not_found","message":"...","hint":"..."}}`; its `hint` names the next step.

| Exit | Meaning | Next step |
|---|---|---|
| 0 | OK | Read stdout |
| 1 | The API refused | Read `error.code`; fix the input or the permission |
| 2 | Usage error, or a refused confirmation | Read `nkd <group> <verb> --help`; see Confirmations |
| 3 | Not logged in | See Log in |

## Confirmations

A destructive or irreversible command asks first. With no terminal it refuses with exit 2
(`confirmation_required`). Add `--yes` only after the developer approved that exact command, for
example `nkd projects delete <project-id> --yes --json`.

## Retry a write safely

nkd sends an idempotency key with every create and update. When one fails on the network, the
error's `hint` names that key: run the same command again with `--idempotency-key <key>`, for
example `nkd projects create --site-url <url> --idempotency-key <key> --json`, and the API runs it
at most once. After an HTTP 500 the write may have run: read first
(`nkd projects get <project-id> --json`) and retry only if it did not. A delete has no key, so
read before you run one again.

## Check the setup

Each step needs the one before it; the first step that fails is the one to fix.

1. `nkd --version` prints the version (see Install).
2. `nkd login`, or `NKD_API_KEY` is set.
3. `nkd whoami --json` exits 0 and names the organization.
4. `nkd projects list --json` gives each Project's id.
5. `nkd calls errors --project <project-id> --json` shows which tools failed for agents in the
   last 7 days.

Tell the developer the result in this skill's own words. Never show a credential, and never
echo a raw error code or message to them.
