const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const CLAUDE_EDIT_TIMEOUT_MS = 240_000;
const CLAUDE_VIBE_TIMEOUT_MS = 120_000;

function withTimeout(promise, ms, label) {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`));
    }, ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

const COLOR_INTENTS = {
  none: { brightness: 0, contrast: 0, saturation: 0, gamma: 0, color_temperature: null },
  neutral: { brightness: 0, contrast: 0, saturation: 0, gamma: 0, color_temperature: 'neutral' },
  cinematic: { brightness: -0.05, contrast: 0.2, saturation: -0.18, gamma: -0.06, color_temperature: 'cool' },
  warm: { brightness: 0.02, contrast: 0.08, saturation: 0.12, gamma: 0.01, color_temperature: 'warm' },
  cozy: { brightness: 0.04, contrast: 0.06, saturation: 0.08, gamma: 0.05, color_temperature: 'warm' },
  cool: { brightness: -0.01, contrast: 0.08, saturation: -0.1, gamma: -0.01, color_temperature: 'cool' },
  moody: { brightness: -0.09, contrast: 0.24, saturation: -0.24, gamma: -0.1, color_temperature: 'cool' },
  vibrant: { brightness: 0.03, contrast: 0.16, saturation: 0.28, gamma: 0, color_temperature: null },
  punchy: { brightness: 0.01, contrast: 0.22, saturation: 0.2, gamma: -0.06, color_temperature: null },
  vivid: { brightness: 0.04, contrast: 0.18, saturation: 0.32, gamma: -0.01, color_temperature: null },
  clean: { brightness: 0.01, contrast: 0.07, saturation: 0.05, gamma: 0.01, color_temperature: 'neutral' },
  polished: { brightness: 0.02, contrast: 0.1, saturation: 0.08, gamma: 0.01, color_temperature: 'neutral' },
  enhanced: { brightness: 0.01, contrast: 0.13, saturation: 0.12, gamma: 0, color_temperature: null },
  faded: { brightness: 0.05, contrast: -0.18, saturation: -0.32, gamma: 0.09, color_temperature: 'warm' },
  vintage: { brightness: 0.03, contrast: -0.14, saturation: -0.26, gamma: 0.08, color_temperature: 'warm' },
  dramatic: { brightness: -0.08, contrast: 0.28, saturation: -0.12, gamma: -0.11, color_temperature: 'cool' },
  bold: { brightness: 0.02, contrast: 0.25, saturation: 0.24, gamma: -0.05, color_temperature: null },
  soft: { brightness: 0.05, contrast: -0.14, saturation: -0.1, gamma: 0.07, color_temperature: 'warm' },
  dreamy: { brightness: 0.07, contrast: -0.12, saturation: -0.18, gamma: 0.1, color_temperature: 'warm' },
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeIntent(intentName) {
  const key = String(intentName || '').trim().toLowerCase();
  if (key && COLOR_INTENTS[key]) return key;
  if (key) console.warn(`[generate-edit] Unknown color_intent "${intentName}", falling back to "none"`);
  return 'none';
}

function buildColorGrade(baseline, intentName) {
  const safeBaseline = {
    brightness: typeof baseline?.brightness === 'number' ? baseline.brightness : 0,
    contrast: typeof baseline?.contrast === 'number' ? baseline.contrast : 1,
    saturation: typeof baseline?.saturation === 'number' ? baseline.saturation : 1,
    gamma: typeof baseline?.gamma === 'number' ? baseline.gamma : 1,
    color_temperature: ['warm', 'cool', 'neutral'].includes(baseline?.color_temperature)
      ? baseline.color_temperature
      : 'neutral',
  };

  const normalizedIntent = normalizeIntent(intentName);
  const delta = COLOR_INTENTS[normalizedIntent];

  return {
    brightness: clamp(safeBaseline.brightness + delta.brightness, -0.3, 0.3),
    contrast: clamp(safeBaseline.contrast + delta.contrast, 0.5, 2),
    saturation: clamp(safeBaseline.saturation + delta.saturation, 0.5, 2),
    gamma: clamp(safeBaseline.gamma + delta.gamma, 0.5, 2),
    color_temperature: delta.color_temperature || safeBaseline.color_temperature || 'neutral',
  };
}

async function generateEdit(analysis, transcript, vibe, onProgress, preExpandedVibe = null, sceneFrames = []) {
  console.log('🎨 Claude is creating edit recipe...');
  onProgress?.(45, 'Designing edit...');

  const expandedVibe = preExpandedVibe || await expandVibeIntent(vibe);
  // Prefer tighten keep-segments when available so dead air and filler removals
  // are represented as discontinuous source ranges.
  const tightenedSegments = Array.isArray(analysis?.tightened_timeline?.segments)
    ? analysis.tightened_timeline.segments
    : [];
  let preCuts = [];
  if (tightenedSegments.length > 0 && Number(analysis?.tightened_timeline?.removedSeconds || 0) >= 0.1) {
    preCuts = tightenedSegments
      .map((s) => ({
        source_start: Number(s?.start || 0),
        source_end: Number(s?.end || 0),
      }))
      .filter((s) => s.source_end > s.source_start);
    console.log(`[generate-edit] Using tightened keep-segments for clip structure (${preCuts.length} ranges)`);
  } else {
    // Build clips from safe cut points
    const cutTimes = (analysis.safe_cut_points || [])
      .map((cp) => cp.time)
      .sort((a, b) => a - b);

    // Build clips, merging any shorter than 1 second into the previous clip
    for (let i = 0; i < cutTimes.length - 1; i++) {
      const duration = cutTimes[i + 1] - cutTimes[i];
      if (duration >= 1.0 || i === 0 || i === cutTimes.length - 2) {
        preCuts.push({
          source_start: cutTimes[i],
          source_end: cutTimes[i + 1],
        });
      } else if (preCuts.length > 0) {
        // Merge short clip into the previous one
        preCuts[preCuts.length - 1].source_end = cutTimes[i + 1];
      }
    }
  }

  const prompt = buildPrompt(analysis, transcript, expandedVibe, preCuts);
  console.log(`[generate-edit] ===== FULL PROMPT TO CLAUDE =====`);
  console.log(prompt);
  console.log(`[generate-edit] ===== END PROMPT (${prompt.length} chars) =====`);
  const frameList = Array.isArray(sceneFrames) ? sceneFrames : [];
  const contentBlocks = [
    { type: 'text', text: prompt },
  ];
  if (frameList.length > 0) {
    contentBlocks.push({
      type: 'text',
      text: '\nHere are frame thumbnails from the opening and scene-change moments. Use them as visual context when deciding transitions, zoom, cut-zoom, b-roll, text overlays, and color intent.',
    });
    for (const frame of frameList) {
      if (!frame?.base64) continue;
      const ts = Number(frame.timestamp || 0);
      contentBlocks.push({
        type: 'text',
        text: `Frame at ${ts.toFixed(1)}s:`,
      });
      contentBlocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: frame.mediaType || 'image/jpeg',
          data: frame.base64,
        },
      });
    }
    contentBlocks.push({
      type: 'text',
      text: '\nUse these frames to make shot-specific decisions. If a shot is a screen recording or demo, avoid unnecessary cut-zoom/text clutter. If framing and lighting are already strong, use a lighter touch.',
    });
  }

  console.log('[generate-edit] Starting Claude API call...');
  const claudeStartedAt = Date.now();
  let response;
  try {
    response = await withTimeout(
      anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        temperature: 0.4,
        messages: [{ role: 'user', content: contentBlocks }],
      }),
      CLAUDE_EDIT_TIMEOUT_MS,
      'Claude edit recipe request'
    );
  } catch (err) {
    console.error('[generate-edit] FAILED at Claude API call:', err.message, err.stack);
    throw err;
  }
  console.log(`[generate-edit] Claude API call complete in ${Date.now() - claudeStartedAt}ms`);

  const responseText = response.content[0].text;
  console.log(`[generate-edit] ===== CLAUDE RAW RESPONSE =====`);
  console.log(responseText);
  console.log(`[generate-edit] ===== END RESPONSE =====`);

  const text = responseText
    .replace(/```json/g, '')
    .replace(/```/g, '')
    .trim();

  console.log('[generate-edit] Starting Claude JSON parse...');
  let editPlan;
  try {
    editPlan = JSON.parse(text);
  } catch (err) {
    console.error('[generate-edit] FAILED parsing Claude response JSON:', err.message);
    console.error('[generate-edit] Claude response preview:', text.slice(0, 1200));
    throw err;
  }
  console.log('[generate-edit] Claude JSON parse complete');

  if (!Array.isArray(editPlan.clips)) {
    throw new Error('Claude response missing clips[]');
  }

  // Default new fields
  if (!editPlan.background_music) editPlan.background_music = 'none';
  if (!editPlan.caption_style) editPlan.caption_style = 'none';
  if (!editPlan.caption_position) editPlan.caption_position = 'lower-third';
  // Default new top-level fields
  if (!editPlan.audio_ducking) editPlan.audio_ducking = false;
  if (!editPlan.outro) editPlan.outro = 'none';
  if (!editPlan.aspect_ratio) editPlan.aspect_ratio = 'original';
  if (!editPlan.text_overlays) editPlan.text_overlays = [];
  if (!editPlan.vignette) editPlan.vignette = 'none';
  if (!Array.isArray(editPlan.broll)) editPlan.broll = [];
  if (Array.isArray(editPlan.text_overlays)) {
    for (const overlay of editPlan.text_overlays) {
      if (overlay && !overlay.sfx_style) overlay.sfx_style = 'none';
    }
  }

  // Promptly does not add background music.
  if (editPlan.background_music && editPlan.background_music !== 'none') {
    console.log(`[generate-edit] Ignoring background_music="${editPlan.background_music}" — music disabled`);
  }
  editPlan.background_music = 'none';
  editPlan.audio_ducking = false;

  for (const clipEntry of editPlan.clips) {
    if (!clipEntry.transition_sound) clipEntry.transition_sound = 'none';
    if (!clipEntry.sfx_style) clipEntry.sfx_style = clipEntry.transition_sound || 'none';
    if (!clipEntry.zoom) clipEntry.zoom = 'none';
    if (typeof clipEntry.cut_zoom !== 'boolean') clipEntry.cut_zoom = false;
    // Default new per-clip fields
    if (!clipEntry.speed) clipEntry.speed = 1.0;
    // Clamp speed to safe range
    clipEntry.speed = Math.max(0.25, Math.min(4.0, clipEntry.speed));
  }

  const baseline = analysis?.color_baseline || {};
  const intent = normalizeIntent(editPlan.color_intent || 'none');
  editPlan.color_intent = intent;
  editPlan.color_grade = buildColorGrade(baseline, intent);

  // Ensure all clips are present
  const allClipNumbers = preCuts.map((_, i) => i + 1);
  const returnedClipNumbers = new Set(editPlan.clips.map((c) => c.clip));

  for (const num of allClipNumbers) {
    if (!returnedClipNumbers.has(num)) {
      console.log(`[generateEdit] WARNING: Claude dropped clip ${num}, adding back with none`);
      editPlan.clips.push({ clip: num, transition_out: 'none' });
    }
  }

  editPlan.clips.sort((a, b) => a.clip - b.clip);

  // Build the final cuts array from clip numbers
  const finalCuts = [];
  for (const clipEntry of editPlan.clips) {
    const clipIndex = clipEntry.clip - 1; // Convert 1-indexed to 0-indexed
    if (clipIndex < 0 || clipIndex >= preCuts.length) {
      console.log(`[generateEdit] Skipping invalid clip number: ${clipEntry.clip}`);
      continue;
    }
    const normalizedTransition = String(clipEntry.transition_out || '').toLowerCase();
    const transitionOut = (!normalizedTransition || normalizedTransition === 'clean_cut')
      ? 'none'
      : normalizedTransition;
    finalCuts.push({
      source_start: preCuts[clipIndex].source_start,
      source_end: preCuts[clipIndex].source_end,
      transition_out: transitionOut,
      transition_sound: clipEntry.transition_sound || 'none',
      sfx_style: clipEntry.sfx_style || clipEntry.transition_sound || 'none',
      zoom: clipEntry.zoom || 'none',
      cut_zoom: !!clipEntry.cut_zoom,
      speed: clipEntry.speed || 1.0,
    });
  }

  editPlan.cuts = finalCuts;

  // Clean up the response — remove the clips field, keep cuts
  delete editPlan.clips;

  // Add target_duration from the final cuts
  if (finalCuts.length > 0) {
    editPlan.target_duration = finalCuts[finalCuts.length - 1].source_end - finalCuts[0].source_start;
  }

  console.log(`[generateEdit] Final cuts (${finalCuts.length} clips):`);
  for (const cut of finalCuts) {
    console.log(`  ${cut.source_start} → ${cut.source_end} [${cut.transition_out}]`);
  }

  console.log(
    `  Created ${finalCuts.length} cuts, intent=${intent}, color: brightness=${editPlan.color_grade.brightness} contrast=${editPlan.color_grade.contrast} sat=${editPlan.color_grade.saturation} gamma=${editPlan.color_grade.gamma} temp=${editPlan.color_grade.color_temperature}`
  );
  onProgress?.(60, 'Edit plan complete');

  return editPlan;
}

async function expandVibeIntent(vibe) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  console.log('[edit] Starting vibe expansion API call...');
  const startedAt = Date.now();
  let response;
  try {
    response = await withTimeout(
      client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 120,
        temperature: 0,
        messages: [
          {
            role: 'user',
            content: `Rewrite the client brief for an editor in 1 sentence.
Keep the exact intent and scope.
Do not add style requests, transitions, color direction, or embellishment.

Client brief: "${vibe}"

Return only the rewritten brief.`,
          },
        ],
      }),
      CLAUDE_VIBE_TIMEOUT_MS,
      'Claude vibe expansion request'
    );
  } catch (err) {
    console.error('[edit] FAILED at vibe expansion API call:', err.message, err.stack);
    throw err;
  }
  console.log(`[edit] Vibe expansion API complete in ${Date.now() - startedAt}ms`);

  const expanded = response.content[0]?.text?.trim();
  console.log(`[edit] Vibe expansion: "${vibe}" → "${expanded}"`);
  return expanded || vibe;
}

function buildPrompt(analysis, transcript, vibe, preCuts) {
  const shotsBlock = analysis.shots.map((shot) =>
    `[${shot.start.toFixed(2)}s – ${shot.end.toFixed(2)}s]\n  ${shot.visual || ''}\n  ${shot.action || shot.description || ''}\n  Energy: ${(shot.energy || shot.score || 0.5).toFixed(1)}${shot.editing_value ? `\n  Value: ${shot.editing_value}` : ''}`
  ).join('\n\n');

  let speechBlock = '';
  if (analysis.speech?.has_speech) {
    const parts = [];
    if (analysis.speech.speaker_style || analysis.speech.overall_delivery) {
      parts.push(`Speaker: ${analysis.speech.speaker_style || analysis.speech.overall_delivery}`);
    }
    if (analysis.speech.segments?.length > 0) {
      for (const seg of analysis.speech.segments) {
        let segLine = `[${seg.start.toFixed(2)}s – ${seg.end.toFixed(2)}s] "${seg.text}" (${seg.emotion || 'neutral'}, energy ${(seg.energy_level || 0.5).toFixed(1)})`;
        if (seg.notes || seg.delivery_notes) segLine += `\n    ${seg.notes || seg.delivery_notes}`;
        parts.push(segLine);
      }
    }
    speechBlock = parts.join('\n');
  }

  let cutPointsBlock = '';
  const cutPoints = analysis.safe_cut_points || [];
  if (cutPoints.length > 0) {
    cutPointsBlock = `\nCuts:\n` +
      cutPoints
        .sort((a, b) => (b.quality || 0) - (a.quality || 0))
        .map((cp) => {
          const time = cp.time || 0;
          const reason = cp.why || cp.reason || '';
          return `  ${time.toFixed(2)}s (${(cp.quality || 0.5).toFixed(1)}) — ${reason}`;
        })
        .join('\n');
  }

  let highlightsBlock = '';
  const highlights = analysis.peak_moments || [];
  if (highlights.length > 0) {
    highlightsBlock = `\nHighlights:\n` +
      highlights
        .sort((a, b) => (b.importance || 0) - (a.importance || 0))
        .map((h) => `  ${(h.time || 0).toFixed(2)}s — ${h.what || h.description || ''} (${(h.importance || 0.5).toFixed(1)})`)
        .join('\n');
  }

  let profileBlock = '';
  const vp = analysis.video_profile || {};
  const profileParts = [];
  if (vp.content_type) profileParts.push(`Type: ${vp.content_type}`);
  if (vp.visual_character || vp.visual_style) profileParts.push(`Look: ${vp.visual_character || vp.visual_style}`);
  if (vp.strongest_moments) profileParts.push(`Best parts: ${vp.strongest_moments}`);
  if (vp.weakest_moments) profileParts.push(`Weakest parts: ${vp.weakest_moments}`);
  if (profileParts.length > 0) profileBlock = `\n${profileParts.join('\n')}`;

  let audioBlock = '';
  if (analysis.audio) {
    const musicInfo = analysis.audio.music || (analysis.audio.has_music && analysis.audio.music_description);
    if (musicInfo) {
      audioBlock = `\nMusic: ${musicInfo}`;
    }
  }

  let deepgramBlock = '';
  if (transcript?.text && transcript.text.length > 0) {
    deepgramBlock = `\nTranscript:\n"${transcript.text}"`;
  }

  let clipsBlock = '';
  if (preCuts && preCuts.length > 0) {
    clipsBlock = `\nClips:\n` +
      preCuts.map((cut, i) => {
        const clipSpeech = (analysis.speech?.segments || [])
          .filter((seg) => seg.start < cut.source_end && seg.end > cut.source_start)
          .map((seg) => seg.text)
          .join(' ');
        const preview = clipSpeech.length > 80
          ? clipSpeech.substring(0, 80) + '...'
          : clipSpeech;
        const duration = (cut.source_end - cut.source_start).toFixed(1);
        return `  Clip ${i + 1} (${duration}s)${preview ? `: "${preview}"` : ''}`;
      })
      .join('\n');
  }

  let tightenedBlock = '';
  const tightened = analysis.tightened_timeline;
  if (tightened && Array.isArray(tightened.segments) && tightened.segments.length > 0) {
    const originalDuration = Number(analysis.duration || 0);
    const tightenedDuration = tightened.segments.reduce((sum, s) => sum + Math.max(0, (s.end || 0) - (s.start || 0)), 0);
    const segText = tightened.segments
      .map((s) => `${Number(s.start || 0).toFixed(2)}s-${Number(s.end || 0).toFixed(2)}s`)
      .join(', ');
    tightenedBlock = `\n=== TIGHTENED TIMELINE ===
The transcript has been analyzed and tightened by removing dead air and filler words.
Original duration: ${originalDuration.toFixed(2)}s
Tightened duration: ${tightenedDuration.toFixed(2)}s
Removed: ${Number(tightened.removedSeconds || 0).toFixed(2)}s
Keep segments: ${segText}
Claude should use these keep segments as the basis for clip structure when they preserve message clarity.`;
  }

  let brollCandidatesBlock = '';
  if (Array.isArray(analysis.broll_candidates) && analysis.broll_candidates.length > 0) {
    brollCandidatesBlock = `\nB-roll candidates:\n` + analysis.broll_candidates
      .slice(0, 6)
      .map((c) => `  - ${c.keyword} @ ${(Number(c.timestamp) || 0).toFixed(2)}s`)
      .join('\n');
  }

  const cb = analysis.color_baseline || {};
  const frameLayout = analysis.frame_layout || {
    subject_position: 'unknown',
    existing_overlays: {
      has_burned_captions: false,
      has_text_graphics: false,
      overlay_locations: 'none detected',
    },
    free_zones: 'unknown',
  };
  let frameContext = `\n=== FRAME LAYOUT ===\n`;
  frameContext += `Subject position: ${frameLayout.subject_position}\n`;
  if (frameLayout.existing_overlays?.has_burned_captions || frameLayout.existing_overlays?.has_text_graphics) {
    frameContext += `Existing overlays: ${frameLayout.existing_overlays.overlay_locations}\n`;
    if (frameLayout.existing_overlays?.has_burned_captions) {
      frameContext += `Note: This video already has captions burned into the frame.\n`;
    }
  }
  frameContext += `Open areas for text placement: ${frameLayout.free_zones}\n`;

  const platformSafeZones = `\n=== PLATFORM SAFE ZONES ===
When the target aspect ratio is 9:16 (TikTok, Instagram Reels, YouTube Shorts):
- Bottom 20% of the frame is covered by platform UI (username, caption text, like/comment/share buttons). Any text placed here will be hidden.
- Top 10% may be partially covered by status bar and close/search icons.
- The "safe zone" for text and graphics is roughly the middle 70% of the frame vertically.

When the target aspect ratio is 16:9 (YouTube, landscape):
- Bottom 10% may be covered by progress bar and controls during playback.
- Otherwise the full frame is usable.

Use this information when deciding where to place captions, text overlays, or any on-screen graphics. Don't place important text where it will be hidden. Consider where the subject is and where existing overlays are — don't cover the person's face or stack text on top of existing graphics.
`;

  const colorBaselineBlock = `\nColor baseline (measured from the footage):
  Assessment: ${cb.assessment || 'No major exposure or white-balance issues detected.'}
  Corrective values to make this footage look its best at neutral:
    brightness: ${typeof cb.brightness === 'number' ? cb.brightness : 0}
    contrast: ${typeof cb.contrast === 'number' ? cb.contrast : 1}
    saturation: ${typeof cb.saturation === 'number' ? cb.saturation : 1}
    gamma: ${typeof cb.gamma === 'number' ? cb.gamma : 1}
    color_temperature: ${cb.color_temperature || 'neutral'}`;

  const intents = Object.keys(COLOR_INTENTS).join(', ');
  const contentType = analysis?.video_profile?.content_type || analysis?.content_type || 'unknown';
  const visualCharacter = analysis?.video_profile?.visual_character || analysis?.video_profile?.visual_style || 'unknown';
  const strongestMoments = analysis?.video_profile?.strongest_moments || 'not specified';
  const weakestMoments = analysis?.video_profile?.weakest_moments || 'not specified';
  const frameOverlayLocations = frameLayout?.existing_overlays?.overlay_locations || 'none detected';
  const hasBurnedCaptions = !!frameLayout?.existing_overlays?.has_burned_captions;
  const tightenedDuration = Array.isArray(tightened?.segments)
    ? tightened.segments.reduce((sum, s) => sum + Math.max(0, (s.end || 0) - (s.start || 0)), 0)
    : Number(analysis.duration || 0);

  return `You are the AI editor inside Promptly, a mobile app that competes with CapCut and Captions. Users upload raw talking-head footage and receive back a fully edited short-form video (TikTok, Instagram Reels, YouTube Shorts) in under 90 seconds. You produce the edit recipe — every creative decision about how this video gets cut, graded, and polished.

Your output needs to be indistinguishable from a video edited by a skilled freelance editor who specializes in short-form content. The edit should feel intentional and specific to this footage — not like a template was applied. Viewers should watch the output and think a person edited this, not a tool.

=== WHO THE USER IS ===

The user is a content creator who either doesn't know how to edit or doesn't have time. They uploaded raw footage and chose a vibe because they want their content to look like they hired a professional editor. They will watch the output on their phone, compare it to what CapCut produces, and decide whether to keep using Promptly based on this single video. Every edit you produce is an audition.

The user said: "${vibe}"

The user's brief is your creative direction. Deliver what they described.

=== WHERE THIS VIDEO LIVES ===

This video will be posted to TikTok, Instagram Reels, or YouTube Shorts. It competes for attention in an infinite scroll feed. The first 2-3 seconds determine whether a viewer stays or scrolls past. A significant percentage of viewers will watch with sound off and read captions. The video will be viewed on a phone screen — small text is unreadable, subtle color grading is invisible, and quiet sound effects are inaudible.

=== WHAT MAKES YOUR EDIT VALUABLE ===

The user can already trim a clip and apply a filter in their phone's native camera roll. They came to Promptly for the things they can't do themselves — the multi-cam feel of cut-zoom, the pacing that comes from intelligent speed adjustments, transitions placed at moments that serve the content, color grading that matches the footage's character, sound accents that punctuate key moments, and text that reinforces the hook. Use the tools that justify why this product exists.

=== YOUR RECIPE GOES DIRECTLY TO RENDER ===

Your edit recipe is a JSON object that controls every parameter of the FFmpeg render. The downstream system reads your JSON literally — every value you set becomes an FFmpeg filter parameter. There is no human review between your recipe and the rendered output. Your decisions go directly to the user's screen.

=== HOW THE PIPELINE WORKS ===

Before you see anything, the pipeline has already:
1. Downloaded the user's raw footage
2. Normalized it to 1080x1920 at 30fps
3. Transcribed all speech with word-level timestamps (Deepgram)
4. Analyzed the footage visually — identified shots, scene changes, speaker energy, frame layout, existing overlays, color character (Gemini, with frame thumbnails)
5. Detected scene change timestamps from the raw video (FFmpeg scdet)
6. Tightened the timeline by removing dead air and filler words
7. Combined scene changes and sentence boundaries into safe cut points
8. Split those cut points into numbered clips with transcript excerpts

You are receiving all of this analysis. The cut points and clip structure are pre-determined — you cannot reorder, merge, split, or drop clips. Your job is to set the creative parameters for each clip (transition, zoom, speed, cut-zoom) and the global parameters (color, captions, vignette, text overlays, b-roll, outro).

After you respond, the pipeline:
1. Extracts each clip from the source video at the timestamps you confirm
2. Downloads any b-roll clips you requested from Pexels
3. Builds a single FFmpeg filter graph using every value from your recipe
4. Sends it to a GPU server (RunPod) which renders the final video in one pass
5. Uploads the rendered video directly to the user's library

=== THIS VIDEO ===

Duration: ${Number(analysis.duration || 0).toFixed(2)}s
Content type: ${contentType}
Visual character: ${visualCharacter}
Strongest moments: ${strongestMoments}
Weakest moments: ${weakestMoments}
${audioBlock}
${colorBaselineBlock}
Frame layout:
  Subject: ${frameLayout.subject_position}
  Existing overlays: ${frameOverlayLocations}
  ${hasBurnedCaptions ? 'Captions are already burned into the video frames.' : 'No burned-in captions detected.'}
  Open space for graphics: ${frameLayout.free_zones}

${platformSafeZones}

=== SHOTS ===

${shotsBlock}

=== TRANSCRIPT ===

${speechBlock}
${deepgramBlock}

=== SCENE FRAMES ===

Frame thumbnails are attached as image blocks with timestamps.

=== EDIT STRUCTURE ===

${cutPointsBlock}
${clipsBlock}
${tightenedBlock}
${highlightsBlock}
${brollCandidatesBlock}

=== TOOLS ===

Each clip in your recipe has these parameters:
  source_start / source_end — timestamps in the source video (already fixed by clip number mapping)

  transition_out — visual effect between this clip and the next:
    none, fade, fadeblack, fadewhite, dissolve, wipeleft, wiperight, wipeup, wipedown, smoothleft, smoothright, smoothup, smoothdown, zoomin

  transition_sound — none, whoosh, swoosh, pop, boom, ding, rise, cashier

  sfx_style — none, whoosh, impact, slide

  zoom — none, slow_in, slow_out, punch_in, punch_out

  cut_zoom — true or false

  speed — 0.5, 0.75, 1.0, 1.05, 1.1, 1.15, 1.25, 1.5, 2.0

Global parameters:
  color_intent — ${intents}
  vignette — none, light, medium, strong
  caption_style — none, standard, bold_centered, minimal_bottom, animated_word, bold_white, bold_yellow, keyword_pop, box_caption
  caption_position — top, center, lower-third, bottom
  outro — none, fade_black, fade_white
  background_music — always "none"
  aspect_ratio — always "9:16"

Text overlays:
  text, position (top|center|bottom), appear_at_clip, style (title|callout|cta), sfx_style (none|pop|ding|click|ching)
  IMPORTANT: Use plain text only. No emojis.

B-roll:
  keyword, timestamp, duration (1-3)

=== RESPONSE FORMAT ===

Respond with ONLY this JSON object:

{
  "strategy": "<explain your creative reasoning for this specific video>",
  "color_intent": "<intent>",
  "background_music": "none",
  "caption_style": "<style>",
  "caption_position": "<position>",
  "caption_keywords": [],
  "audio_ducking": false,
  "outro": "<outro>",
  "aspect_ratio": "9:16",
  "vignette": "<level>",
  "text_overlays": [
    { "text": "<text>", "position": "<position>", "appear_at_clip": <clip number>, "style": "<style>", "sfx_style": "<sfx>" }
  ],
  "broll": [
    { "keyword": "<search term>", "timestamp": <seconds>, "duration": <1-3> }
  ],
  "clips": [
    { "clip": 1, "transition_out": "<transition>", "transition_sound": "<sound>", "sfx_style": "<sfx>", "zoom": "<zoom>", "cut_zoom": <true|false>, "speed": <n> }
  ]
}`;
}

module.exports = { generateEdit, expandVibeIntent };
