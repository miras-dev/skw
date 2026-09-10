#!/usr/bin/env bash
# Regenerate roster-scoring.gs from the shared scoring modules in clash-companion.
# Run this whenever the upstream scoring changes. The three files are copied
# BYTE-FOR-BYTE (concatenated in dependency order) — never edited here.
set -euo pipefail
SRC="${1:-$HOME/Desktop/Azolute/clash-companion}"
OUT="$(dirname "$0")/roster-scoring.gs"
HASH="$(git -C "$SRC" rev-parse --short HEAD 2>/dev/null || echo unknown)"
DATE="$(date -u +%Y-%m-%dT%H:%MZ)"
{
  echo "/* roster-scoring.gs — VENDORED, do not edit."
  echo " *"
  echo " * Byte-identical copy of the shared CWL scoring, concatenated in dependency"
  echo " * order so each module finds its dependency on globalThis (Apps Script has no"
  echo " * require()). Source: clash-companion js/ at commit ${HASH}, bundled ${DATE}."
  echo " *"
  echo " * To refresh:  ./make-scoring-bundle.sh  [path-to-clash-companion]"
  echo " * Provides on globalThis:  LeagueTiers, BattleLog, Eligibility"
  echo " */"
  echo
  echo "/* ===== js/leaguetiers.js @ ${HASH} ===== */"
  cat "$SRC/js/leaguetiers.js"
  echo
  echo "/* ===== js/battlelog.js @ ${HASH} ===== */"
  cat "$SRC/js/battlelog.js"
  echo
  echo "/* ===== js/eligibility.js @ ${HASH} ===== */"
  cat "$SRC/js/eligibility.js"
} > "$OUT"
echo "wrote $OUT ($(wc -l < "$OUT") lines, source @ ${HASH})"
