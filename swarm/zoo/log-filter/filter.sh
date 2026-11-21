#!/bin/sh
# Prints the log lines that need a person's attention. Reads the log on stdin.
PATTERN='ERROR'
FLAGS=''
grep $FLAGS -E "$PATTERN" || true
