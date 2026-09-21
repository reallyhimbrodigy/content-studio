#!/bin/bash
# install-hooks.sh — install the MACHINE-LEVEL hook shims. Run once per clone.
#
#     bash scripts/install-hooks.sh
#
# TWO LAYERS, AND THE SPLIT IS THE POINT.
#
#   OWNERSHIP is machine-level. It lives in the repo's COMMON hooks dir — one
#   per repo, shared by every worktree, unaffected by what any tree has checked
#   out. It cannot age out of a branch.
#
#   LANE GATES stay tracked in .githooks and version with the branch. The shim
#   reaches them by delegation and passes their exit code through unchanged.
#
# WHY IT HAD TO MOVE. The ownership check first shipped inside
# .githooks/pre-commit with core.hooksPath=.githooks. That path resolves PER
# WORKTREE against that tree's own checked-out files, so any worktree sitting on
# a commit older than the one that added the check ran the OLD hook and had no
# ownership check at all. Proven, not inferred: a commit as the wrong owner in
# content-studio-87's tree at 0b42f4e was ALLOWED. The tree the gate was written
# for, and the tree about to be branched from it, were both unprotected — the
# enforcement existed and did not reach the tree that needed it, which is the
# same shape as the failure it was written to stop.
#
# A CLONE WITHOUT THIS SCRIPT IS UNCLAIMED AND COMMITS FREELY. That is the
# design, not a gap: nothing bricks on the day it lands, and a tree only becomes
# protected once someone claims it with a .lane-owner file.
set -uo pipefail

root="$(git rev-parse --show-toplevel)" || { echo "not a git repo" >&2; exit 1; }
common="$(cd "$(git -C "$root" rev-parse --git-common-dir)" && pwd)"
hooks="$common/hooks"
mkdir -p "$hooks"

# core.hooksPath would override the common dir and re-introduce the per-worktree
# aging this whole file exists to remove.
if git -C "$root" config --get core.hooksPath >/dev/null 2>&1; then
  git -C "$root" config --unset core.hooksPath
  echo "install-hooks: unset core.hooksPath (it shadowed the common hooks dir)"
fi

# ---- pre-commit: ownership, then delegate -----------------------------------
cat > "$hooks/pre-commit" <<'SHIM'
#!/bin/bash
# MACHINE-LEVEL pre-commit. Installed by scripts/install-hooks.sh; NOT tracked,
# and deliberately so — it must not change when a worktree checks out an older
# commit. Does the ownership check and NOTHING else, then hands off.
set -uo pipefail
root="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0

# ---- one owner per checkout -------------------------------------------------
# 2026-09-21: a session needed a branch and, instead of `git worktree add`, ran
# `git checkout -b` inside another session's checkout. That moved the owner's
# tree off release/256 — the branch build 256 had been archived and submitted
# from minutes earlier. Nothing was lost because the tree happened to be clean.
# Mid-edit it would have been. No rule was broken: "every agent works in its own
# worktree" sat in three documents and was enforced by nothing.
#
# An UNCLAIMED tree (no .lane-owner) commits freely, so a fresh clone is never
# bricked. An UNSET $LANE_OWNER in a CLAIMED tree is refused, because "I did not
# say who I am" must not resolve to "I am whoever owns this".
if [ -f "$root/.lane-owner" ]; then
  owner="$(tr -d ' \t\r\n' < "$root/.lane-owner")"
  if [ -n "$owner" ]; then
    me="${LANE_OWNER:-}"
    if [ -z "$me" ]; then
      echo "pre-commit: REFUSED — this checkout belongs to '$owner' and you have not said who you are." >&2
      echo "   $root" >&2
      echo "   Set LANE_OWNER, or make your own:  git worktree add ../content-studio-<you> -b <branch>" >&2
      exit 1
    fi
    if [ "$me" != "$owner" ]; then
      echo "pre-commit: REFUSED — wrong checkout." >&2
      echo "   this tree is owned by : $owner" >&2
      echo "   you are               : $me" >&2
      echo "   $root" >&2
      echo "   Committing here puts your work on someone else's branch, and checking out" >&2
      echo "   your own moves their tree under them mid-edit. Make your own instead:" >&2
      echo "     git worktree add ../content-studio-$me -b <branch>" >&2
      exit 1
    fi
  fi
fi

# ---- delegate to the branch's own tracked gates -----------------------------
# Same exit code, unchanged. A tree whose branch has no .githooks/pre-commit
# (release/256, for one) simply has no lane gates — that is the branch's state,
# not this shim's business.
if [ -x "$root/.githooks/pre-commit" ]; then
  "$root/.githooks/pre-commit" "$@"
  exit $?
elif [ -f "$root/.githooks/pre-commit" ]; then
  bash "$root/.githooks/pre-commit" "$@"
  exit $?
fi
exit 0
SHIM
chmod +x "$hooks/pre-commit"
echo "install-hooks: pre-commit  -> $hooks/pre-commit  (ownership + delegate)"

# ---- every other tracked hook: pure delegation ------------------------------
# WITHOUT THIS, unsetting core.hooksPath SILENTLY DISABLES pre-push — the quiet
# window gate that refuses a deploy while user jobs are in flight. Moving one
# hook must not turn off the others.
for src in "$root"/.githooks/*; do
  [ -e "$src" ] || continue
  name="$(basename "$src")"
  [ "$name" = "pre-commit" ] && continue
  cat > "$hooks/$name" <<SHIM2
#!/bin/bash
# MACHINE-LEVEL delegating shim for '$name'. Installed by scripts/install-hooks.sh.
# Exists so unsetting core.hooksPath does not silently disable the branch's own
# tracked hooks — notably pre-push, which holds the deploy quiet window.
set -uo pipefail
root="\$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
if [ -x "\$root/.githooks/$name" ]; then exec "\$root/.githooks/$name" "\$@"; fi
if [ -f "\$root/.githooks/$name" ]; then exec bash "\$root/.githooks/$name" "\$@"; fi
exit 0
SHIM2
  chmod +x "$hooks/$name"
  echo "install-hooks: $name -> delegates to the branch's .githooks/$name"
done

echo "install-hooks: done. core.hooksPath is $(git -C "$root" config --get core.hooksPath >/dev/null 2>&1 && echo SET || echo unset) — the common dir is authoritative."
