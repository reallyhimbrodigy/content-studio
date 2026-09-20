#!/usr/bin/env python3
"""RED PROOF — restoring the default temperature must FAIL the determinism leg.

WHY. The rule is "a model call that feeds a verdict runs at temperature 0, and a
leg proves it". A leg that has never failed is not yet a leg, and the mutation
that matters is the exact regression: someone deletes `temperature: 0` and the
call silently returns to the default 1.0.

EVERY MUTATION IS APPLIED TO A COPY. The harness copies the tree it checks into
a temp directory and mutates THAT, so a kill between mutate and restore cannot
leave the mutant on disk — which is the failure relocation alone never reaches,
and it would leave exactly the defect this proof exists to detect.

FOUR LEGS.
  1. GREEN  the tree as it stands passes the static leg (5/5 pinned)
  2. RED    deleting `temperature: 0` from ONE call site fails it, and NAMES
            that file — a leg that fails without saying which call regressed
            makes the next run the debugger
  3. RED    deleting it from EVERY site fails, and reports 0 pinned
  4. RED    an empty call-site population is rc=2 HARNESS FAILURE, not a pass:
            a gate over an empty population asserts nothing, this one included

Each red asserts the leg's OWN WORDS and not merely a non-zero exit — a red for
another reason is exactly as wrong as a green for another reason.
"""
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
SMOKE = "scripts/fulfilment/smoke_verdict_determinism.js"
TARGET = "scripts/fulfilment/classify.js"


def tree_copy():
    d = pathlib.Path(tempfile.mkdtemp(prefix="det_"))
    for sub in ("lib", "scripts"):
        shutil.copytree(ROOT / sub, d / sub)
    return d


def run(root):
    """-> (rc, out). NO PIPE: the status is the smoke's, not a pager's."""
    r = subprocess.run(["node", str(root / SMOKE)], capture_output=True, text=True,
                       timeout=180, cwd=str(root))
    return r.returncode, (r.stdout or "") + (r.stderr or "")


def unpin(path):
    """Remove `temperature: 0, ` exactly as a careless edit would. -> did it apply."""
    s = path.read_text(encoding="utf-8")
    if "temperature: 0, " not in s:
        return False
    path.write_text(s.replace("temperature: 0, ", "", 1), encoding="utf-8")
    return True


def main():
    legs = []

    # 1. GREEN — the real tree, read-only.
    rc, out = run(ROOT)
    legs.append(("GREEN the tree as it stands passes", rc == 0 and "0 at the default" in out,
                 out.strip().splitlines()[-1].strip() if out.strip() else "(no output)"))

    # 2. RED — one site unpinned, and the leg must NAME it.
    d = tree_copy()
    try:
        ok = unpin(d / TARGET)
        if not ok:
            legs.append(("RED   one site unpinned fails and names it", False, "HARNESS: anchor absent in " + TARGET))
        else:
            rc, out = run(d)
            named = "classify.js" in out and "DEFAULT" in out
            legs.append(("RED   one site unpinned fails and names it",
                         rc == 1 and named and "1 at the default" in out,
                         "rc=%d named=%s" % (rc, named)))
    finally:
        shutil.rmtree(d, ignore_errors=True)

    # 3. RED — every site unpinned.
    d = tree_copy()
    try:
        n = 0
        for f in ("lib/negotiation-classifier.js", "scripts/fulfilment/classify.js",
                  "scripts/fulfilment/readjudicate.js", "scripts/fulfilment/fulfilment_judge_v2.js"):
            p = d / f
            s = p.read_text(encoding="utf-8")
            c = s.count("temperature: 0, ")
            if c:
                p.write_text(s.replace("temperature: 0, ", ""), encoding="utf-8")
                n += c
        if not n:
            legs.append(("RED   every site unpinned reports 0 pinned", False, "HARNESS: nothing to unpin"))
        else:
            rc, out = run(d)
            legs.append(("RED   every site unpinned reports 0 pinned",
                         rc == 1 and "5 pinned" not in out and ", 0 pinned," in out,
                         "rc=%d unpinned=%d" % (rc, n)))
    finally:
        shutil.rmtree(d, ignore_errors=True)

    # 4. RED — an empty population is a HARNESS FAILURE, never a pass.
    d = tree_copy()
    try:
        for f in ("lib/negotiation-classifier.js", "scripts/fulfilment/classify.js",
                  "scripts/fulfilment/readjudicate.js", "scripts/fulfilment/fulfilment_judge_v2.js"):
            p = d / f
            if p.exists():
                p.unlink()
        rc, out = run(d)
        legs.append(("RED   empty population is rc=2", rc == 2 and "HARNESS FAILURE" in out,
                     "rc=%d phrase=%s" % (rc, "HARNESS FAILURE" in out)))
    finally:
        shutil.rmtree(d, ignore_errors=True)

    print("RED PROOF — the verdict-temperature leg")
    bad = 0
    for name, ok, detail in legs:
        print("  [%s] %-44s %s" % ("ok " if ok else "FAIL", name, detail))
        bad += 0 if ok else 1
    print()
    if not legs:
        print("HARNESS FAILURE: no legs ran")
        return 2
    print("%d legs, %d green, %d failed" % (len(legs), len(legs) - bad, bad))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
