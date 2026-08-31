#!/bin/bash
# picker-recovery-gate.sh — a dropped pick must never be silent again.
#
# WHAT WENT WRONG. VideoPicker resolved every picked video through
# PHAsset.fetchAssets(withLocalIdentifiers:), which requires photo-library READ
# authorization that this app never requests — the only requestAuthorization in
# the tree is `.addOnly`, for SAVING a finished video. PHPicker itself runs out
# of process and needs no permission, so the picker opened, the user tapped a
# video, it dismissed normally, the fetch returned an EMPTY SET with no error,
# and the guard dropped it. The user landed on an unchanged screen with nothing
# to tell them what happened.
#
# It was the largest activation loss on the board and completely invisible:
# measured 2,351 no_asset against 0 no_identifier — an absolute split, meaning
# the identifier was ALWAYS present and it was always the second guard.
#
# THREE THINGS THIS ENFORCES, because the fix has three parts that can each be
# undone independently:
#
#   1. THE FALLBACK EXISTS. `result.itemProvider` must be used. Deleting the
#      recovery and going back to asset-only is the exact regression.
#   2. THE FAILURE IS VISIBLE. An unrecoverable pick must set the flag the UI
#      alerts on. A recovery path that silently drops when IT fails is the same
#      bug one level down.
#   3. AUTHORIZATION IS MEASURED. picker events must carry read_auth, or the
#      three causes (never-asked / denied / limited-outside-grant) collapse back
#      into one undiagnosable number — which is what made this take weeks.
set -uo pipefail
cd "$(dirname "$0")"
SRC="Promptly"
PICKER="$SRC/Services/VideoPicker.swift"
fail=0

note() { echo "  ✗ $1"; fail=1; }

[ -f "$PICKER" ] || { echo "picker-recovery-gate: CANNOT READ — $PICKER missing."; exit 2; }

# Comment-stripped, so prose describing the bug cannot satisfy the check.
#
# Captured into a VARIABLE rather than piped. With `set -o pipefail`, a
# `code file | grep -q x` pipeline reports FAILURE even on a match: grep -q
# exits the instant it matches, the upstream grep gets SIGPIPE, and pipefail
# propagates that. It only bites on large files — EditorView.swift is 240KB, so
# the writer is still streaming when the reader quits, while VideoPicker.swift
# finishes first and passes. A gate whose verdict depends on file size is the
# cry-wolf failure this gate exists to prevent, so it is not allowed to have it.
code() { grep -v '^[[:space:]]*//' "$1" || true; }
# NATIVE bash matching — no pipe, so no SIGPIPE and no pipefail interaction.
# `printf '%s' "$big" | grep -q x` still fails with 141 even when it MATCHES:
# grep -q exits the instant it finds the match, printf is still writing the
# remaining ~136KB, and pipefail surfaces the broken pipe as the verdict. Using
# grep -c instead would work (it reads to EOF) but silently re-introduces the
# hazard for anyone who later reaches for -q. A case statement cannot have it.
has() { case "$2" in *"$1"*) return 0 ;; *) return 1 ;; esac; }
# Regex form, for the one check that needs it. grep -c reads to EOF, so no SIGPIPE.
hasre() { [ "$(printf '%s' "$2" | grep -cE "$1" || true)" -gt 0 ]; }

# 1 — the item-provider fallback must be wired.
PICKER_CODE="$(code "$PICKER")"
EDITOR_CODE="$(code "$SRC/Views/EditorView.swift")"

if ! has 'itemProvider' "$PICKER_CODE"; then
  note "VideoPicker no longer references result.itemProvider — the recovery path is gone."
  note "  Without it a pick that fails PHAsset.fetchAssets is silently discarded again."
fi
if ! has 'loadFileRepresentation' "$PICKER_CODE"; then
  note "no loadFileRepresentation call — the provider is referenced but never read."
fi

# 2 — an unrecoverable pick must be surfaced, not swallowed.
if ! has 'lastUnrecoverableCount' "$PICKER_CODE"; then
  note "VideoPicker no longer records unrecoverable picks; the UI cannot report them."
fi
if ! has 'lastUnrecoverableCount' "$EDITOR_CODE"; then
  note "EditorView never reads lastUnrecoverableCount — a total failure would be a no-op again."
fi
if ! has 'showPickerError' "$EDITOR_CODE"; then
  note "no showPickerError state — nothing presents the failure to the user."
fi

# 3 — authorization status must ride on the picker events.
if ! has 'authorizationStatus(for: .readWrite)' "$PICKER_CODE"; then
  note "read authorization is no longer inspected; the three causes become indistinguishable."
fi
if [ "$(printf '%s' "$PICKER_CODE" | grep -c 'read_auth' || true)" -lt 2 ]; then
  note "read_auth is not carried on the picker events (expected on both the clean and recovery emissions)."
fi

# 4 — the asset path must remain OPTIONAL. Re-tightening PickedVideo.asset to a
# non-optional PHAsset would force the recovery path back out of existence.
# Asserted POSITIVELY. The first version hunted the negative — `let asset:
# PHAsset[^?]` — which needs a character AFTER the type name, so a declaration
# at end-of-line (exactly what the regression produces) matched nothing and the
# check passed on the very change it exists to catch. A gate that only fails on
# the shapes you predicted is not default-deny; require the safe form instead.
if ! has 'let asset: PHAsset?' "$PICKER_CODE"; then
  note "PickedVideo.asset is no longer 'PHAsset?' — a provider-recovered pick cannot be represented."
fi
if ! has 'let localFile: URL?' "$PICKER_CODE"; then
  note "PickedVideo.localFile is gone — the recovered file has nowhere to live."
fi

if [ "$fail" -ne 0 ]; then
  echo ""
  echo "picker-recovery-gate: FAILED — a dropped pick could be silent again."
  exit 1
fi
echo "picker-recovery-gate: PASS — item-provider fallback wired, unrecoverable picks surfaced, read_auth measured, PickedVideo.asset optional."
