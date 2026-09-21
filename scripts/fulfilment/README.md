# Fulfilment lane — measurement scripts

READ-ONLY on Supabase. Haiku only. Never invokes the pipeline.

| script | what it does |
|---|---|
| `pull.js` | pages `video_jobs` for a 30-day window into JSONL. Read-only. |
| `oos_regex.js` | deterministic out-of-scope TOKEN scan. Recall, not judgement. |
| `classify.js` | D1 request classifier. Scan proposes, Haiku disposes. |
| `fulfilment_judge_v2.js` | D3 judge. Offline, on stored run records. |
| `red_proof_judge_v2.js` | D3's three planted drops. Run before trusting a number. |

`env.js` reads `content-studio/.env.local` at call time. No secret is stored here.
