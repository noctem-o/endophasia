#!/bin/sh
# Independent oracle for T1, written by hand from standard subtractive Roman numerals before any candidate was examined.
# Usage: oracles/roman.sh <repo>   Prints one line per case and "ORACLE PASS" or "ORACLE FAIL".
cd "$1" || exit 99
fail=0
ok() { out=$(node roman.mjs "$1" 2>/dev/null); code=$?; [ "$out" = "$2" ] && [ $code -eq 0 ] && echo "ok   $1 -> $out" || { echo "FAIL $1 -> '$out' exit $code (want '$2' exit 0)"; fail=1; }; }
no() { out=$(node roman.mjs "$1" 2>/dev/null); code=$?; [ -z "$out" ] && [ $code -eq 2 ] && echo "ok   '$1' refused" || { echo "FAIL '$1' -> '$out' exit $code (want nothing, exit 2)"; fail=1; }; }
ok 1 I; ok 4 IV; ok 9 IX; ok 14 XIV; ok 40 XL; ok 90 XC; ok 400 CD; ok 1994 MCMXCIV; ok 2026 MMXXVI; ok 3999 MMMCMXCIX
no 0; no 4000; no abc; no -5
[ $fail -eq 0 ] && echo "ORACLE PASS" || echo "ORACLE FAIL"
