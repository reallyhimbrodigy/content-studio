#!/bin/bash
# composer-wait-note-gate.sh — the line under the composer, in all twelve.
#
# It promises a notification ("we'll let you know when it's ready") to EVERY
# user, unconditionally. That is only honest because of the soft-prompt fix: a
# "Not now" now sets a RETRY DATE rather than a permanent flag, and the re-ask
# fires after a successful export. Before that, this line would have promised a
# notification to the 1,056 users who could never be asked again.
#
# So this gate ties the two together: if the soft-prompt fix is ever reverted,
# the line becomes a lie and this fails.
set -u
cd "$(dirname "$0")"
fail=0
say() { printf '  %s %s\n' "$1" "$2"; }
KEY="Bigger edits take a little longer"

# 1. It is rendered, under the composer, and identifiable.
if sed -e 's://.*::' Promptly/Views/EditorView.swift | grep -q 'composer.renderWaitNote'; then
  say "✓" "the note is rendered and carries an identifier"
else
  say "✗" "composer.renderWaitNote is gone"; fail=1
fi
if sed -e 's://.*::' Promptly/Views/EditorView.swift | grep -q "String(localized: \"$KEY"; then
  say "✓" "it goes through String(localized:) — not a bare literal"
else
  say "✗" "the copy is not localised at the call site"; fail=1
fi

# 2. All twelve locales, all actually translated.
python3 - <<'PY' || fail=1
import json, sys
K = "Bigger edits take a little longer — you can close the app and we'll let you know when it's ready."
WANT = {'ar','bn','de','en','es','fr','hi','id','ja','ne','pt-BR','ur'}
d = json.load(open('Promptly/Localizable.xcstrings'))
e = d['strings'].get(K)
if not e:
    print("  \u2717 the string is not in the catalog at all"); sys.exit(1)
L = e.get('localizations') or {}
missing = sorted(WANT - set(L))
if missing:
    print(f"  \u2717 missing locales: {missing} \u2014 an untranslated locale falls back to "
          "English, so a Hindi or Arabic reader gets an English promise"); sys.exit(1)
bad = sorted(k for k, v in L.items() if v.get('stringUnit', {}).get('state') != 'translated')
if bad:
    print(f"  \u2717 not marked translated: {bad}"); sys.exit(1)
empty = sorted(k for k, v in L.items() if not (v.get('stringUnit', {}).get('value') or '').strip())
if empty:
    print(f"  \u2717 empty translation: {empty}"); sys.exit(1)
eng = L['en']['stringUnit']['value']
same = sorted(k for k, v in L.items()
              if k != 'en' and v['stringUnit']['value'].strip() == eng.strip())
if same:
    print(f"  \u2717 identical to English (untranslated in practice): {same}"); sys.exit(1)
print(f"  \u2713 all {len(WANT)} locales present, translated, non-empty, and distinct from English")
PY

# 3. THE PROMISE HAS TO BE KEEPABLE. The line says we will notify; the
#    soft-prompt fix is what makes that reachable for a user who once declined.
if sed -e 's://.*::' Promptly/Services/PushService.swift | grep -q 'SoftPromptPolicy.shouldOffer'; then
  say "✓" "the re-ask is still date-based, so the notification promise is keepable"
else
  say "✗" "the soft-prompt fix is gone — 'we'll let you know' becomes a promise to users who can never be asked for permission again"; fail=1
fi
if grep -rq 'maybeOfferSoftPromptAfterExport' Promptly/Views/MessageBubble.swift; then
  say "✓" "and something still re-asks after an export"
else
  say "✗" "nothing re-asks after an export — an expiring deferral with no later look-point changes nothing"; fail=1
fi

[ "$fail" -ne 0 ] && { echo "composer-wait-note-gate: FAIL"; exit 1; }
echo "composer-wait-note-gate: PASS"
