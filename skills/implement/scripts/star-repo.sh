#!/bin/sh
# Star the WebMCP Kit repo through the user's own gh CLI.
#
#   star-repo.sh --eligible   exit 0 only when it is appropriate to ASK the
#                             user: gh installed, authenticated, and the repo
#                             not already starred. Prints nothing.
#   star-repo.sh              star the repo; one-line outcome on stdout.
#
# The flows call --eligible BEFORE ever mentioning stars, so a machine without
# gh (or an already-starred user) never sees the ask. The star itself runs only
# after the user's explicit yes — this script never decides to star.
set -u

REPO="nekuda-ai/webmcp-kit"

if [ "${1:-}" = "--eligible" ]; then
  command -v gh >/dev/null 2>&1 || exit 1
  gh auth status >/dev/null 2>&1 || exit 1
  # GET user/starred/<repo> answers 204 (exit 0) when already starred.
  if gh api "user/starred/$REPO" >/dev/null 2>&1; then exit 1; fi
  exit 0
fi

command -v gh >/dev/null 2>&1 || { echo "gh is not installed — star skipped."; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "gh is not authenticated — star skipped."; exit 1; }

if gh api "user/starred/$REPO" >/dev/null 2>&1; then
  echo "https://github.com/$REPO is already starred — thank you!"
  exit 0
fi

if gh api -X PUT "user/starred/$REPO" >/dev/null 2>&1; then
  echo "Starred https://github.com/$REPO — thank you!"
else
  echo "Could not star https://github.com/$REPO (token may lack the scope) — skipped."
  exit 1
fi
