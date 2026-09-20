#!/bin/bash
# upload-instrumentation-gate.sh — the upload event must carry its denominator.
#
# `upload_completed` carried `parts` and nothing else. So the one question anyone
# asks about an upload — how long did it take, for how many bytes — could not be
# answered from the data, and the ~30 seconds every user feels had no
# denominator. 8,229 upload_http_error rows in 14 days across 223 users, and no
# way to say whether a slow upload was a big file or a broken one.
#
# Four fields, and the reason each is separate:
#   bytes + duration_ms   sent RAW, never pre-divided into a throughput. A ratio
#                         computed here bakes in one reading; the raw pair can be
#                         cut by connection, build and part size afterwards. Same
#                         rule as saved_pct on the paywall — derive from the two
#                         real numbers, never assert the derived one.
#   parts                 what the old event had.
#   retries               CUMULATIVE, and it has to be: `partAttempts` is cleared
#                         the instant a part succeeds, so at completion it is
#                         empty. An upload that re-sent eleven parts and one that
#                         sailed through read identically without a separate
#                         tally — and the retry storm is the thing being sized.
#
# Exit 0 = clean. Exit 1 = the event has gone blind again.
set -uo pipefail
cd "$(dirname "$0")"
fail=0

python3 - <<'PY' || fail=1
import re, sys
SRC = 'Promptly/Services/ResumableMultipartUploader.swift'
src = open(SRC, encoding='utf8').read()

bad = []
i = src.find('Analytics.track("upload_completed"')
if i < 0:
    print('  FAIL  upload_completed is not emitted from the multipart path at all')
    sys.exit(1)
call = src[i:i+520]

for field in ['bytes', 'duration_ms', 'retries', 'parts']:
    if f'"{field}"' not in call:
        bad.append(f'upload_completed no longer carries `{field}` — the event cannot '
                   f'answer how long, how big, or how much re-sending')

# RAW PAIR, NOT A RATIO. A pre-divided throughput cannot be re-cut later.
if re.search(r'"(mbps|throughput|bytes_per|speed)"', call):
    bad.append('a pre-divided throughput is being sent. Send bytes and duration_ms '
               'raw; dividing here fixes one reading of a number that wants cutting '
               'by connection, build and part size.')

# The retry tally must be the CUMULATIVE map, not the live attempt map that is
# cleared on each part success.
if 'partRetries' not in call:
    bad.append('retries is not read from partRetries — partAttempts is cleared on '
               'every part success and is empty by completion, so it would always '
               'report 0')

# ...and that tally must actually be incremented somewhere, or it reports 0 forever.
if not re.search(r'partRetries\[[^\]]+,\s*default:\s*0\]\s*\+=\s*1', src):
    bad.append('partRetries is never incremented — the field would ship reading 0 on '
               'every upload, which is worse than absent because it looks measured')

# ...and cleared, or it leaks across uploads and over-reports the next one.
if 'partRetries.removeValue' not in src:
    bad.append('partRetries is never cleared, so a later upload inherits an earlier '
               "upload's retries")

# duration must be measured from the ledger's own start, not a local clock read
if 'timeIntervalSince(ledger.createdAt)' not in src:
    bad.append('duration_ms is not measured from ledger.createdAt — a resumed upload '
               'that survived an app kill would report only the final leg')

# ---- STAGE MARKS: a total cannot separate staging from transfer ----
# upload_completed answers "how long, for how many bytes". It cannot answer WHICH
# HALF was slow. UploadTiming carries that breakdown, but its transfer marks lived
# only in BackgroundUploadManager — so on the multipart path first_byte/last_byte
# were dark and the breakdown collapsed back to a total. Staging a copy nobody
# needed and a slow transfer are opposite fixes.
import os
MARK = lambda st: re.search(r'UploadTiming\.mark\([^)]*"' + st + r'"\)', src)
for stage in ['first_byte', 'last_byte']:
    if not MARK(stage):
        bad.append(f'the multipart path no longer marks `{stage}` — the transfer half '
                   f'of the breakdown goes dark and upload_timing collapses to a '
                   f'total, which cannot tell staging from transfer')

# ORDERING, not just presence. last_byte means the last byte of the FILE left the
# device. multipartComplete is a server round-trip retried up to
# maxCompleteAttempts; marking after it charges finalize latency to the transfer
# stage, and the breakdown then lies about which half to fix.
i_last = MARK('last_byte').start() if MARK('last_byte') else -1
i_done = src.find('APIService.shared.multipartComplete')
if i_last >= 0 and i_done >= 0 and i_last > i_done:
    bad.append('last_byte is marked AFTER multipartComplete, so the finalize '
               'round-trip and its retries are charged to transfer time')

# first_byte has to sit on the progress callback or it never fires at all.
i_send = src.find('func didSendBodyData(taskId:')
i_first = MARK('first_byte').start() if MARK('first_byte') else -1
if i_first >= 0 and (i_send < 0 or i_first < i_send):
    bad.append('first_byte is not marked inside didSendBodyData — it would never '
               'fire on the multipart path')

if 'msgIdByUpload' not in src:
    bad.append('the uploadId->messageId cache is gone — the ledger carries no '
               'messageId, so the marks would either not compile or force a disk '
               'read and JSON decode on every progress callback')

# CONSUMER HALF. Marks that are never finished accumulate and emit nothing, and a
# never-sent event is indistinguishable from a dropped one: both read as 0 rows.
try:
    ed = open('Promptly/Views/EditorView.swift', encoding='utf8').read()
    if 'UploadTiming.finish(' not in ed:
        bad.append('nothing calls UploadTiming.finish — every mark is recorded and no '
                   'upload_timing row is ever emitted')
except OSError:
    bad.append('EditorView.swift unreadable; cannot prove UploadTiming.finish is called')

# ...and the server must still accept it, or the rows are dropped on arrival.
srv = os.path.join('..', '..', 'server.js')
if os.path.exists(srv):
    if "'upload_timing'" not in open(srv, encoding='utf8').read():
        bad.append('upload_timing is not in the server event allowlist — rows would be '
                   'dropped on arrival and read as "never sent"')

if bad:
    print('upload-instrumentation-gate: FAIL')
    for b in bad: print('  -', b)
    sys.exit(1)
print('  upload_completed carries bytes, duration_ms, parts and retries; the pair is '
      'raw not pre-divided; the retry tally is cumulative, incremented and cleared; '
      'duration spans the whole upload including resumes.')
PY

[ "$fail" -eq 0 ] || { echo "upload-instrumentation-gate: FAIL"; exit 1; }
echo "upload-instrumentation-gate: PASS"
