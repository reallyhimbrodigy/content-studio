#!/usr/bin/env bash
# GATE INTEGRITY — the gate that checks the gates can actually fail.
#
# WHY THIS EXISTS (2026-09-07). upload-retry-gate ran its source-guard
# assertions inside a `python3 - <<'PYEOF'` heredoc whose exit code was
# discarded. `sys.exit(1)` printed "upload-retry-gate: FAIL" and the script
# carried on to its own `exit 0`. Every assertion in that block was advisory
# from the day it was written — it could fail loudly and still pass, including
# the assertions added for the UNS work. It was found by RED-proving four NEW
# assertions and noticing all four stayed green when they should have failed.
#
# A gate that can print FAIL and exit 0 is not a gate. This makes that shape
# impossible to reintroduce, for every gate, in the only way that proves
# anything: by forcing each embedded block to fail and requiring the gate to
# exit non-zero.
#
# The injection goes at the TOP of the block, so the gate's real work never
# runs — this tests the plumbing, not the assertions, and stays fast.
set -uo pipefail
cd "$(dirname "$0")"

FAIL=0
TESTED=0

for g in *.sh; do
  case "$g" in gate-integrity-gate.sh|__sweep_*) continue;; esac
  # Every embedded interpreter heredoc in this gate: `python3 - ... <<'DELIM'`
  while IFS=: read -r lineno opener; do
    [ -n "${lineno:-}" ] || continue
    delim=$(printf '%s' "$opener" | sed -E "s/.*<<[[:space:]]*'?([A-Za-z_]+)'?.*/\1/")
    interp=$(printf '%s' "$opener" | grep -oE '^(python3|node)')
    [ -n "$delim" ] && [ -n "$interp" ] || continue
    case "$interp" in
      python3) inject='import sys; sys.exit(1)';;
      node)    inject='process.exit(1)';;
    esac
    tmp="__gateint_${g%.sh}_${delim}_${lineno}.sh"
    awk -v n="$lineno" -v ins="$inject" 'NR==n{print; print ins; next} {print}' "$g" > "$tmp"
    chmod +x "$tmp"
    bash "$tmp" >/dev/null 2>&1
    rc=$?
    rm -f "$tmp"
    TESTED=$((TESTED+1))
    if [ "$rc" -eq 0 ]; then
      echo "  ✗ $g: the '$delim' block at line $lineno can fail while the gate exits 0"
      echo "    Its assertions are advisory. Capture the heredoc's exit code:"
      echo "      PY_RC=\$?;  [ \"\$PY_RC\" -ne 0 ] && exit 1"
      FAIL=1
    fi
  done < <(grep -nE "^(python3|node)\b[^<]*<<[[:space:]]*'?[A-Za-z_]+'?" "$g" || true)
done

# Every gate must have SOME reachable non-zero exit. A gate with none is the
# same defect wearing different clothes.
for g in *.sh; do
  case "$g" in gate-integrity-gate.sh|__sweep_*) continue;; esac
  body=$(cat "$g")
  # `exit 1` is frequently mid-line — `if [ "$FAIL" -ne 0 ]; then echo ...; exit 1; fi`
  # is the house style, and anchoring to a whole line reported five healthy
  # gates as broken. Match it as a command wherever it sits.
  if ! grep -qE '(^|[;&|[:space:]])exit +1([;[:space:]]|$)' <<< "$body" \
     && ! grep -qE '(^|[;&|[:space:]])exit +\$\{?[A-Za-z_][A-Za-z0-9_]*\}?([;[:space:]]|$)' <<< "$body" \
     && ! grep -qE 'sys\.exit\(1\)|process\.exit\(1\)' <<< "$body"; then
    echo "  ✗ $g: no reachable non-zero exit — this gate cannot fail at all"
    FAIL=1
  fi
done

if [ "$FAIL" -ne 0 ]; then
  echo "gate-integrity-gate: FAIL"
  exit 1
fi
echo "gate-integrity-gate: PASS — $TESTED embedded block(s) proven to bind; every gate can fail."
exit 0
