# Submitting a build — the only correct procedure

**Do not write, or follow, a branch that names a version.**

## What to run

```
node scripts/asc-ship.js --decide          # is there anything to submit, and what
node scripts/asc-ship.js <version> <build> # submit it
```

`--decide` is the form a recurring runbook calls. It reads live App Store state
and answers on its own; the caller needs to know nothing.

## Why the old instruction was deleted

The retired step read, in prose:

> If 1.3.18 is READY_FOR_SALE, the review slot is free — submit 1.3.19 (237).

That was true the hour it was written. Days later 1.3.19 was `READY_FOR_SALE`
and 1.3.21 was in review, and the same words now meant *"submit a two-build-old
binary over queued work."* **The observation stayed correct; the inference
expired**, silently, with nothing in the instruction able to notice.

It fired at least six times against a state three submissions old. `asc-preflight`
blocked it every time — but a guard that catches a wrong instruction on every run
is not a fix, it is a permanent alarm. The branch is gone, and the four
per-version scratch scripts (`asc-ship-1317/1318/1319/1320.js`) are deleted.

## The rule this encodes

A condition about the world must be **evaluated against the world**, not
remembered from when it was observed. Anything of the form "if X is in state S,
then do Y to version V" is stale the moment it is written down. `--decide`
re-derives it every time.

## What asc-ship guards

- target version already terminal (`READY_FOR_SALE`, `PENDING_DEVELOPER_RELEASE`)
- a **newer** version already in flight — submitting older work would displace it
- the same version already queued
- any version in a rejected state — that needs a human decision about *why* first
- an unreadable API — **blocks**, because an unknown is not a free slot

It sets release notes on a freshly created version (a missing `whatsNew` 409s the
submission item with nothing explaining why), and it **verifies against ASC after
submitting** rather than trusting its own 200s.
