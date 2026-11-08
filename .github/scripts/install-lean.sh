#!/usr/bin/env bash
# Installs a pinned, checksum-checked elan and the Lean toolchain named in spec/lean-toolchain.
# Each download is tried up to 5 times, so a short GitHub outage (a 504, for example) does not fail the job.
# To update elan: change ELAN_VERSION and ELAN_SHA256 (the release page lists each asset's sha256 digest).
set -euo pipefail

ELAN_VERSION=v4.2.4
ELAN_SHA256=42b94d4244e8353142c456ec0e4ca6528fd898a6c604d4059f494e706e431f63 # elan-x86_64-unknown-linux-gnu.tar.gz

if [ "$(uname -s)-$(uname -m)" != "Linux-x86_64" ]; then
  echo "install-lean.sh: only Linux x86_64 is pinned; got $(uname -s)-$(uname -m)" >&2
  exit 1
fi

retry() {
  local n=1
  until "$@"; do
    if [ "$n" -ge 5 ]; then echo "install-lean.sh: gave up after $n tries: $*" >&2; return 1; fi
    echo "install-lean.sh: try $n failed, retrying in $((n * 10))s: $*" >&2
    sleep $((n * 10))
    n=$((n + 1))
  done
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

retry curl -sSfL -o "$tmp/elan.tar.gz" \
  "https://github.com/leanprover/elan/releases/download/${ELAN_VERSION}/elan-x86_64-unknown-linux-gnu.tar.gz"
echo "${ELAN_SHA256}  $tmp/elan.tar.gz" | sha256sum -c -
tar xzf "$tmp/elan.tar.gz" -C "$tmp"
"$tmp/elan-init" -y --default-toolchain none

export PATH="$HOME/.elan/bin:$PATH"
if [ -n "${GITHUB_PATH:-}" ]; then echo "$HOME/.elan/bin" >> "$GITHUB_PATH"; fi

# A no-op when the toolchain came back from the cache.
retry elan toolchain install "$(cat spec/lean-toolchain)"
