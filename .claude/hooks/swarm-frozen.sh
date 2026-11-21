#!/usr/bin/env bash
# PreToolUse hook: a swarm agent (a session that ran `ledger.mjs whoami <id>`) cannot edit a frozen path.
# The merge job refuses such a pull request anyway; this hook stops the edit early and says why.
set -u
cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}" || exit 0
[ -f "$(git rev-parse --git-common-dir 2>/dev/null)/swarm-agent" ] || exit 0
path=$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const i=JSON.parse(s).tool_input||{};process.stdout.write(i.file_path||i.notebook_path||"")}catch{}})')
[ -n "$path" ] || exit 0
rel=$(realpath -m --relative-to="$PWD" "$path")
if printf '%s\n' "$rel" | grep -qE '^(swarm/|test/milestones/|\.github/|\.claude/|scripts/swarm/|scripts/score/|dist/|AGENTS\.md$|CLAUDE\.md$)'; then
  echo "Refused: $rel is frozen for swarm agents (see swarm/GOAL.md). If a check is wrong, post a ledger note with --kind check-bug." >&2
  exit 2
fi
exit 0
