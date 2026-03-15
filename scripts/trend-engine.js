const scraper = require('./trend-scraper');
const analyzer = require('./trend-analyzer');
const aggregate = require('./trend-aggregate');

async function run() {
  const startTime = Date.now();
  console.log('========================================');
  console.log('  PROMPTLY TREND INTELLIGENCE ENGINE');
  console.log('========================================');
  console.log(`[trend-engine] Starting at ${new Date().toISOString()}`);
  console.log('');

  // ── Step 1: Scrape ──
  console.log('[trend-engine] ── Step 1: Scraping top-performing TikTok videos ──');
  let scrapeResult;
  try {
    scrapeResult = await scraper.run();
    console.log(`[trend-engine] Scrape complete: ${scrapeResult.inserted} new videos, ${scrapeResult.skipped} duplicates skipped, ${scrapeResult.uploadFailed} upload failures`);
  } catch (err) {
    console.error(`[trend-engine] Scraper FAILED: ${err.message}`);
    console.error('[trend-engine] Aborting pipeline — no new videos to analyze');
    process.exit(1);
  }

  if (scrapeResult.inserted === 0) {
    console.warn('[trend-engine] No new videos scraped — running analyzer on any remaining unanalyzed videos');
  }

  console.log('');

  // ── Step 2: Analyze ──
  console.log('[trend-engine] ── Step 2: Analyzing videos with Gemini ──');
  let analyzeResult;
  try {
    analyzeResult = await analyzer.run(scrapeResult.batchId);
    console.log(`[trend-engine] Analysis complete: ${analyzeResult.analyzed} analyzed, ${analyzeResult.failed} failed`);
  } catch (err) {
    console.error(`[trend-engine] Analyzer FAILED: ${err.message}`);
    console.error('[trend-engine] Proceeding to aggregation with existing data');
    analyzeResult = { analyzed: 0, failed: 0 };
  }

  console.log('');

  // ── Step 3: Aggregate ──
  console.log('[trend-engine] ── Step 3: Computing trend profile ──');
  let profile;
  try {
    profile = await aggregate.run();
    if (profile) {
      console.log(`[trend-engine] Profile computed: ${profile.sample_size} videos, valid until ${profile.valid_until}`);
    } else {
      console.warn('[trend-engine] No profile computed — insufficient data');
    }
  } catch (err) {
    console.error(`[trend-engine] Aggregation FAILED: ${err.message}`);
  }

  // ── Summary ──
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;

  console.log('');
  console.log('========================================');
  console.log('  TREND ENGINE COMPLETE');
  console.log('========================================');
  console.log(`[trend-engine] Total time: ${minutes}m ${seconds}s`);
  console.log(`[trend-engine] Videos scraped: ${scrapeResult?.inserted || 0}`);
  console.log(`[trend-engine] Videos analyzed: ${analyzeResult?.analyzed || 0}`);
  console.log(`[trend-engine] Analysis failures: ${analyzeResult?.failed || 0}`);
  console.log(`[trend-engine] Profile sample size: ${profile?.sample_size || 'N/A'}`);
  console.log(`[trend-engine] Finished at ${new Date().toISOString()}`);
}

// Run
run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`[trend-engine] Fatal error: ${err.message}`);
    process.exit(1);
  });
