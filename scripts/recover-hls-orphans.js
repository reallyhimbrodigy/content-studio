#!/usr/bin/env node
// Recover HLS-window orphans: renders that exist in S3 but whose job never got
// rendered_video_url (the dispatch tail threw on missing hls BEFORE the delivery
// write; the presigned URL was a transient variable, never persisted to the
// column OR to result{}, so the reconciler — which projects from result{} — could
// not recover them). Ground truth is S3, not the DB.
//
// MUST run where S3 creds live (Render env or a machine with AWS_ACCESS_KEY_ID /
// AWS_SECRET_ACCESS_KEY / S3_BUCKET_NAME). Frontend could not run it — no local
// S3 creds. Read-only S3 (ListObjectsV2); the only writes are re-linking the URL
// onto the job. Idempotent: skips jobs that already have a URL.
//
// Render output key pattern: renders/<jobId>/<timestamp>-edited.mp4
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });
const { supabaseAdmin } = require('../services/supabase-admin');
const s3 = require('../services/s3');
const { pickPlayableOutput } = require('../lib/playable-output');
const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');

const DRY_RUN = process.env.RECOVER_DRY_RUN !== '0'; // default dry-run; set 0 to write
const SINCE = process.env.RECOVER_SINCE || '2026-08-03T11:30:00Z';

if (!s3.isConfigured || !s3.isConfigured()) {
  console.error('[recover] S3 not configured — run this where S3 creds exist. Aborting.');
  process.exit(2);
}
const client = new S3Client({ region: s3.AWS_REGION });

async function renderKeyFor(jobId) {
  // Resolve via the SHARED helper. This function previously matched /\.mp4$/i
  // and sorted by NEWEST, which picked `<job>-hls/stream_1080p/init.mp4` — a
  // 0-byte HLS init segment — over the real `-edited.mp4`, because the HLS
  // artifacts are written AFTER the deliverable. It then wrote that key's URL
  // into the job row, so a user would have received a 0-byte file as their
  // video. Same bug was later written twice more in verification probes;
  // lib/playable-output.js exists so there is no fourth site.
  const out = await client.send(new ListObjectsV2Command({
    Bucket: s3.S3_BUCKET, Prefix: `renders/${jobId}/`, MaxKeys: 100,
  }));
  const picked = pickPlayableOutput(out.Contents || []);
  return picked ? picked.key : null;
}

(async () => {
  // Candidates: jobs since the window with NO delivery URL (failed OR completed),
  // regardless of error_code — S3 is the arbiter of whether a render exists.
  const { data: jobs, error } = await supabaseAdmin
    .from('video_jobs')
    .select('id, user_id, status, rendered_video_url, hls_manifest_url')
    .gte('created_at', SINCE)
    .is('rendered_video_url', null)
    .limit(1000);
  if (error) { console.error('[recover] query failed:', error.message); process.exit(2); }
  const candidates = (jobs || []).filter((j) => !j.hls_manifest_url);
  console.log(`[recover] ${DRY_RUN ? 'DRY-RUN' : 'LIVE'} — ${candidates.length} candidates with no delivery URL since ${SINCE}`);

  let recovered = 0, noRender = 0;
  for (const j of candidates) {
    const key = await renderKeyFor(j.id);
    if (!key) { noRender++; continue; }
    // Render EXISTS in S3 but the job has no URL → ORPHAN. Re-link.
    const url = await s3.createPresignedGetUrl(key, 60 * 60 * 24 * 7);
    console.log(`[recover] ORPHAN ${j.id} (status=${j.status}) → ${key}`);
    if (!DRY_RUN) {
      const { error: uErr } = await supabaseAdmin.from('video_jobs').update({
        rendered_video_url: url,
        status: 'completed',
        current_step: 'complete',
        step_message: 'Your video is ready!',
        progress: 100,
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq('id', j.id);
      if (uErr) console.error(`[recover] re-link FAILED ${j.id}: ${uErr.message}`);
      else recovered++;
    } else {
      recovered++;
    }
  }
  console.log(`\n[recover] ORPHANS ${DRY_RUN ? 'found (would re-link)' : 're-linked'}: ${recovered} | candidates with NO S3 render (genuine failures): ${noRender}`);
  console.log(DRY_RUN ? '[recover] DRY-RUN — set RECOVER_DRY_RUN=0 to write the re-links.' : '[recover] DONE — orphans delivered (refund kept, video now in library).');
})().catch((e) => { console.error('[recover] fatal:', e && e.message); process.exit(2); });
