#!/bin/sh
# The guide keeps both sections and at least 40 words.
grep -q '^# Install' guide.md || { echo "missing section: Install"; exit 1; }
grep -q '^# Use' guide.md || { echo "missing section: Use"; exit 1; }
[ "$(wc -w < guide.md)" -ge 40 ] || { echo "the guide is too short"; exit 1; }
