#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# generation-contract-gate.sh — the generation/batch contract, exercised.
#
# THIS IS A BEHAVIOURAL GATE, NOT A SOURCE ONE. It lifts the real types out of
# GenerationContract.swift, compiles them, and runs the contract's OWN example
# payloads through them. A grep would pass on a decoder that throws; only
# running it answers the question.
#
# WHAT IT PREVENTS, each paid for once already:
#
#  1. THE PERSIST ROUND-TRIP. GenerationQuote is stored inside SerializedMessage,
#     so it goes to disk on every chat switch. Its decoder reads `expires_at` as
#     an ISO STRING; the SYNTHESIZED encoder would have written a Double, and
#     the tolerant decoder would then have read that back as nil — every expiry
#     silently lost on reload, an aged-out card looking fresh forever. Caught by
#     the compiler only because PaymentRequired refused to synthesize; the quote
#     would have compiled and been wrong.
#
#  2. TOLERANCE WITHOUT BLINDNESS. Optionality covers absent and null but NOT a
#     type mismatch, and one throw fails the WHOLE parent decode — that is what
#     cost the 258 client its videos_limit. Optional fields must survive a wrong
#     type; REQUIRED fields must still refuse, so a card that cannot be honoured
#     is never drawn.
#
#  3. NO INVENTED ETA. eta_seconds is null until the server has 20 completed
#     jobs. A null must render as position-only. A wrong wait is not a small
#     error, it is a promise.
#
#  4. NO PROSE PARSING. `reason` alone decides the card, and `shortfall` is read
#     as a number. An unknown reason must stay legible rather than being erased.
set -uo pipefail
cd "$(dirname "$0")"
SRC="Promptly/Models/GenerationContract.swift"
[ -f "$SRC" ] || { echo "generation-contract-gate: FAIL — missing $SRC (a failed read is not a pass)"; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cp "$SRC" "$WORK/Contract.swift"

cat > "$WORK/main.swift" <<'SWIFT'
import Foundation

var failed = 0
func check(_ name: String, _ ok: Bool, _ detail: String = "") {
    print("  \(ok ? "ok  " : "FAIL") — \(name)\(ok || detail.isEmpty ? "" : " [\(detail)]")")
    if !ok { failed += 1 }
}
func dec<T: Decodable>(_ s: String) -> T? { try? JSONDecoder().decode(T.self, from: Data(s.utf8)) }

// ── 1. The contract's own quote payload ──────────────────────────────────────
let quoteJSON = """
{"quote_id":"uuid","kind":"ai_video","label":"AI video · 5s","credits":45,
 "balance":120,"affordable":true,"expires_at":"2026-09-23T12:00:00Z"}
"""
guard let q: GenerationQuote = dec(quoteJSON) else {
    print("  FAIL — the contract's own quote payload does not decode"); exit(1)
}
check("quote decodes from the contract payload", q.quoteId == "uuid" && q.credits == 45)
check("label is taken verbatim, never composed", q.label == "AI video · 5s", q.label)
check("expires_at parses to a Date", q.expiresAt != nil)

// ── 2. THE PERSIST ROUND-TRIP — the one that would have shipped broken ───────
if let data = try? JSONEncoder().encode(q),
   let back = try? JSONDecoder().decode(GenerationQuote.self, from: data) {
    check("quote survives encode→decode (chat switch)", back == q)
    check("expiry SURVIVES the round-trip (not silently dropped)",
          back.expiresAt != nil && abs((back.expiresAt ?? .distantPast).timeIntervalSince(q.expiresAt ?? .distantFuture)) < 1.5,
          String(describing: back.expiresAt))
    // And prove the encoder writes the spelling the decoder reads.
    let asText = String(data: data, encoding: .utf8) ?? ""
    check("expires_at is encoded as an ISO STRING, not a number",
          asText.contains("\"expires_at\":\"2026-09"), asText)
} else {
    check("quote survives encode→decode (chat switch)", false, "encode failed")
}

// ── 3. Tolerance, and its limit ──────────────────────────────────────────────
let wrongTypes = """
{"quote_id":"u","kind":123,"label":"AI video · 5s","credits":45,
 "balance":"lots","affordable":"yes","expires_at":99}
"""
if let t: GenerationQuote = dec(wrongTypes) {
    check("a wrong TYPE in an optional field does not fail the decode", true)
    check("...and the bad fields read as unknown, not as zero",
          t.balance == nil && t.affordable == nil && t.expiresAt == nil)
} else {
    check("a wrong TYPE in an optional field does not fail the decode", false, "whole decode threw")
}
let missingRequired: GenerationQuote? = dec("{\"kind\":\"ai_video\",\"label\":\"x\",\"credits\":4}")
check("a MISSING required field still refuses (no unhonourable card)", missingRequired == nil)
let mistypedCredits: GenerationQuote? = dec("{\"quote_id\":\"u\",\"label\":\"x\",\"credits\":\"forty\"}")
check("a MISTYPED price still refuses", mistypedCredits == nil)

// ── 4. One 402 shape, reason decides the card ────────────────────────────────
let pr402 = """
{"error":"payment_required","reason":"insufficient_credits",
 "needed":45,"balance":20,"shortfall":25,"actions":["topup","upgrade"]}
"""
if let p: PaymentRequired = dec(pr402) {
    check("402 reason parses to a case", p.reason == .insufficientCredits)
    check("shortfall is a NUMBER, never parsed from prose", p.shortfall == 25)
    check("actions survive", p.actions == ["topup", "upgrade"])
} else { check("402 decodes", false) }

for (raw, expect) in [("pro_required", PaymentRequired.Reason.proRequired),
                      ("daily_cap", .dailyCap)] {
    let j = "{\"error\":\"payment_required\",\"reason\":\"\(raw)\",\"needed\":1,\"balance\":0,\"shortfall\":1,\"actions\":[]}"
    let p: PaymentRequired? = dec(j)
    check("reason \(raw) maps to its own card", p?.reason == expect)
}
// Free tier must be DISTINGUISHABLE from insufficient credits, or "never an
// error" is unachievable — they are two different cards.
let free: PaymentRequired? = dec("{\"error\":\"payment_required\",\"reason\":\"pro_required\",\"actions\":[\"upgrade\"]}")
let short: PaymentRequired? = dec("{\"error\":\"payment_required\",\"reason\":\"insufficient_credits\",\"actions\":[\"topup\"]}")
check("free-tier and insufficient-credits are distinguishable", free?.reason != short?.reason)
// An unknown reason from a newer server stays legible instead of being erased.
let unknown: PaymentRequired? = dec("{\"error\":\"payment_required\",\"reason\":\"moon_phase\",\"actions\":[]}")
check("an unknown reason keeps its raw string", unknown?.reason == nil && unknown?.rawReason == "moon_phase")

// ── 5. Batch ─────────────────────────────────────────────────────────────────
let batchJSON = """
{"batch_quote_id":"bq","count":10,"credits_each":10,"credits_total":100,
 "balance":45,"affordable_count":4,"shortfall":55,"expires_at":"2026-09-23T12:00:00Z"}
"""
if let b: BatchQuote = dec(batchJSON) {
    check("batch quote decodes the contract payload", b.count == 10 && b.creditsTotal == 100)
    check("affordable_count comes FROM THE SERVER (never derived)", b.affordableCount == 4)
    check("batch shortfall is a number", b.shortfall == 55)
} else { check("batch quote decodes", false) }

// ── 6. Queue: no invented ETA ────────────────────────────────────────────────
check("a null ETA yields NO wait text (position only)", QueueState(position: 3, etaSeconds: nil).waitText == nil)
check("a zero ETA also yields no wait text", QueueState(position: 3, etaSeconds: 0).waitText == nil)
check("a real ETA does render", QueueState(position: 3, etaSeconds: 300).waitText != nil)
check("position always renders", QueueState(position: 3, etaSeconds: nil).positionText.contains("3"))

// ── THE UPGRADE BUTTON, AND WHAT A FAILURE MAY CLAIM ────────────────────────
check("a MAX user is offered no upgrade (a button to nowhere)",
      TierOffer.upgradeLabel(isPro: true, isMax: true) == nil)
check("a PRO user is told which tier they would be upgrading TO",
      TierOffer.upgradeLabel(isPro: true, isMax: false) == "Upgrade to Max")
check("...and it names Max, not a bare \"Upgrade\"",
      TierOffer.upgradeLabel(isPro: true, isMax: false)?.contains("Max") == true)

// THE MONEY CLAIM. "You weren't charged" may appear ONLY with a confirmed
// refund — anywhere else it is a reassurance that can turn out to be false.
let neverSent = ReeditFailureCopy.classify(reachedServer: false, creditsRefunded: nil)
let ranUnknown = ReeditFailureCopy.classify(reachedServer: true, creditsRefunded: nil)
let ranRefunded = ReeditFailureCopy.classify(reachedServer: true, creditsRefunded: 5)
let ranCharged = ReeditFailureCopy.classify(reachedServer: true, creditsRefunded: nil, chargeStands: true)

check("never sent makes NO money claim", neverSent.claimsNotCharged == false)
check("...and says it was not sent", neverSent.text.contains("didn't get sent"))
check("ran-and-failed with an UNCONFIRMED refund makes no money claim",
      ranUnknown.claimsNotCharged == false)
check("...and does not say 'weren't charged'", ranUnknown.text.contains("weren't charged") == false)
check("a CONFIRMED refund is the only case that says 'weren't charged'",
      ranRefunded.claimsNotCharged == true && ranRefunded.text.contains("weren't charged"))
check("a standing charge says so plainly", ranCharged.text.contains("credits were used"))
check("...and never claims they were not charged", ranCharged.claimsNotCharged == false)
// Exhaustive: across every input, the claim implies a confirmed refund.
var claimedWithoutRefund = 0
for reached in [true, false] {
  for refund in [nil, 0, 5] as [Int?] {
    for stands in [true, false] {
      let c = ReeditFailureCopy.classify(reachedServer: reached, creditsRefunded: refund, chargeStands: stands)
      if c.claimsNotCharged, !(refund ?? 0 > 0) { claimedWithoutRefund += 1 }
    }
  }
}
check("across ALL inputs, 'not charged' never appears without a confirmed refund",
      claimedWithoutRefund == 0)

// ── 7. 410 expiry carries a fresh quote ──────────────────────────────────────
let expiredJSON = """
{"reason":"quote_expired","requote":{"quote_id":"fresh","kind":"ai_video",
 "label":"AI video · 5s","credits":50,"balance":120,"affordable":true,
 "expires_at":"2026-09-23T12:10:00Z"}}
"""
if let e: QuoteExpired = dec(expiredJSON) {
    check("410 carries a fresh quote to swap in place", e.requote?.quoteId == "fresh")
    check("the fresh quote shows the NEW price", e.requote?.credits == 50)
} else { check("410 decodes", false) }

print(failed == 0 ? "generation-contract-gate: PASS" : "generation-contract-gate: FAIL (\(failed))")
exit(failed == 0 ? 0 : 1)
SWIFT

# ── The persistence seam (structural) ────────────────────────────────────────
# A quote that decodes perfectly and is not WIRED is an inert half. This repo
# has paid for that three times, so all four ParkedClarification-style sites are
# asserted together, plus the shouldPersist widening without which the card
# survives everything except a chat switch — the one place a user will find it.
M="Promptly/Models/Models.swift"
seam=0
sfail() { echo "  FAIL — $1"; seam=1; }
echo "generation-contract-gate:"
# ── The cards (structural) ───────────────────────────────────────────────────
# The contract makes claims the TYPES cannot enforce: an event must fire once
# per server RESPONSE and never per render; `reason` alone must pick the card;
# a null ETA must show nothing; and the client must not do arithmetic about
# money. Each is asserted where it can actually regress — in the view.
C="Promptly/Views/GenerationCards.swift"
ui=0
ufail() { echo "  FAIL — $1"; ui=1; }
if [ ! -f "$C" ]; then ufail "missing $C"; else
  # EVENTS ONCE PER RESPONSE. Every Analytics call for this flow lives in the
  # service, inside the function that received the response. The one impression
  # event here must be deduped through state, never emitted from a body.
  if grep -n 'Analytics.track' "$C" | grep -qv 'quote_card_shown'; then
    ufail "$C tracks something other than the deduped impression — events belong in the service, once per response"
  else
    echo "  ok   — the view emits only its deduped impression event"
  fi
  grep -Eq 'guard !reportedImpression else \{ return \}' "$C" \
    && echo "  ok   — the impression is deduped (counts appearances, not redraws)" \
    || ufail "the impression event is not deduped — it would count redraws"

  # REASON ALONE DECIDES THE CARD. All three must be handled by name.
  for r in insufficientCredits proRequired dailyCap; do
    grep -Eq "case \.$r[[:space:]]*:" "$C" && echo "  ok   — 402 $r has its own branch" \
      || ufail "402 $r has no branch — a reason with no card is a dead end"
  done

  # NO CLIENT ARITHMETIC ABOUT MONEY.
  grep -Eq 'batch\.affordableCount' "$C" \
    && echo "  ok   — the affordable count is read from the server" \
    || ufail "affordable_count is not read from the server — the client is deriving it"
  if grep -vE '^[[:space:]]*//' "$C" | grep -E '(balance|credits|shortfall|needed)' | grep -Eq '[^/]/[^/]'; then
    ufail "$C divides a money field — the client must do no arithmetic beyond formatting"
  else
    echo "  ok   — no division on a money field"
  fi

  # THE SERVER'S LABEL, VERBATIM. Text(_:) would treat it as a LocalizedStringKey.
  grep -Eq 'Text\(verbatim: state\.quote\.label\)' "$C" \
    && echo "  ok   — the server label renders verbatim" \
    || ufail "the server label is not rendered verbatim — Text(_:) would swallow it as a LocalizedStringKey"

  # THE PRO-REQUIRED COPY NAMES THE THING. Free users CAN generate images, so
  # a blanket "Generating is a Pro feature" is false — the card must use the
  # quote's own subject.
  grep -q 'Generating is a Pro feature' "$C" \
    && ufail "the pro_required copy still claims generating is Pro — free users can generate images"
  grep -Eq 'is a Pro feature' "$C" && grep -Eq 'Self\.subject\(of: state\.quote\.label\)' "$C" \
    && echo "  ok   — pro_required names the quote's own subject" \
    || ufail "pro_required does not name the subject from the quote label"

  # A SHORT BATCH IS RENDERED, NEVER ERRORED. Those jobs are running and paid.
  grep -Eq 'not started . not charged' "$C" \
    && echo "  ok   — clips the server never started are named, and named as uncharged" \
    || ufail "the batch card does not say which clips never started / were not charged"
  grep -Eq 'Set\(result\.jobs\.map\(\\\.clipId\)\)' "$C" \
    && echo "  ok   — not-started clips are derived by clip_id, not by count" \
    || ufail "not-started clips are not derived by clip_id — a subset says nothing about WHICH subset"

  # NO SECOND DISPATCH AFTER WORK HAS STARTED. Found by LOOKING at the
  # short-dispatch screenshot: "Generate 10" was still on screen under
  # "7 started", one tap away from charging for clips already running.
  grep -Eq 'if started != nil \{' "$C" \
    && echo "  ok   — the batch actions are gone once work has started" \
    || ufail "the batch card still offers an action after dispatch — a second tap would double-charge"

  # ONE PAYMENT UI, AND EVERY NUMBER FROM THE SERVER.
  # The shared card was extracted and the original left behind, so for a while
  # the quote flow said "back tomorrow" while the re-edit flow quoted a price —
  # two renderings of one refusal, which is how two surfaces quote two prices.
  n=$(grep -c 'case \.dailyCap:' "$C")
  [ "$n" = 1 ] && echo "  ok   — the three 402 reasons are rendered in exactly ONE place" \
               || ufail "the 402 reasons are rendered in $n places — a second payment UI"
  # No client-side price. Every figure on that card is the server's.
  if sed -n '/struct PaymentRequiredCard/,/^}/p' "$C" | grep -qE '[0-9]+ credits'; then
    ufail "a hardcoded credit figure is on the payment card — it must come from the 402 body"
  else
    echo "  ok   — no hardcoded credit figure on the payment card"
  fi
  # The cap period is the SERVER'S word, not ours.
  sed -n '/struct PaymentRequiredCard/,/^}/p' "$C" | grep -Fq 'payment.scope.map' \
    && echo "  ok   — the cap period comes from the server, not the word \"today\"" \
    || ufail "the cap period is hardcoded — saying today when the cap is monthly sends people back to the same wall"
  if sed -n '/struct PaymentRequiredCard/,/^}/p' "$C" | grep -q "today's included"; then
    ufail "the card still hardcodes \"today's\""
  else
    echo "  ok   — no hardcoded period in the cap copy"
  fi
  # Cost before balance, so the reader is not made to subtract.
  sed -n '/case .insufficientCredits:/,/case .proRequired:/p' "$C" | grep -Fq 'This change costs' \
    && echo "  ok   — insufficient leads with the COST, then the balance" \
    || ufail "insufficient copy does not lead with the cost"

  # QUEUE: ONLY ABOVE ZERO, AND NEVER AN INVENTED WAIT.
  grep -Eq 'state\.position > 0' "$C" \
    && echo "  ok   — the queue line draws only above position 0" \
    || ufail "the queue line does not gate on position > 0"
  grep -Eq 'guard let wait = state\.waitText else \{ return state\.positionText \}' "$C" \
    && echo "  ok   — a null ETA falls back to the position alone" \
    || ufail "a null ETA does not fall back to position-only"
fi
S="Promptly/Services/GenerationService.swift"
if [ ! -f "$S" ]; then ufail "missing $S"; else
  grep -Eq 'return \.failed\("batch returned' "$S" \
    && ufail "$S still FAILS a short batch — those jobs are running and already charged" \
    || echo "  ok   — a short batch is not turned into a failure"
  grep -Eq 'Analytics\.track\("batch_count_mismatch"' "$S" \
    && echo "  ok   — a count mismatch is still reported" \
    || ufail "a count mismatch is no longer reported"
fi
[ "$ui" = 0 ] || { echo "generation-contract-gate: FAIL (cards)"; exit 1; }

if [ ! -f "$M" ]; then sfail "missing $M"; else
  # in-memory
  grep -Eq '^[[:space:]]*var quote: GenerationQuote\?' "$M" \
    && echo "  ok   — quote is declared on the message" || sfail "quote is not declared on ChatMessage/SerializedMessage"
  # BOTH declarations: ChatMessage and SerializedMessage
  n=$(grep -Ec '^[[:space:]]*var quote: GenerationQuote\?' "$M")
  [ "$n" = 2 ] && echo "  ok   — declared in BOTH the in-memory and persisted shapes" \
                || sfail "quote declared $n time(s), expected 2 (in-memory + persisted)"
  # serialize + deserialize
  grep -Eq '^[[:space:]]*self\.quote = message\.quote' "$M" \
    && echo "  ok   — serialize carries the quote" || sfail "serialize drops the quote"
  grep -Eq '^[[:space:]]*msg\.quote = quote' "$M" \
    && echo "  ok   — deserialize restores the quote" || sfail "deserialize drops the quote"
  # the shouldPersist widening, scoped to the function
  if sed -n '/static func shouldPersist/,/^    }/p' "$M" | grep -Eq '^[[:space:]]*if .*message\.quote != nil'; then
    echo "  ok   — shouldPersist keeps a quote-only message"
  else
    sfail "shouldPersist does not mention quote — a quote-only card dies on chat switch"
  fi
fi
[ "$seam" = 0 ] || { echo "generation-contract-gate: FAIL (persistence seam)"; exit 1; }

if ! swiftc -O -swift-version 5 -o "$WORK/run" "$WORK/Contract.swift" "$WORK/main.swift" 2>"$WORK/cc.log"; then
  echo "  FAIL — the contract types do not compile standalone"
  sed -n '1,15p' "$WORK/cc.log"
  exit 1
fi
"$WORK/run"
