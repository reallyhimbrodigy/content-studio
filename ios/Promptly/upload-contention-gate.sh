#!/bin/bash
# upload-contention-gate.sh — the uplink is one pipe, and we were filling it.
#
# 16 MiB parts x 6 parallel connections = 96 MB in flight on one phone's uplink,
# against a per-request idle timeout of 60s that was never raised when the
# RESOURCE timeout went to 30 minutes. Six PUTs competing for the same link
# starve each other until one goes 60s without a byte; it times out, retries, and
# re-enters the same contest.
#
# Measured, 14 days: 8,229 upload errors across 223 users and seven builds.
# 98.4% were status 0 — no HTTP response at all — on the multipart path, and MORE
# on wifi than cellular. Contention, not bandwidth.
#
# The four numbers this locks, and why each is a number and not a preference:
#   partSize x connections  must stay well under what a phone uplink can hold.
#   timeoutIntervalForRequest  must be SET. Inheriting 60s beside a 30-minute
#                              resource cap reads as considered and was not —
#                              and it is the timeout that actually fired.
#   singlePutCeiling        the never-worse fallback is only never-worse while
#                           the file can survive one request. 1,241 MB cannot.
#   maxInitAttempts         one transient init failure should not cost the whole
#                           resumable path.
set -uo pipefail
cd "$(dirname "$0")"
fail=0

python3 - <<'PY' || fail=1
import re, sys
def read(p): return open(p, encoding='utf8').read()
UP   = read('Promptly/Services/ResumableUpload.swift')
MP   = read('Promptly/Services/ResumableMultipartUploader.swift')
BG   = read('Promptly/Services/BackgroundUploadManager.swift')
API  = read('Promptly/Services/APIService.swift')
bad = []

def const(src, name, typ=r'Int64'):
    m = re.search(rf'static let {name}:\s*{typ}\s*=\s*([0-9]+)\s*\*\s*1024\s*\*\s*1024', src)
    if m: return int(m.group(1)) * 1024 * 1024
    m = re.search(rf'static let {name}(?::\s*\w+)?\s*=\s*([0-9]+)\b', src)
    return int(m.group(1)) if m else None

floor = const(UP, 's3MinPartSize')

# RESOLVE THE ALIAS. `defaultPartSize` is declared as `= s3MinPartSize`, not as
# a number, so the numeric regex returned None and the whole scan reported
# itself empty. It has been blind on this half for as long as that alias has
# existed.
part = const(UP, 'defaultPartSize')
if part is None and re.search(r'static let defaultPartSize(?::\s*\w+)?\s*=\s*s3MinPartSize', UP):
    part = floor

# BOUND THE KNOB'S WORST CASE, NOT TODAY'S LITERAL.
# This read `httpMaximumConnectionsPerHost = <digits>`. That line is now
# `= MultipartConfig.partsInFlight` — server-driven — so the digits regex found
# nothing and this half went blind too, at exactly the moment concurrency
# became tunable to 4-6. The number that matters is therefore the MOST the knob
# can ever serve, which is what the clamp guarantees.
conns = const(MP, 'maxPartsInFlight', typ=r'Int')
if conns is None:
    m = re.search(r'httpMaximumConnectionsPerHost\s*=\s*(\d+)', MP)
    if m: conns = int(m.group(1))

if part is None or conns is None or floor is None:
    bad.append('could not read partSize / connections / floor — the scan is empty, not clean')
else:
    inflight = part * conns
    if inflight > 32 * 1024 * 1024:
        bad.append(f'{part//1048576} MiB x {conns} connections = {inflight//1048576} MB in '
                   f'flight on one uplink. That contention IS the status-0 storm; keep it '
                   f'at or under 32 MB.')
    if part < floor:
        bad.append(f'part size {part} is below the {floor}-byte S3 floor — a middle part '
                   'would be short and only fail at complete')
    if conns < 1:
        bad.append('connections must be at least 1')

# The idle timeout must be EXPLICIT on both upload sessions, and must not be
# raised to the resource budget (an idle timeout that never fires cannot tell a
# slow connection from a dead one).
for name, src in (('multipart', MP), ('single-PUT', BG)):
    m = re.search(r'timeoutIntervalForRequest\s*=\s*(\d+)', src)
    if not m:
        bad.append(f'the {name} session does not SET timeoutIntervalForRequest — it '
                   'inherits 60s beside a 30-minute resource cap, which is the timeout '
                   'that actually fired and the one nobody chose')
    elif int(m.group(1)) > 600:
        bad.append(f'the {name} idle timeout is {m.group(1)}s — an idle timeout that never '
                   'fires cannot distinguish a slow part from a dead one')

# The fallback ceiling must exist and be enforced at the hinge.
ceil_v = const(MP, 'singlePutCeiling')
if ceil_v is None:
    bad.append('MultipartConfig.singlePutCeiling is gone — the never-worse fallback will '
               'again attempt a gigabyte as one PUT')
elif ceil_v > 200 * 1024 * 1024:
    bad.append(f'the single-PUT ceiling is {ceil_v//1048576} MB; a single request that '
               'large cannot be expected to survive without resumability')
if not re.search(r'size\s*>\s*MultipartConfig\.singlePutCeiling', API):
    bad.append('uploadSourceNeverWorse does not enforce the ceiling — the constant exists '
               'and nothing reads it, which is the inert-half shape')
if 'upload_fallback_refused' not in API:
    bad.append('a refusal is not reported. A silent refusal and the doomed attempt it '
               'replaced look identical in the data.')
if const(MP, 'maxInitAttempts') in (None, 1):
    bad.append('multipartInit is not retried before degrading, so one transient failure '
               'still costs the whole resumable path')
if not re.search(r'for attempt in 1\.\.\.MultipartConfig\.maxInitAttempts', API):
    bad.append('maxInitAttempts is declared but the init call does not loop on it')

if bad:
    print('upload-contention-gate: FAIL')
    for b in bad: print('  -', b)
    sys.exit(1)
print(f'  {part//1048576} MiB x {conns} = {part*conns//1048576} MB in flight; idle timeout '
      f'explicit on both sessions; single-PUT ceiling {ceil_v//1048576} MB enforced at the '
      f'hinge and reported; init retried before degrading.')
PY

[ "$fail" -eq 0 ] || { echo "upload-contention-gate: FAIL"; exit 1; }
echo "upload-contention-gate: PASS"
