# Decision prompts — how a chat-only run collects a developer decision

Every decision a skill puts to the developer in a human, chat-only run goes through this one
mechanism: the plan approval gate, the Connect offer, the publish offer, each *needs your input*
question in a plan, the Bun preflight, and the browser-loop offer. The calling reference names the
choices and the stated default; this file says how they are presented on the current host.

## Claude Code — the `AskUserQuestion` picker

Call the `AskUserQuestion` tool. Never print the choices as text and wait for a typed reply when
the tool is available.

- **Labels are the exact choice strings** the calling reference names — `Connect to AgentLane`,
  `Skip for now`, `Publish tool descriptions` — never a paraphrase. The e2e checks and the Explorer
  copy pin those strings, and the picker is the same decision in a different surface.
- **The stated default is the first option.** A plan's *needs your input* item lists its default
  first; the Connect and publish offers list the action first and `Skip for now` second.
- **The description carries the consequence**, one sentence, in the calling reference's own words
  (`Your built tools stay in this project.`; `Your code stays in this project.`).
- **Long content is printed first, the picker carries only the question.** The plan itself, the
  per-tool table, and the three publish disclosures go into the conversation as normal text; the
  question that follows is short.
- **One call, up to four questions.** The plan gate is one `AskUserQuestion` call: the approval
  question first (`Approve` / `Revise`, where `Revise` means *say what to change*), then every
  *needs your input* item from the plan, each with its stated default first. More than three such
  items means a second call after the first is answered.
- **`Other` is never approval.** Free text is an edit, a question, or a decline. Revise and
  re-present; proceed only on an explicit pick of the approving option.
- **One prompt per entry module** when a site has more than one — the question names the entry
  module it is about, and each answer is recorded against that module alone.

Wording inside labels and descriptions follows the developer-facing wording rule in
`references/connect.md`, and never echoes a CLI field, error code, or raw error prose.

## Codex, or any host without that tool — printed choices

Present the same explanation, then the choices as their exact labels, one per line, and end the
turn. The developer's reply is the decision. This is the current behavior, kept verbatim: the Codex
e2e preview reads the visible pane for `Connect to AgentLane` and `Skip for now` before it consents.

## When this file does not apply

- **Explorer loop active** — the Explorer owns the decision as a durable journal event
  (`references/interactive.md`). Do not also raise a picker for the same choice.
- **`--non-interactive`** — no prompt at all. Take the stated defaults and record each one in the
  report, per the calling skill's Degrade path.

## The answer is the decision record

The selected option, together with the exact entry-module path from the approved plan, is what the
calling reference means by *the developer's explicit choice*. Silence is not a choice; a picker that
is never answered stops the run exactly as an unanswered chat gate does.
