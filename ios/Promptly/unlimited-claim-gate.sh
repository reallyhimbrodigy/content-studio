#!/bin/bash
# unlimited-claim-gate.sh — "unlimited" is a claim about VIDEOS, and it is false.
#
# Pro is metered at 200 credits a month = 20 videos (COST_PER_RENDER 10). Any
# surface promising unlimited videos/renders/edits sells something the product
# does not deliver — in English or in any of the other eleven locales. A German
# or Portuguese string saying "unbegrenzt"/"ilimitado" is the same defect; it
# just fails in a language nobody on the team reads.
#
# STILL ALLOWED, because it is TRUE and verified: unlimited CHATS. The only
# credit debit site is render dispatch (shouldDebit is false for every re-edit
# variant) and chatLimit is Infinity for paid tiers. Removing a true claim
# understates the product — the failure direction that reads as cautious and
# therefore goes unchallenged.
set -u
cd "$(dirname "$0")"
fail=0
say() { printf '  %s %s\n' "$1" "$2"; }

python3 - <<'PY' || fail=1
import json, re, sys, glob
WORD = re.compile(
    r'unlimit|ilimitad|unbegrenzt|illimit|tak terbatas|無制限|무제한|无限'
    r'|असीमित|अनलिमिटेड|असीम|অসীম|লিমিটহীন|لامحدود|غير\s*محدود|لا\s*محدود', re.I)
# ── THE SAME CLAIM WITHOUT THE WORD ──────────────────────────────────────────
# The first version of this gate matched a WORD, not a CLAIM, and passed five
# live strings that promised unlimited videos in plain English: "Pro gives you
# as many as you want", "make as many videos and chats as you want", "keep
# creating without limits", "No daily limit — create as much as you want". A
# lexical gate on a semantic defect finds the instances that happen to use the
# vocabulary you thought of.
UNBOUNDED = re.compile(
    r'as many as you want|as many [^.]{0,40}as you want|as much as you (?:want|like)'
    r'|without limits?|no limits?\b|no daily (?:limit|cap)|never run out|all you want'
    r'|endless'
    # AND THE SAME PHRASING IN THE OTHER ELEVEN. The English-only version of
    # this pattern missed a German "ohne Limits" — caught by mutation, and
    # exactly the gap that let the word-only version through in the first place.
    # A semantic gate written in one language is a lexical gate wearing a
    # semantic name.
    r'|ohne\s*(?:limit|grenzen)|sin\s*l[ií]mite|sans\s*limite|senza\s*limit'
    r'|sem\s*limite|tanpa\s*batas|무제한|制限(?:なし|無し)|上限なし'
    r'|बिना\s*किसी?\s*सीमा|कोई\s*सीमा\s*नहीं|सीमा\s*बिना'
    r'|সীমা\s*ছাড়া|কোনো\s*সীমা\s*নেই|بغیر\s*کسی?\s*حد|بلا\s*حدود|بدون\s*حدود', re.I)
# The allowed-claim words, taken from the ACTUAL translations of
# 'Unlimited AI chats' rather than guessed: fr renders it 'Discussions IA
# illimitées', which has no 'chat' in it and was flagged on this gate's
# first run. Guessing the vocabulary of a language you do not read is how a
# locale-aware check turns into an English-only one.
# WHAT AN UNBOUNDED CLAIM MAY BE *ABOUT*. Only renders are metered — the single
# debit site is render dispatch — so CHATS and EXPORTS are genuinely unlimited
# for paid tiers and saying so is true. Verified, not assumed: chatLimit is
# Infinity for paid, and lib/credits.js has no export concept at all.
# Both subjects are listed in every language they actually appear in, taken from
# the real translations. Guessing the vocabulary is what let a French
# "Discussions IA illimitées" and a Spanish "sin límite de exportaciones" get
# flagged as false when both are true.
ALLOWED_SUBJECT = re.compile(
    r'chat|discussion|چیٹ|محادث|च्याट|चैट|চ্যাট|チャット|채팅|obrol'
    r'|export|exporta|ekspor|書き出し|এক্সপোর্ট|एक्सपोर्ट|ایکسپورٹ|निर्यात', re.I)
CHAT = ALLOWED_SUBJECT
bad = []
d = json.load(open('Promptly/Localizable.xcstrings'))
for key, entry in d['strings'].items():
    for loc, lv in (entry.get('localizations') or {}).items():
        val = (lv.get('stringUnit') or {}).get('value') or ''
        if (WORD.search(val) or UNBOUNDED.search(val)) and not CHAT.search(val):
            bad.append(f'Localizable.xcstrings [{loc}] {val[:80]}')
    if (WORD.search(key) or UNBOUNDED.search(key)) and not CHAT.search(key):
        bad.append(f'Localizable.xcstrings [key] {key[:80]}')
for f in glob.glob('Promptly/**/*.swift', recursive=True):
    for i, line in enumerate(open(f, encoding='utf8', errors='replace'), 1):
        code = re.sub(r'//.*$', '', line)     # comments are prose, not claims
        if (WORD.search(code) or UNBOUNDED.search(code)) and not CHAT.search(code):
            bad.append(f'{f}:{i} {code.strip()[:80]}')
if bad:
    print('  ✗ an unbounded-VIDEO claim is live on a selling surface:')
    for b in bad: print(f'      {b}')
    print('    Pro is 200 credits a month — 20 videos. Say that instead.')
    sys.exit(1)
print('  ✓ no unlimited-video claim in any of the 12 locales or in Swift source')
PY

if grep -q "200 credits a month" Promptly/Localizable.xcstrings; then
  say "✓" "the replacement claim (200 credits a month — 20 videos) is present"
else
  say "✗" "the true claim is missing — removing a false claim is not making a true one"; fail=1
fi
if grep -q "static let creditsPerVideo = 10" Promptly/Views/ProBenefits.swift; then
  say "✓" "creditsPerVideo = 10, so 200 credits really is 20 videos"
else
  say "✗" "creditsPerVideo changed — every '20 videos' string is now wrong"; fail=1
fi

[ "$fail" -ne 0 ] && { echo "unlimited-claim-gate: FAIL"; exit 1; }
echo "unlimited-claim-gate: PASS"
