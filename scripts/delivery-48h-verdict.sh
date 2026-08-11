#!/bin/zsh
# JUDGE — 48h completion_delivery verdict. Column landed 2026-08-11T19:50:15Z.
set -a; source /Users/zaclibman/content-studio/.env.local; set +a
U="${SUPABASE_URL%/}/rest/v1"; K="$SUPABASE_SERVICE_ROLE_KEY"
curl -s --max-time 30 "$U/video_jobs?select=status,completion_delivery,created_at,completed_at&created_at=gte.2026-08-11T19:50:00&status=in.(completed,failed)&limit=1000" \
  -H "apikey: $K" -H "Authorization: Bearer $K" | python3 -c "
import json,sys,datetime,statistics
from collections import Counter
rows=json.load(sys.stdin)
print('=== JUDGE 48h DELIVERY VERDICT ===')
print('window: 2026-08-11T19:50Z -> now   terminal rows n=%d' % len(rows))
d=Counter((r.get('completion_delivery') or 'NULL') for r in rows)
print('completion_delivery:', dict(d))
tot=sum(d.values()) or 1
fb=d.get('fallback_timer',0)
print('fallback_timer share: %.1f%% (%d)  [PASS bar: ~0]' % (100*fb/tot, fb))
def ts(s): return datetime.datetime.fromisoformat(s.replace('Z','+00:00'))
e=sorted((ts(r['completed_at'])-ts(r['created_at'])).total_seconds() for r in rows if r.get('completed_at') and r['status']=='completed')
if e:
    print('e2e p50=%.0fs p90=%.0fs p99=%.0fs max=%.0fs  [laws p50<=90 p99<=180]' % (statistics.median(e), e[int(.9*len(e))], e[int(.99*len(e))], e[-1]))
    print('on the 900s wall [870,920]: %d of %d' % (sum(1 for s in e if 870<=s<=920), len(e)))
# DENOMINATOR FLOOR (Rule 5): a zero out of a thin sample is not a result.
# 100 terminal rows is the floor for any verdict at all — n=2 'PASS' is the
# small-sample-zero trap this lane exists to prevent.
MIN_N=100
if len(rows) < MIN_N:
    print('VERDICT: NOT YET READABLE — n=%d < %d terminal rows. No verdict on a thin sample.' % (len(rows), MIN_N))
elif fb/tot < 0.02 and e and e[int(.99*len(e))] < 870:
    print('VERDICT: PASS — fallback_timer ~0 and p99 off the 900s wall')
else:
    print('VERDICT: FAIL — see numbers above')
"
