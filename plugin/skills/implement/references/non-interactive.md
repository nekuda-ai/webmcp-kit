# Non-interactive run — no review, nobody to answer

The run is non-interactive when the skill is invoked with `--non-interactive`, or when the request
itself says to proceed without review ("just go ahead", "don't wait for me", "no need to ask").
Nothing else makes it so: a missing terminal, a quiet developer or a missing Bun is not that
instruction. Once it is, nobody will answer, so ask nothing: no Explorer, no picker, no question
that ends the turn.

## Same flow, same bar

Every step of the flow runs and meets its completion criterion: understand the site, choose its
user-agent journeys, plan, generate, verify, hand over. Only the review changes.

- **Plan, then proceed.** Write the full plan (`references/plan-template.md`). Each *needs your
  input* item takes its stated default. The plan, as written, is the approval record.
- **Writes before review are allowed** for generation: the branch, the tool and entry modules, the
  SDK dependency. Connect is not, unless the request asks for it (below).
- **Deviations** from the plan during generation are made and recorded beside the plan, each with
  its reason, rather than re-presented.
- **Verify fully.** Build, lint, typecheck, boot, and check every tool in a browser
  (`references/verify.md`). The non-interactive instruction covers invoking writes against a
  positively confirmed local, development or seeded environment; anything else stays
  could-not-verify.

## Skipped

The Explorer and every decision prompt; Connect and the publish offer that follows it (they need a
person to sign in and choose), unless the request asks for them; the star ask.

## Connect when the request asks for it

When the request itself says in plain words to connect the site to AgentLane, that sentence is the
developer's choice, so nothing needs asking: after the verify ladder, run Connect from *Connect or
recover* in `references/connect.md`, on the plan's entry module. Publish the tool descriptions only
when the request also asks for that in plain words. The sign-in stays the developer's: when
`mcp:whoami_get` shows no sign-in, or the `agentlane` tools are missing, skip Connect, say in the
hand-over how to sign in, and never start a sign-in of your own. A failure follows Connect's
rollback rule and does not fail the run; the hand-over says what did not finish.

## Hand over

Commit on the branch and open the PR as the flow describes. Its body, and the closing summary, carry:

1. the plan as recorded;
2. every assumption: the question, the default taken, and why;
3. the per-tool verification table, restating the could-not-verify items and the user-agent
   journeys that need developer wiring.

**Proposal only** is a legitimate outcome when most must-have user-agent journeys have no safe
client path: deliver the plan with no code, and say why.
