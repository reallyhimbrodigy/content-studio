#!/usr/bin/env python3
"""THE FOUR FLOOD ASSERTIONS, read off a recorded run.

Usage: flood-analyze.py <proxy-log.json> [--expect-upload]

The UI test asserts what is on the SCREEN. This asserts what went on the WIRE,
which is the half a screenshot cannot show: the retry schedule, whether one
intent produced one key, and whether concurrent presigns are distinct requests
or the same one sent twice.

A ZERO IS A HARNESS FAULT UNTIL PROVEN OTHERWISE. Every run records a /__ping
answered healthily in every mode; if that row is missing, the app never reached
the proxy and nothing below is a finding.
"""
import json, re, sys

BACKOFF = [2, 5, 15, 30, 60, 60]          # PresignResilience.backoff
TOL = 0.75                                # seconds of slack per wait.
# NOT wider: at 1.5s a gap of 1.0s passed as a 2s wait, so a schedule half
# the declared length read as a match. Real runs land within 0.05s.

def fail(msg): print(f"  FAIL - {msg}"); return 1
def ok(msg):   print(f"  ok   - {msg}"); return 0

def main():
    path = sys.argv[1]
    expect_upload = "--expect-upload" in sys.argv
    rows = json.load(open(path))
    bad = 0

    if not any(r["path"] == "/__ping" for r in rows):
        print("  PROXY NOT REACHED - no /__ping row. Harness fault, not a result.")
        return 2

    api = [r for r in rows if r["path"] != "/__ping"]
    print(f"flood-analyze: {len(api)} API request(s) in {path.split('/')[-1]}")

    # ---- 1. ONE INTENT, ONE KEY ------------------------------------------
    reedits = [r for r in api if "re-edit" in r["path"]]
    if reedits:
        keys = {r.get("idem") for r in reedits}
        if None in keys:
            bad |= fail("a re-edit went out with NO Idempotency-Key - a retry of it "
                        "is a second job and a second charge")
        elif len(keys) == 1:
            bad |= ok(f"{len(reedits)} re-edit attempt(s), 1 key "
                      f"({list(keys)[0][:8]}...) - a received send cannot be charged twice")
        else:
            bad |= fail(f"{len(reedits)} re-edit attempts carried {len(keys)} DIFFERENT keys "
                        "- each is a separate job to the server")

    # ---- 2. PRESIGNS ARE DISTINCT, NOT DUPLICATED ------------------------
    presigns = [r for r in api if "upload-url" in r["path"]]
    if presigns:
        def kind(r):
            m = re.search(r'"fileName"\s*:\s*"([^"]*)"', r.get("body") or "")
            n = m.group(1) if m else ""
            if n.startswith("validation-samples/"): return "validation"
            if n.startswith("proxy-"):              return "proxy"
            return "source" if n else "unknown"
        kinds = [kind(r) for r in presigns]
        counts = {k: kinds.count(k) for k in set(kinds)}
        print(f"       presign filenames: {counts}")
        if "unknown" in counts:
            bad |= fail(f"{counts['unknown']} presign(s) with no readable fileName - "
                        "the field that separates a distinct presign from a duplicate")
        else:
            # The pair retries together; validation is advisory and NOT retried,
            # so it must appear at most once however many attempts there were.
            if counts.get("proxy", 0) != counts.get("source", 0):
                bad |= fail(f"proxy presigns ({counts.get('proxy',0)}) != source presigns "
                            f"({counts.get('source',0)}) - the pair is issued together, so "
                            "a mismatch means one was sent without the other")
            else:
                bad |= ok(f"{counts.get('proxy',0)} attempt(s), each one proxy + one source "
                          "presign with distinct filenames - no duplicate")
            if counts.get("validation", 0) > 1:
                bad |= fail(f"{counts['validation']} validation-sample presigns - it is "
                            "advisory and outside withRetry, so it must fire at most once")
            elif counts.get("validation", 0) == 1:
                bad |= ok("1 validation-sample presign - advisory, distinct, not retried")

        # ---- 3. THE RETRY SCHEDULE -------------------------------------
        waves, last = [], None
        for r in sorted(presigns, key=lambda r: r["t"]):
            if kind(r) == "validation":     # not on the retry schedule
                continue
            if last is None or (r["t"] - last) > 500:
                waves.append(r["t"])
            last = r["t"]
        if len(waves) >= 2:
            gaps = [round((waves[i+1] - waves[i]) / 1000, 2) for i in range(len(waves) - 1)]
            want = BACKOFF[:len(gaps)]
            if all(abs(g - w) <= TOL for g, w in zip(gaps, want)):
                bad |= ok(f"retry gaps {gaps}s match PresignResilience.backoff {want}s")
            else:
                bad |= fail(f"retry gaps {gaps}s do not match backoff {want}s - "
                            "the app is not waiting the schedule it declares")
        elif expect_upload:
            bad |= fail("fewer than 2 presign waves - no retry happened")
    elif expect_upload:
        bad |= fail("no presign requests at all, but an upload run was expected")

    print("flood-analyze: " + ("PASS" if not bad else "FAIL"))
    return bad

sys.exit(main())
