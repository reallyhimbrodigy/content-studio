// Simple smoke test for the design asset pipeline.
// Usage: node tools/design-pipeline-smoke.js post_graphic
const { createDesignAsset, getDesignAssetById } = require('../services/supabase-admin');
const { advanceDesignAssetPipeline } = require('../advanceDesignAssetPipeline');

async function main() {
  const type = process.argv[2] || 'post_graphic';
  const userId = process.env.SMOKE_USER_ID || process.env.TEST_USER_ID || '';
  const calendarDayId = `smoke-${Date.now()}`;
  if (!userId) {
    console.error('Set SMOKE_USER_ID to a valid Supabase user id');
    process.exit(1);
  }
  console.log('[Smoke] Creating design asset', { type, userId, calendarDayId });
  const asset = await createDesignAsset({
    type,
    user_id: userId,
    calendar_day_id: calendarDayId,
    data: { title: 'Smoke Test', subtitle: 'Pipeline', cta: 'Test' },
    status: 'queued',
  });
  console.log('[Smoke] Created asset', asset.id);
  let attempt = 0;
  const maxAttempts = 30;
  while (attempt < maxAttempts) {
    attempt += 1;
    await advanceDesignAssetPipeline();
    const refreshed = await getDesignAssetById(asset.id);
    console.log(`[Smoke] Attempt ${attempt} status=${refreshed.status} render=${refreshed.placid_render_id} preview=${refreshed.data?.preview_url || ''}`);
    if (refreshed.status === 'ready') {
      console.log('[Smoke] SUCCESS');
      process.exit(0);
    }
    if (refreshed.status === 'failed') {
      console.error('[Smoke] FAILED');
      process.exit(1);
    }
    await new Promise((res) => setTimeout(res, 2000));
  }
  console.error('[Smoke] Timed out without ready status');
  process.exit(1);
}

main().catch((err) => {
  console.error('[Smoke] Error', err);
  process.exit(1);
});
