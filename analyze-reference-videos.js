/**
 * analyze-reference-videos.js
 *
 * Standalone script that:
 * 1. Reads reference videos from ./reference-videos/
 * 2. Uploads each to Gemini and gets structured editing analysis
 * 3. Aggregates analyses into a rich style guide
 * 4. Writes the style guide to Supabase trend_profiles table
 *
 * Usage:
 *   GEMINI_API_KEY=xxx SUPABASE_URL=xxx SUPABASE_SERVICE_KEY=xxx node analyze-reference-videos.js
 */

const { GoogleGenerativeAI, FileState } = require("@google/generative-ai");
const { createClient } = require("@supabase/supabase-js");
const fs = require("fs");
const path = require("path");

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
const REFERENCE_DIR = path.join(__dirname, "reference-videos");
const MANIFEST_PATH = path.join(REFERENCE_DIR, "manifest.json");
const VALID_DAYS = 30;

if (!GEMINI_API_KEY) { console.error("Missing GEMINI_API_KEY"); process.exit(1); }
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY"); process.exit(1); }

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function analyzeVideo(videoPath, metadata) {
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-pro-preview" });
  const fileManager = genAI.getFileManager();

  console.log(`  Uploading ${path.basename(videoPath)} to Gemini...`);
  const uploadResult = await fileManager.uploadFile(videoPath, {
    mimeType: "video/mp4",
    displayName: path.basename(videoPath),
  });

  let file = uploadResult.file;
  let attempts = 0;
  while (file.state === FileState.PROCESSING && attempts < 60) {
    await new Promise((r) => setTimeout(r, 3000));
    file = await fileManager.getFile(file.name);
    attempts++;
  }

  if (file.state !== FileState.ACTIVE) {
    console.log(`  Video failed to process (state: ${file.state}), skipping`);
    return null;
  }

  console.log(`  Video active. Asking Gemini to analyze...`);

  const prompt = `You are analyzing a high-performing short-form video (${metadata.views || "viral"}) to extract editing patterns. This video was manually selected as a PERFECT example of professional editing.

${metadata.why_included ? `The person who selected this video says: "${metadata.why_included}"` : ""}
${metadata.description ? `Video description: "${metadata.description}"` : ""}
${metadata.tags ? `Focus areas: ${metadata.tags.join(", ")}` : ""}

Watch the ENTIRE video carefully — every second matters. Analyze these specific editing elements:

1. HOOK (first 1-3 seconds):
   - How does it grab attention?
   - Is there text in the first frame?
   - How quickly does content start?

2. CUT PATTERNS:
   - How many cuts total?
   - Average time between cuts
   - Do cuts accelerate toward the end?
   - Jump cuts — how are they used?

3. SPEED RAMPING:
   - Does the video use speed changes? If yes, this is CRITICAL — analyze in detail.
   - EXACTLY where do speed changes happen? What words/moments?
   - What gets sped up? (setup, transitions, filler phrases)
   - What gets slowed down? (punchlines, key words, reveals)
   - How dramatic are the changes? (estimate the speed multipliers)
   - Does the pitch shift? (high pitch on fast, deep on slow)
   - What's the overall rhythm pattern?

4. CAPTIONS/TEXT:
   - Caption style (word-by-word highlight, single word pop, two-line, boxed, minimal, hormozi-style bold)
   - Font size and position?
   - Any keyword highlighting? What color?
   - Do captions have animation?

5. SOUND EFFECTS:
   - Types used (ching, pop, swoosh, ding, whoosh, etc.)
   - What triggers each sound? (specific words, cuts, visual changes)
   - How many total?

6. TEXT OVERLAYS (separate from captions):
   - What text appears on screen?
   - Position, timing, style?

7. PACING/ENERGY:
   - How does energy flow? (constant, building, peaks and valleys)
   - Any pauses for emphasis?
   - How does it end?

8. COLOR/LOOK:
   - Color grade style (warm, cool, punchy, moody, clean, natural)

9. ZOOM/CAMERA:
   - Zoom effects? (slow zoom, cut zoom, static)

Respond with a structured analysis in this EXACT JSON format:
{
  "hook_type": "text_hook|direct_address|visual_surprise|action_in_progress|pattern_interrupt",
  "hook_description": "how the hook works",
  "total_cuts": 0,
  "avg_cut_interval_seconds": 0,
  "cuts_accelerate": false,
  "has_speed_ramping": false,
  "speed_ramp_details": "detailed description of speed ramping patterns, or null",
  "speed_ramp_moments": [
    {"time_seconds": 0, "description": "what happens", "type": "slowdown|speedup", "estimated_speed": 1.0}
  ],
  "caption_style": "word_highlight|single_word|two_line|boxed|minimal|hormozi|none",
  "caption_details": "description",
  "sound_effects_used": [
    {"type": "ching|pop|swoosh|ding", "trigger": "what moment", "time_seconds": 0}
  ],
  "text_overlays_used": [
    {"text": "what it says", "position": "top|center|bottom", "time_seconds": 0}
  ],
  "pacing": "fast_throughout|builds|peaks_and_valleys|slow_deliberate",
  "energy_curve": "description",
  "color_look": "warm|cool|punchy|moody|clean|natural|cinematic",
  "has_zoom": false,
  "zoom_details": "description or null",
  "what_makes_it_work": "2-3 sentence summary of WHY this video's editing is excellent"
}

Respond ONLY with JSON. No markdown, no backticks, no preamble.`;

  const result = await model.generateContent([
    { fileData: { mimeType: file.mimeType, fileUri: file.uri } },
    { text: prompt },
  ]);

  const text = result.response.text().trim();

  try {
    const clean = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const parsed = JSON.parse(clean);
    parsed._source = "manual_reference";
    parsed._filename = path.basename(videoPath);
    parsed._why_included = metadata.why_included || "";
    parsed._tags = metadata.tags || [];
    return parsed;
  } catch (e) {
    console.log(`  Failed to parse Gemini response: ${e.message}`);
    console.log(`  Raw (first 500 chars): ${text.substring(0, 500)}`);
    return null;
  }
}

async function aggregateStyleGuide(analyses) {
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-pro-preview" });

  const prompt = `You are a senior short-form video editor and creative director. Below are detailed analyses of ${analyses.length} manually curated reference videos — these are PERFECT examples of what professionally edited short-form content should look and feel like.

Your job: synthesize these into a concise, actionable EDITING STYLE GUIDE that another AI video editor will follow when editing new videos. The AI editor will read this guide before making any editing decisions.

The guide MUST cover (in this order):

1. HOOKS — how to start videos based on what works in these examples
2. CUT PACING — specific numbers: how many cuts, how often, whether to accelerate
3. SPEED RAMPING — THIS IS CRITICAL. If any reference videos use speed ramping, describe the EXACT technique in detail:
   - What gets sped up (setup phrases, filler, transitions)
   - What gets slowed down (punchlines, reveals, key words)
   - What speed values work (1.2x-1.5x for fast, 0.7x-0.85x for slow)
   - The rhythm pattern (fast→slow snap, build→release)
   - How speed changes create comedy timing and emphasis
   - When NOT to use speed ramping
4. CAPTIONS — which styles work, positioning, highlighting
5. SOUND EFFECTS — when to use them, which types, what triggers them
6. TEXT OVERLAYS — when and how to use them
7. PACING/ENERGY — how energy should flow through a video
8. COLOR — what looks are working
9. THE #1 RULE — the single most important editing principle these videos share

Be SPECIFIC. Use actual numbers and timecodes. Reference specific patterns you see across the reference videos. This guide will be read by an AI that edits videos — vague advice is useless, concrete technique descriptions are gold.

Write it as direct prose — like you're briefing an editor before their first day. No JSON, no bullet points. Keep it under 2000 words but make every word count.

Here are the reference video analyses:

${analyses.map((a, i) => `=== Reference Video ${i + 1} (${a._filename}) ===\nWhy selected: ${a._why_included}\nTags: ${(a._tags || []).join(", ")}\n${JSON.stringify(a, null, 2)}`).join("\n\n")}`;

  const result = await model.generateContent([{ text: prompt }]);
  return result.response.text().trim();
}

async function writeToSupabase(styleGuide, sampleSize, analyses) {
  const now = new Date();
  const validUntil = new Date(now.getTime() + VALID_DAYS * 24 * 60 * 60 * 1000);

  const { data, error } = await supabase.from("trend_profiles").insert({
    profile_type: "general",
    sample_size: sampleSize,
    computed_at: now.toISOString(),
    valid_until: validUntil.toISOString(),
    profile_json: {
      type: "style_guide",
      style_guide: styleGuide,
      sample_size: sampleSize,
      computed_at: now.toISOString(),
      source: "manual_reference_videos",
      individual_analyses: analyses,
    },
  });

  if (error) {
    console.error(`Failed to write to Supabase: ${error.message}`);
    return false;
  }

  console.log(`\nStyle guide written to Supabase:`);
  console.log(`  Sample size: ${sampleSize} videos`);
  console.log(`  Valid until: ${validUntil.toISOString()}`);
  console.log(`  Guide length: ${styleGuide.length} characters`);
  return true;
}

async function main() {
  console.log("=== Promptly Reference Video Analyzer ===\n");

  if (!fs.existsSync(MANIFEST_PATH)) {
    console.error(`No manifest found at ${MANIFEST_PATH}`);
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf-8"));
  const videos = manifest.videos || [];

  if (videos.length === 0) {
    console.error("Manifest has no videos listed. Add entries to reference-videos/manifest.json");
    process.exit(1);
  }

  console.log(`Found ${videos.length} reference videos:\n`);
  videos.forEach((v, i) => {
    const exists = fs.existsSync(path.join(REFERENCE_DIR, v.filename));
    console.log(`  ${i + 1}. ${v.filename} ${exists ? "✓" : "✗ MISSING"}`);
    console.log(`     ${v.description}`);
    console.log();
  });

  const analyses = [];

  for (let i = 0; i < videos.length; i++) {
    const entry = videos[i];
    const videoPath = path.join(REFERENCE_DIR, entry.filename);

    if (!fs.existsSync(videoPath)) {
      console.log(`\n[${i + 1}/${videos.length}] SKIPPING ${entry.filename} — file not found`);
      continue;
    }

    console.log(`\n[${i + 1}/${videos.length}] Analyzing: ${entry.filename}`);

    try {
      const analysis = await analyzeVideo(videoPath, entry);
      if (analysis) {
        analyses.push(analysis);
        console.log(`  ✓ ${analysis.what_makes_it_work}`);
      }
    } catch (err) {
      console.log(`  ✗ Error: ${err.message}`);
    }

    if (i < videos.length - 1) {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  if (analyses.length === 0) {
    console.error("\nNo videos analyzed successfully.");
    process.exit(1);
  }

  console.log(`\n=== ${analyses.length}/${videos.length} analyzed ===`);

  const analysesPath = path.join(REFERENCE_DIR, "_last_analyses.json");
  fs.writeFileSync(analysesPath, JSON.stringify(analyses, null, 2));
  console.log(`Individual analyses saved to ${analysesPath}`);

  console.log("\nGenerating style guide...");
  const styleGuide = await aggregateStyleGuide(analyses);

  const guidePath = path.join(REFERENCE_DIR, "_last_style_guide.txt");
  fs.writeFileSync(guidePath, styleGuide);
  console.log(`Style guide saved to ${guidePath}`);
  console.log(`\n--- PREVIEW ---\n${styleGuide.substring(0, 500)}\n--- END ---\n`);

  console.log("Writing to Supabase...");
  const success = await writeToSupabase(styleGuide, analyses.length, analyses);

  if (success) {
    console.log("\n✓ Done! Next Promptly edit will use this style guide.");
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
