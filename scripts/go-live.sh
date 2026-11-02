#!/usr/bin/env bash
# First live round. Run from this repo after creating the public action repo named by ACTION in
# src/cli/init.ts, a public support-bot repo in the same org, and its SYNTHE_ANTHROPIC_KEY secret.
# Spends real money, up to the demo's $3 budget.
set -euo pipefail

cd "$(dirname "$0")/.."
ACTION=$(sed -n 's/^export const ACTION = "\(.*\)@v0";$/\1/p' src/cli/init.ts)
[ -n "$ACTION" ] || { echo "Could not read ACTION from src/cli/init.ts."; exit 1; }
ORG=${ACTION%%/*}

gh repo view "$ACTION" >/dev/null || { echo "Create the public repo $ACTION first."; exit 1; }
gh repo view "$ORG/support-bot" >/dev/null || { echo "Create the public repo $ORG/support-bot first."; exit 1; }
gh secret list --repo "$ORG/support-bot" | grep -q SYNTHE_ANTHROPIC_KEY || { echo "Add SYNTHE_ANTHROPIC_KEY to $ORG/support-bot first."; exit 1; }

npm ci
npm run build
npm test

git add .gitignore README.md action.yml package.json package-lock.json tsconfig.json dist examples kit scripts src templates test
git commit -m "First version of Synthe" || true
git remote add origin "https://github.com/$ACTION.git" 2>/dev/null || true
git push -u origin main
git tag -f v0
git push -f origin v0

DEMO=$(mktemp -d)
cp -R examples/support-bot/. "$DEMO"
mkdir -p "$DEMO/.github/workflows"
sed "s#__ACTION__#$ACTION@v0#g" templates/synthe.yml > "$DEMO/.github/workflows/synthe.yml"
(
  cd "$DEMO"
  git init -q -b main
  git add prompt.md synthe.json .synthe/scenarios.jsonl .github/workflows/synthe.yml
  git commit -qm "Support bot with a weak prompt"
  git remote add origin "https://github.com/$ORG/support-bot.git"
  git push -u origin main
)

gh api -X PUT "repos/$ORG/support-bot/actions/permissions/workflow" \
  -f default_workflow_permissions=read -F can_approve_pull_request_reviews=true \
  || echo "Turn on 'Allow GitHub Actions to create and approve pull requests' in the repo's Actions settings."

sleep 5
gh workflow run synthe.yml --repo "$ORG/support-bot"
echo "Running: https://github.com/$ORG/support-bot/actions"
