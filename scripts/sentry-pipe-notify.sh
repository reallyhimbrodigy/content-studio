#!/bin/bash
# Pager wrapper around sentry-pipe-health.js. Speaks only on a STATE CHANGE.
#
# Crash reporting was dark for thirteen days and nothing said so. The check
# existed before this wrapper; what was missing was anything that would carry
# its verdict to a human without being asked. A check nobody reads is not a
# check.
#
# Deliberately quiet: it does NOT notify while the pipe is dark (a known,
# already-reported state — repeating it every 30 minutes is how alerts get
# muted, and a muted alert is worse than none). It notifies on the transition
# back to healthy, and on an unreadable check, because "cannot verify" must
# never be mistaken for "fine".
set -uo pipefail

REPO="/Users/zaclibman/content-studio"
STATE_FILE="/tmp/.sentry-pipe-state"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

cd "$REPO" || exit 0
OUT="$(node scripts/sentry-pipe-health.js 2>&1)"
CODE=$?
HOURS="$(printf '%s' "$OUT" | sed -n 's/.*last ACCEPTED an event: \([0-9.]*\).*/\1/p' | head -1)"

case "$CODE" in
  0) STATE="ALIVE" ;;
  1) STATE="DARK" ;;
  *) STATE="UNREADABLE" ;;
esac

PREV="$(cat "$STATE_FILE" 2>/dev/null || echo "")"
printf '%s' "$STATE" > "$STATE_FILE"
printf '[%s] state=%s prev=%s hours_dark=%s\n' "$(date -u +%FT%TZ)" "$STATE" "${PREV:-none}" "${HOURS:-?}"

notify() {
  osascript -e "display notification \"$1\" with title \"Promptly — Sentry\" sound name \"Glass\"" >/dev/null 2>&1
}

[ "$STATE" = "$PREV" ] && exit 0

case "$STATE" in
  ALIVE)
    notify "Sentry ingestion RESUMED — crash signatures readable again. Re-run the signature pull for builds 229+."
    printf '%s\n' "$OUT"
    ;;
  UNREADABLE)
    notify "Sentry pipe check could NOT read (exit $CODE). Unverified — not healthy."
    printf '%s\n' "$OUT"
    ;;
  DARK)
    # Only announce entering the dark state, never repeat it.
    if [ -n "$PREV" ] && [ "$PREV" != "DARK" ]; then
      notify "Sentry ingestion has STOPPED — no accepted events for ${HOURS:-?}h while the app is live."
      printf '%s\n' "$OUT"
    fi
    ;;
esac
exit 0
