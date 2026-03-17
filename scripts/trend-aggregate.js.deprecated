const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const DATA_WINDOW_DAYS = 14;

// ── Utility functions ──

function percentile(sortedArr, p) {
  // p is 0-1 (e.g., 0.25 for p25)
  if (sortedArr.length === 0) return null;
  if (sortedArr.length === 1) return sortedArr[0];
  const index = (sortedArr.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sortedArr[lower];
  return sortedArr[lower] + (sortedArr[upper] - sortedArr[lower]) * (index - lower);
}

function computePercentiles(values) {
  // Filter out nulls/undefined, sort numerically, compute p25/median/p75
  const clean = values.filter((v) => v !== null && v !== undefined && typeof v === 'number');
  if (clean.length === 0) return { p25: null, median: null, p75: null, sample: 0 };
  clean.sort((a, b) => a - b);
  return {
    p25: Math.round(percentile(clean, 0.25) * 100) / 100,
    median: Math.round(percentile(clean, 0.5) * 100) / 100,
    p75: Math.round(percentile(clean, 0.75) * 100) / 100,
    sample: clean.length,
  };
}

function computeFrequency(values) {
  // Count occurrences of each value, return as { value: fraction }
  const clean = values.filter((v) => v !== null && v !== undefined);
  if (clean.length === 0) return {};
  const counts = {};
  for (const v of clean) {
    counts[v] = (counts[v] || 0) + 1;
  }
  const result = {};
  for (const [key, count] of Object.entries(counts)) {
    result[key] = Math.round((count / clean.length) * 100) / 100;
  }
  return result;
}

function computeBooleanRate(values) {
  // What percentage of values are true
  const clean = values.filter((v) => v === true || v === false);
  if (clean.length === 0) return null;
  const trueCount = clean.filter((v) => v === true).length;
  return Math.round((trueCount / clean.length) * 100) / 100;
}

// ── Field extraction helpers ──
// Each function takes an analysis_json object and extracts a specific value
// These are defensive — if a field is missing, they return null

function safeGet(obj, ...keys) {
  let current = obj;
  for (const key of keys) {
    if (current === null || current === undefined) return null;
    current = current[key];
  }
  return current;
}

// ── Main aggregation ──

async function run() {
  console.log(`[aggregate] Computing trend profile from last ${DATA_WINDOW_DAYS} days of data...`);

  // Query all analyses from the data window, joined with trend_videos for scraped_at
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - DATA_WINDOW_DAYS);

  const { data: analyses, error } = await supabase
    .from('trend_analyses')
    .select('analysis_json, trend_video_id, trend_videos!inner(scraped_at, view_count)')
    .gte('trend_videos.scraped_at', cutoffDate.toISOString());

  if (error) {
    console.error(`[aggregate] Query failed: ${error.message}`);
    process.exit(1);
  }

  if (!analyses || analyses.length === 0) {
    console.log('[aggregate] No analyses found in data window — skipping profile computation');
    return null;
  }

  console.log(`[aggregate] Found ${analyses.length} analyses in ${DATA_WINDOW_DAYS}-day window`);

  // Extract all analysis_json objects
  const items = analyses.map((a) => a.analysis_json).filter(Boolean);

  if (items.length < 10) {
    console.warn(`[aggregate] WARNING: Only ${items.length} valid analyses — profile may not be statistically meaningful`);
  }

  // ── Compute numeric patterns ──

  const numericPatterns = {
    time_to_first_cut: computePercentiles(items.map((i) => safeGet(i, 'cuts', 'time_to_first_cut_seconds'))),
    avg_cut_duration: computePercentiles(items.map((i) => {
      const total = safeGet(i, 'cuts', 'total_count');
      const duration = safeGet(i, 'video_duration_seconds');
      if (!total || !duration || total === 0) return null;
      return Math.round((duration / total) * 100) / 100;
    })),
    cuts_in_first_3s: computePercentiles(items.map((i) => safeGet(i, 'cuts', 'cuts_in_first_3_seconds'))),
    cuts_in_first_5s: computePercentiles(items.map((i) => safeGet(i, 'cuts', 'cuts_in_first_5_seconds'))),
    total_cuts: computePercentiles(items.map((i) => safeGet(i, 'cuts', 'total_count'))),
    hook_timing: computePercentiles(items.map((i) => safeGet(i, 'hook', 'timing_seconds'))),
    text_first_appearance: computePercentiles(items.map((i) => safeGet(i, 'text_on_screen', 'first_text_appears_at_seconds'))),
    text_overlay_count: computePercentiles(items.map((i) => safeGet(i, 'text_on_screen', 'text_element_count'))),
    broll_ratio: computePercentiles(items.map((i) => safeGet(i, 'broll', 'broll_ratio'))),
    broll_clip_count: computePercentiles(items.map((i) => safeGet(i, 'broll', 'broll_clip_count'))),
    broll_duration_avg: computePercentiles(items.map((i) => {
      const count = safeGet(i, 'broll', 'broll_clip_count');
      const total = safeGet(i, 'broll', 'broll_total_seconds');
      if (!count || !total || count === 0) return null;
      return Math.round((total / count) * 100) / 100;
    })),
    zoom_movement_count: computePercentiles(items.map((i) => safeGet(i, 'framing_and_movement', 'zoom_movement_count'))),
    sound_effect_count: computePercentiles(items.map((i) => safeGet(i, 'audio', 'sound_effect_count'))),
    speed_change_count: computePercentiles(items.map((i) => safeGet(i, 'speed', 'speed_change_count'))),
    video_duration: computePercentiles(items.map((i) => safeGet(i, 'video_duration_seconds'))),
    hard_cut_percentage: computePercentiles(items.map((i) => safeGet(i, 'transitions', 'hard_cut_percentage'))),
    transition_effect_count: computePercentiles(items.map((i) => safeGet(i, 'transitions', 'total_transition_count'))),
  };

  // ── Compute categorical patterns ──

  const categoricalPatterns = {
    hook_type: computeFrequency(items.map((i) => safeGet(i, 'hook', 'type'))),
    primary_shot_type: computeFrequency(items.map((i) => safeGet(i, 'framing_and_movement', 'primary_shot_type'))),
    color_tone: computeFrequency(items.map((i) => safeGet(i, 'color_and_grade', 'overall_tone'))),
    ending_type: computeFrequency(items.map((i) => safeGet(i, 'ending', 'type'))),
    music_energy: computeFrequency(items.map((i) => safeGet(i, 'audio', 'music_energy_level'))),
    editing_intensity: computeFrequency(items.map((i) => safeGet(i, 'overall_production', 'editing_intensity'))),
    text_positions: computeFrequency(items.flatMap((i) => safeGet(i, 'text_on_screen', 'text_positions') || [])),
  };

  // ── Compute boolean patterns ──

  const booleanPatterns = {
    has_background_music: computeBooleanRate(items.map((i) => safeGet(i, 'audio', 'has_background_music'))),
    has_sound_effects: computeBooleanRate(items.map((i) => safeGet(i, 'audio', 'has_sound_effects'))),
    sfx_at_transitions: computeBooleanRate(items.map((i) => safeGet(i, 'audio', 'sfx_at_transitions'))),
    sfx_on_text: computeBooleanRate(items.map((i) => safeGet(i, 'audio', 'sfx_on_text'))),
    sfx_on_emphasis: computeBooleanRate(items.map((i) => safeGet(i, 'audio', 'sfx_on_emphasis'))),
    speaks_to_camera: computeBooleanRate(items.map((i) => safeGet(i, 'audio', 'speaks_to_camera'))),
    audio_feels_clean: computeBooleanRate(items.map((i) => safeGet(i, 'audio', 'audio_feels_clean'))),
    has_zoom_movements: computeBooleanRate(items.map((i) => safeGet(i, 'framing_and_movement', 'has_zoom_movements'))),
    has_cut_zoom: computeBooleanRate(items.map((i) => safeGet(i, 'framing_and_movement', 'has_cut_zoom'))),
    framing_changes_at_cuts: computeBooleanRate(items.map((i) => safeGet(i, 'framing_and_movement', 'framing_changes_at_cuts'))),
    has_transition_variety: computeBooleanRate(items.map((i) => safeGet(i, 'transitions', 'has_variety'))),
    has_speed_changes: computeBooleanRate(items.map((i) => safeGet(i, 'speed', 'has_speed_changes'))),
    has_speed_ramp: computeBooleanRate(items.map((i) => safeGet(i, 'speed', 'has_speed_ramp'))),
    base_speed_accelerated: computeBooleanRate(items.map((i) => safeGet(i, 'speed', 'base_speed_feels_accelerated'))),
    has_text: computeBooleanRate(items.map((i) => safeGet(i, 'text_on_screen', 'has_text'))),
    has_animated_captions: computeBooleanRate(items.map((i) => safeGet(i, 'text_on_screen', 'has_animated_captions'))),
    text_reinforces_speech: computeBooleanRate(items.map((i) => safeGet(i, 'text_on_screen', 'text_reinforces_speech'))),
    has_hook_text: computeBooleanRate(items.map((i) => safeGet(i, 'text_on_screen', 'has_hook_text'))),
    has_cta_text: computeBooleanRate(items.map((i) => safeGet(i, 'text_on_screen', 'has_cta_text'))),
    has_broll: computeBooleanRate(items.map((i) => safeGet(i, 'broll', 'has_broll'))),
    looks_color_graded: computeBooleanRate(items.map((i) => safeGet(i, 'color_and_grade', 'looks_color_graded'))),
    has_vignette: computeBooleanRate(items.map((i) => safeGet(i, 'color_and_grade', 'has_vignette'))),
    has_cta_at_end: computeBooleanRate(items.map((i) => safeGet(i, 'ending', 'has_cta_at_end'))),
    loops_cleanly: computeBooleanRate(items.map((i) => safeGet(i, 'ending', 'loops_cleanly'))),
    feels_professionally_edited: computeBooleanRate(items.map((i) => safeGet(i, 'overall_production', 'feels_professionally_edited'))),
  };

  // ── Build the profile ──

  const validUntil = new Date();
  validUntil.setDate(validUntil.getDate() + 7);

  const profile = {
    profile_type: 'general',
    computed_at: new Date().toISOString(),
    sample_size: items.length,
    valid_until: validUntil.toISOString(),
    data_window_days: DATA_WINDOW_DAYS,
    numeric_patterns: numericPatterns,
    categorical_patterns: categoricalPatterns,
    boolean_patterns: booleanPatterns,
  };

  // ── Insert into trend_profiles ──

  const { error: insertError } = await supabase.from('trend_profiles').insert({
    profile_type: 'general',
    sample_size: items.length,
    profile_json: profile,
    computed_at: new Date().toISOString(),
    valid_until: validUntil.toISOString(),
  });

  if (insertError) {
    console.error(`[aggregate] Failed to insert profile: ${insertError.message}`);
    process.exit(1);
  }

  console.log('[aggregate] Profile computed and stored:');
  console.log(`[aggregate]   Sample size: ${items.length} videos`);
  console.log(`[aggregate]   Data window: ${DATA_WINDOW_DAYS} days`);
  console.log(`[aggregate]   Valid until: ${validUntil.toISOString()}`);
  console.log(`[aggregate]   Numeric fields: ${Object.keys(numericPatterns).length}`);
  console.log(`[aggregate]   Categorical fields: ${Object.keys(categoricalPatterns).length}`);
  console.log(`[aggregate]   Boolean fields: ${Object.keys(booleanPatterns).length}`);

  // Log a few key stats for quick sanity check
  console.log('[aggregate]   Key stats:');
  console.log(`[aggregate]     Median cuts per video: ${numericPatterns.total_cuts.median}`);
  console.log(`[aggregate]     Median time to first cut: ${numericPatterns.time_to_first_cut.median}s`);
  console.log(`[aggregate]     Has background music: ${(booleanPatterns.has_background_music * 100).toFixed(0)}%`);
  console.log(`[aggregate]     Has sound effects: ${(booleanPatterns.has_sound_effects * 100).toFixed(0)}%`);
  console.log(`[aggregate]     Has cut zoom: ${(booleanPatterns.has_cut_zoom * 100).toFixed(0)}%`);
  console.log(`[aggregate]     Loops cleanly: ${(booleanPatterns.loops_cleanly * 100).toFixed(0)}%`);
  console.log(`[aggregate]     Feels professionally edited: ${(booleanPatterns.feels_professionally_edited * 100).toFixed(0)}%`);

  return profile;
}

// Run if called directly
if (require.main === module) {
  run()
    .then((profile) => {
      if (profile) {
        console.log('[aggregate] Complete');
      }
      process.exit(0);
    })
    .catch((err) => {
      console.error('[aggregate] Fatal error:', err);
      process.exit(1);
    });
}

module.exports = { run };
