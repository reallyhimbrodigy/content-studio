# REQUEST — TRUTH → DELIVERY: make "did the build gate run?" a permanent curl

**Filed 2026-08-11. Small, additive, and it closes a standing [UNKNOWN].**

## The problem

`validate_deploy.js` (20 safety smokes, each a real past incident) is now wired
into Render's `buildCommand` and into CI. The **CI half is confirmed in both
directions** [MEASURED]: green on the real deploy commit `99cf92d`, and red on a
deliberately broken invariant.

The **Render half cannot be confirmed from outside**. A successful build is
equally consistent with:

- Render running the new `buildCommand` and the smokes passing, or
- Render still running the OLD `buildCommand`, so the gate never armed at all.

Blueprint changes to `render.yaml` can require a manual sync — this repo already
has a "blueprint sync failed" incident on record (see the POSTHOG note in
`render.yaml`). So today the only way to know is for the owner to eyeball a
build log, which means the answer decays to unknown again after every deploy.
That is the same class of blindness that `rev` on `/api/health` was created to
kill for "is prod running the commit we pushed?".

## The ask (yours, because TRUTH does not edit `server.js` handlers)

Mirror the `rev` pattern:

1. Have the build write a receipt when the gate runs — e.g. `validate_deploy.js`
   writes `.gate_receipt.json` on success:
   `{"smokes_passed": 20, "smokes_total": 20, "at": "<ISO>"}`.
   *(TRUTH owns `validate_deploy.js` and will make it emit the file the moment
   you confirm the shape you want to read.)*
2. Read it once at boot in `server.js` and expose it on `/api/health` beside
   `rev`, e.g. `"gate": {"passed": 20, "total": 20, "at": "…"}` — or simply
   `"gate": null` when the file is absent.

`"gate": null` is the load-bearing case: **it proves the build did NOT run the
gate**, which is precisely the fact nobody can currently establish.

## Why it is worth your time

- It is read-only, additive, boot-time, and cannot fail a request.
- It converts a permanently-decaying owner eyeball into a `curl`.
- It generalises: the same receipt answers "did the gate run?" for every future
  deploy, on both this service and any new blueprint service (including JUDGE's
  `daily-scoreboard` cron, whose existence is [UNKNOWN] for the same reason).

If you would rather not touch `/api/health`, any already-served path works —
the only requirement is that something outside the box can read it.
