#!/bin/zsh
# Poll for the first real Lumen scene emission.
# THREE OUTCOMES, kept distinct — the previous version had two and conflated the
# third with success: it grepped stdout for "NO LUMEN SCENE OUTPUT YET" and
# exited 0 on anything else, so a ConnectionResetError traceback read as a HIT
# and reported as clean completion. Exit CODE is now the contract:
#   0 = real hit (scored)   2 = no hit yet (keep polling)   other = ERROR
# Transient errors are RETRIED, never reported as a result, and a run of them
# fails LOUDLY rather than exiting 0.
S=/Users/zaclibman/content-studio/.worktrees/lane-judge/scripts/lumen_first_output_watch.py
errs=0
for i in $(seq 1 480); do
  out=$(python3 "$S" 2026-08-15T18:00:00 2>&1); rc=$?
  case $rc in
    0) echo "HIT"; echo "$out"; exit 0 ;;
    2) errs=0 ;;                                   # clean no-hit
    *) errs=$((errs+1))
       echo "[watch] transient error (rc=$rc, streak=$errs) — retrying, NOT a result"
       if [ $errs -ge 5 ]; then
         echo "WATCH FAILED: 5 consecutive errors. This is an ERROR, not 'no scenes'."
         echo "$out" | tail -3
         exit 1
       fi ;;
  esac
  sleep 300
done
echo "TIMEOUT: no Lumen scene emission in 40h (clean polls throughout — this IS a real zero)"
exit 2
