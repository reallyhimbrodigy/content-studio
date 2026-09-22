#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# usage-decode-tolerance-gate.sh — /api/usage must never fail to decode.
#
# THIS IS A BEHAVIOURAL GATE, NOT A SOURCE ONE. It lifts the real VideoLimits
# out of UsageService.swift, compiles it, and decodes actual JSON through it. A
# grep for `init(from:)` would pass on a decoder that still throws; only running
# it answers the question.
#
# WHAT IT PREVENTS. `videos_limit` is optional, and optionality covers absent
# and null — NOT a type mismatch. The server work in flight sends a SCALAR
# (videosLimitFor returns the caller's own number) where this client was written
# for a per-tier object. Measured against the real structs before the fix:
#
#   absent  → decoded
#   object  → decoded
#   scalar  → THREW "Expected to decode Dictionary<String, Any> but found number"
#
# One throw anywhere in Snapshot fails the WHOLE decode, so refresh() returns
# early and render_limit, chat_limit, resets_at and validate_token go blank with
# it. A missing allowance is meant to be an absent line; this would have been an
# outage, and a silent one — the client just stops knowing anything.
#
# So every assertion below also checks validate_token survived. That field has
# nothing to do with video allowances, which is the point: it is the canary for
# "the whole snapshot still decoded".
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail
cd "$(dirname "$0")/Promptly" || exit 1

command -v swift >/dev/null 2>&1 || { echo "usage-decode-tolerance-gate: SKIPPED — no swift toolchain"; exit 0; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

python3 - "$WORK" <<'PY'
import sys, pathlib
work = pathlib.Path(sys.argv[1])
src = pathlib.Path('Services/UsageService.swift').read_text(encoding='utf-8')

marker = '    struct VideoLimits: Codable {'
if marker not in src:
    print("  ✗ VideoLimits is gone from UsageService — nothing to test"); sys.exit(1)
i = src.index(marker); j = src.index('{', i); depth = 0; k = j
while True:
    if src[k] == '{': depth += 1
    elif src[k] == '}':
        depth -= 1
        if depth == 0: break
    k += 1
body = src[i:k+1].replace('    struct VideoLimits', 'struct VideoLimits', 1)

(work / 'probe.swift').write_text('''import Foundation
''' + body + '''

struct Snapshot: Codable {
    let is_pro: Bool
    let render_limit: Int
    let validate_token: String?
    let videos_limit: VideoLimits?
}
let base = #""is_pro":false,"render_limit":7,"validate_token":"canary""#
func attempt(_ label: String, _ json: String) {
    do {
        let s = try JSONDecoder().decode(Snapshot.self, from: Data(json.utf8))
        let v = s.videos_limit
        let tok = s.validate_token ?? "LOST"
        print("OK|\\(label)|\\(tok)|\\(s.render_limit)|own=\\(v?.own.map(String.init) ?? "nil")|pro=\\(v?.pro.map(String.init) ?? "nil")")
    } catch {
        print("THREW|\\(label)|\\(error)")
    }
}
attempt("absent", "{\\(base)}")
attempt("object", "{\\(base),\\"videos_limit\\":{\\"free\\":3,\\"pro\\":50,\\"max\\":200}}")
// THE SHAPE MAIN ACTUALLY EMITS since ca74efee — all four keys, every time.
// videosLimitFor returns {free, pro, max, own}; `own` is the caller's own
// allowance and is NULL, not 0 and not the smallest tier, when the profile row
// is unreadable.
attempt("live",   "{\\(base),\\"videos_limit\\":{\\"free\\":3,\\"pro\\":50,\\"max\\":200,\\"own\\":50}}")
attempt("ownnull","{\\(base),\\"videos_limit\\":{\\"free\\":3,\\"pro\\":50,\\"max\\":200,\\"own\\":null}}")
attempt("scalar", "{\\(base),\\"videos_limit\\":50}")
attempt("null",   "{\\(base),\\"videos_limit\\":null}")
attempt("string", "{\\(base),\\"videos_limit\\":\\"fifty\\"}")
attempt("array",  "{\\(base),\\"videos_limit\\":[3,50,200]}")
attempt("nested", "{\\(base),\\"videos_limit\\":{\\"pro\\":{\\"n\\":50}}}")
''', encoding='utf-8')
PY
[ -f "$WORK/probe.swift" ] || { echo "usage-decode-tolerance-gate: FAIL — probe not built"; exit 1; }

OUT=$(swift "$WORK/probe.swift" 2>&1); RC=$?
if [ "$RC" -ne 0 ]; then
  echo "  ✗ the lifted VideoLimits does not compile on its own"
  echo "$OUT" | tail -6
  echo "usage-decode-tolerance-gate: FAIL"; exit 1
fi

printf '%s\n' "$OUT" | python3 -c '
import sys
lines=[l for l in sys.stdin.read().splitlines() if l.startswith(("OK|","THREW|"))]
fails=[]
EXPECT={"absent","object","live","ownnull","scalar","null","string","array","nested"}
seen=set()
for l in lines:
    p=l.split("|")
    seen.add(p[1])
    if p[0]=="THREW":
        print(f"  ✗ {p[1]}: the decode THREW — the whole snapshot is lost ({p[2][:70]})"); fails.append(p[1]); continue
    if p[2]!="canary" or p[3]!="7":
        print(f"  ✗ {p[1]}: decoded but the rest of the snapshot did not survive"); fails.append(p[1]); continue
    print(f"  ✓ {p[1]}: decodes, snapshot intact ({p[4]}, {p[5]})")
missing=EXPECT-seen
if missing:
    print(f"  ✗ shapes never tested: {sorted(missing)} — a probe that runs fewer cases reads clean by having less to find")
    fails.extend(missing)
# The scalar must actually be READ, not merely survived: dropping it on the
# floor would pass a throws-check while still losing the number.
# THE LIVE SHAPE MUST BE FULLY READ, not merely survived.
live=[l for l in lines if l.startswith("OK|live|")]
if live and ("own=50" not in live[0] or "pro=50" not in live[0]):
    print("  ✗ the live four-key object decodes but own and the tiers are not both read")
    fails.append("live-values")
elif live:
    print("  ✓ live: own AND the per-tier numbers are both read")

# own=null is the unreadable-profile case. The TIERS must survive it — the
# paywall sells Pro and Max to exactly the user whose own allowance is unknown,
# so losing them here would blank the screen that matters most. And `own` must
# stay nil rather than quietly becoming the smallest tier: 3 shown to a Max
# subscriber is worse than showing nothing.
onull=[l for l in lines if l.startswith("OK|ownnull|")]
if onull and ("own=nil" not in onull[0] or "pro=50" not in onull[0]):
    print("  ✗ own=null either leaks a value or takes the per-tier numbers down with it")
    fails.append("ownnull-values")
elif onull:
    print("  ✓ own=null: stays nil, and the per-tier numbers still read")

scal=[l for l in lines if l.startswith("OK|scalar|")]
if scal and "own=50" not in scal[0]:
    print("  ✗ scalar decodes but its value is discarded — the account screen would show nothing")
    fails.append("scalar-value")
elif scal:
    print("  ✓ scalar: its value is actually read (own=50), not just tolerated")
if fails:
    print(f"\nusage-decode-tolerance-gate: FAIL ({len(fails)})"); sys.exit(1)
print("usage-decode-tolerance-gate: PASS — every shape decodes, snapshot always intact")
'
