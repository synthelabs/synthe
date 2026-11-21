#!/bin/sh
# Scores filter.sh on measure/app.log: the wanted lines it prints, minus the lines it prints that are not wanted.
cd "$(dirname "$0")/.." || exit 1
out=$(mktemp)
sh filter.sh < measure/app.log > "$out"
total=$(wc -l < "$out" | tr -d ' ')
hits=$(grep -Fxc -f measure/expected.txt "$out")
rm -f "$out"
echo "score: $((hits - (total - hits)))"
