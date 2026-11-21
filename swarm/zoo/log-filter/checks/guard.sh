#!/bin/sh
# Guard: on a second log, filter.sh prints exactly the two error lines.
cd "$(dirname "$0")/.." || exit 1
got=$(sh filter.sh < checks/sample.log)
want=$(grep ERROR checks/sample.log)
if [ "$got" != "$want" ]; then
  echo "filter.sh printed the wrong lines for checks/sample.log"
  exit 1
fi
echo "filter guard passed"
