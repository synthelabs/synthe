#!/usr/bin/env bash
# Stop hook: Claude can't finish while typecheck or tests are red.
# Runs only when code differs from origin/main (committed or not), so chat-only turns stay instant.
# Exit 2 blocks the stop and sends the failure back to Claude to fix.
set -u
cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}" || exit 0

base=$(git merge-base HEAD origin/main 2>/dev/null || echo "")
code="src test templates scripts package.json tsconfig.json"
if [ -n "$base" ] && git diff --quiet "$base" -- $code && [ -z "$(git ls-files --others --exclude-standard -- $code)" ]; then
  exit 0
fi

# test/e2e.test.ts rebuilds dist/; put it back unless dist/ already had changes of its own.
dist_clean=0
git diff --quiet -- dist && dist_clean=1

out=$(npm run -s typecheck 2>&1) || { echo "Typecheck failed. Fix it before finishing:" >&2; echo "$out" | tail -40 >&2; exit 2; }
out=$(npm test 2>&1); status=$?
[ "$dist_clean" = 1 ] && git checkout -q -- dist
if [ $status -ne 0 ]; then
  echo "Tests failed. Fix them before finishing:" >&2
  echo "$out" | grep -E "^(✖|not ok|ℹ (tests|pass|fail))|AssertionError|Error:" | head -40 >&2
  exit 2
fi
exit 0
