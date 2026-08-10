#!/usr/bin/env node
'use strict';
/**
 * LANE 1 / JUDGE — one-shot loader: push out/fulfillment_scores.jsonl into the
 * fulfillment_scores table once TRUTH has applied the migration. Idempotent
 * (job_id PK + merge-duplicates upsert). Run: node scripts/load-scores-to-table.js
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local'), quiet: true });
if (!process.env.SUPABASE_URL) require('dotenv').config({ path: '/Users/zaclibman/content-studio/.env.local', quiet: true });
const URL_ = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'content-type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' };

(async () => {
  const jl = path.join(__dirname, '..', 'out', 'fulfillment_scores.jsonl');
  const rows = fs.readFileSync(jl, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  const dedup = [...new Map(rows.map(r => [r.job_id, r])).values()];
  console.log(`loading ${dedup.length} judgments (deduped from ${rows.length})…`);
  // table columns only (drop JSONL-only convenience fields)
  const cols = ['job_id','judged_at','judge_model','judge_version','is_preset','route','n_asks','n_honored',
    'n_dropped_with_note','n_dropped_silently','n_unsupported','honor_rate','asks','flags','vibe_input','change_request'];
  for (let i = 0; i < dedup.length; i += 500) {
    const batch = dedup.slice(i, i + 500).map(r => Object.fromEntries(cols.map(c => [c, r[c] ?? null])));
    const res = await fetch(`${URL_}/rest/v1/fulfillment_scores?on_conflict=job_id`, { method: 'POST', headers: H, body: JSON.stringify(batch) });
    if (!res.ok) throw new Error(`batch ${i}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    console.log(`  upserted ${Math.min(i + 500, dedup.length)}/${dedup.length}`);
  }
  console.log('done.');
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
