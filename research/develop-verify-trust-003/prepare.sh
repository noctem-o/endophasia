#!/bin/sh
set -eu
umask 077
out=$1
mode=$2
h=research/develop-verify-trust-003
node research/develop-acceptance-001/prepare.ts "$out" "$mode"
case $mode in
  reference|pi)
    a=$out/agent
    cp "$h/observe.mjs" "$a/"
    printf '%s\n' 'Count strictly positive numbers. Zero does not count.' > "$a/rule.txt"
    readlink -n /proc/self/ns/net > "$a/host-netns.txt"
    if [ "$mode" = pi ]; then
      entry=launch.mjs
      printf '%s\n' 'Read /agent/rule.txt (read-only policy). Apply that rule to count.mjs using read and edit. Stop after the edit.' > "$a/prompt.txt"
    else
      entry=fixture.mjs
    fi
    mv "$a/$entry" "$a/original.mjs"
    printf '%s\n' 'import "./observe.mjs";' 'await import("./original.mjs");' > "$a/$entry"
    ;;
esac
