---
description: Star the WebMCP Kit repo on GitHub with your gh CLI
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/skills/implement/scripts/star-repo.sh:*)
---

The user invoked this command, which is their consent to star the repo. Run:

```
${CLAUDE_PLUGIN_ROOT}/skills/implement/scripts/star-repo.sh
```

Relay the script's one-line outcome verbatim. If it reports gh missing or
unauthenticated, tell the user they can star manually at
https://github.com/nekuda-ai/webmcp-kit. Do not retry, and do not attempt any
other way of starring.
