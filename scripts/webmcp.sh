#!/usr/bin/env sh

if ! command -v bun >/dev/null 2>&1; then
  echo "webmcp: Bun is required. Install Bun, then retry." >&2
  exit 127
fi

plugin_root=${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-}}
if [ -z "${plugin_root}" ]; then
  plugin_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
fi

exec bun "${plugin_root}/cli/webmcp.ts" "$@"
