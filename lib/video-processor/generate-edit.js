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

function normalizeSpeedSegmentsForClip(speedSegments, clipDuration, fallbackSpeed = 1.0) {
  const duration = Math.max(0, Number(clipDuration || 0));
  if (!Array.isArray(speedSegments) || speedSegments.length === 0 || duration <= 0) return [];
  const safeFallback = Math.max(0.25, Math.min(4.0, Number(fallbackSpeed) || 1.0));
  const segments = speedSegments
    .map((seg) => ({
      start: Math.max(0, Math.min(duration, Number(seg?.start || 0))),
      end: Math.max(0, Math.min(duration, Number(seg?.end || 0))),
      speed: Math.max(0.25, Math.min(4.0, Number(seg?.speed || safeFallback) || safeFallback)),
    }))
    .filter((seg) => seg.end > seg.start)
    .sort((a, b) => a.start - b.start);
  return segments;
}

function extractJSON(text) {
  const raw = String(text || '').trim();
  if (!raw) {
    throw new Error('Empty Claude response');
  }

  try {
    return JSON.parse(raw);
  } catch (_) {
    // fall through to block extraction
  }

  const jsonBlockMatch = raw.match(/```json\s*\n?([\s\S]*?)\n?\s*```/i);
  if (jsonBlockMatch) {
    try {
      return JSON.parse(String(jsonBlockMatch[1] || '').trim());
    } catch (e) {
      console.error('[generate-edit] Found ```json block but failed to parse:', e.message);
    }
  }

  const codeBlockMatch = raw.match(/```\s*\n?([\s\S]*?)\n?\s*```/);
  if (codeBlockMatch) {
    try {
      return JSON.parse(String(codeBlockMatch[1] || '').trim());
    } catch (e) {
      console.error('[generate-edit] Found ``` block but failed to parse:', e.message);
    }
  }

  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(raw.slice(firstBrace, lastBrace + 1));
    } catch (e) {
      console.error('[generate-edit] Found braces but failed to parse:', e.message);
    }
  }

  throw new Error('Could not extract valid JSON from Claude response');
}

async function generateEdit(analysis, transcript, vibe, onProgress, preExpandedVibe = null, sceneFrames = []) {
  console.log('🎨 Claude is creating edit recipe...');
  onProgress?.(45, 'Designing edit...');

  const expandedVibe = preExpandedVibe || await expandVibeIntent(vibe);
  const { staticPrefix, dynamicSuffix } = buildPrompt(analysis, transcript, expandedVibe);
  const prompt = `${staticPrefix}\n\n${dynamicSuffix}`;
  console.log(`[generate-edit] ===== FULL PROMPT TO CLAUDE =====`);
  console.log(prompt);
  console.log(`[generate-edit] ===== END PROMPT (${prompt.length} chars) =====`);
  const frameList = Array.isArray(sceneFrames) ? sceneFrames : [];
  const contentBlocks = [
    {
      type: 'text',
      text: staticPrefix,
      cache_control: { type: 'ephemeral' },
    },
    {
      type: 'text',
      text: dynamicSuffix,
    },
  ];
  if (frameList.length > 0) {
    contentBlocks.push({
      type: 'text',
      text: '\nHere are frame thumbnails from the opening and scene-change moments. Use them as visual context when deciding transitions, zoom, cut-zoom, text overlays, and color intent.',
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
  const usage = response?.usage || {};
  console.log(
    `[claude] Cache: write=${usage.cache_creation_input_tokens || 0} read=${usage.cache_read_input_tokens || 0} input=${usage.input_tokens || 0}`
  );

  const responseText = response.content[0].text;
  console.log(`[generate-edit] ===== CLAUDE RAW RESPONSE =====`);
  console.log(responseText);
  console.log(`[generate-edit] ===== END RESPONSE =====`);

  console.log('[generate-edit] Starting Claude JSON parse...');
  let editPlan;
  try {
    editPlan = extractJSON(responseText);
  } catch (err) {
    console.error('[generate-edit] FAILED parsing Claude response JSON:', err.message);
    console.error('[generate-edit] Claude response preview:', String(responseText || '').slice(0, 1200));
    throw err;
  }
  console.log('[generate-edit] Claude JSON parse complete');

  const rawCuts = Array.isArray(editPlan.cuts) ? editPlan.cuts : editPlan.clips;
  if (!Array.isArray(rawCuts) || rawCuts.length === 0) {
    throw new Error('Claude response missing cuts array');
  }

  const videoDuration = Number(analysis?.duration || 0);
  const validatedCuts = [];
  for (let i = 0; i < rawCuts.length; i++) {
    const cut = rawCuts[i] || {};
    const sourceStart = Number.parseFloat(cut.source_start);
    const sourceEnd = Number.parseFloat(cut.source_end);
    if (!Number.isFinite(sourceStart) || !Number.isFinite(sourceEnd)) {
      throw new Error(`Cut ${i}: invalid timestamps`);
    }
    if (sourceStart >= sourceEnd) {
      throw new Error(`Cut ${i}: source_start (${sourceStart}) >= source_end (${sourceEnd})`);
    }
    if (sourceStart < 0) {
      throw new Error(`Cut ${i}: source_start is negative`);
    }
    if (videoDuration > 0 && sourceEnd > videoDuration + 0.5) {
      throw new Error(`Cut ${i}: source_end (${sourceEnd}) exceeds video duration (${videoDuration})`);
    }
    if (i > 0 && sourceStart < validatedCuts[i - 1].source_start) {
      throw new Error(`Cut ${i}: not in chronological order`);
    }
    validatedCuts.push({
      ...cut,
      source_start: sourceStart,
      source_end: sourceEnd,
      clip: i + 1,
    });
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

  for (const clipEntry of validatedCuts) {
    if (!clipEntry.transition_sound) clipEntry.transition_sound = 'none';
    if (!clipEntry.sfx_style) clipEntry.sfx_style = clipEntry.transition_sound || 'none';
    if (!clipEntry.zoom) clipEntry.zoom = 'none';
    if (typeof clipEntry.cut_zoom !== 'boolean') clipEntry.cut_zoom = false;
    // Default new per-clip fields
    if (!clipEntry.speed) clipEntry.speed = 1.0;
    // Clamp speed to safe range
    clipEntry.speed = Math.max(0.25, Math.min(4.0, clipEntry.speed));
    if (!Array.isArray(clipEntry.speed_segments)) {
      clipEntry.speed_segments = [];
    }
  }

  const baseline = analysis?.color_baseline || {};
  const intent = normalizeIntent(editPlan.color_intent || 'none');
  editPlan.color_intent = intent;
  editPlan.color_grade = buildColorGrade(baseline, intent);

  // Build final cuts directly from Claude-provided timestamps.
  const finalCuts = [];
  for (const clipEntry of validatedCuts) {
    const normalizedTransition = String(clipEntry.transition_out || '').toLowerCase();
    const transitionOut = (!normalizedTransition || normalizedTransition === 'clean_cut')
      ? 'none'
      : normalizedTransition;
    finalCuts.push({
      source_start: clipEntry.source_start,
      source_end: clipEntry.source_end,
      transition_out: transitionOut,
      transition_sound: clipEntry.transition_sound || 'none',
      sfx_style: clipEntry.sfx_style || clipEntry.transition_sound || 'none',
      zoom: clipEntry.zoom || 'none',
      cut_zoom: !!clipEntry.cut_zoom,
      speed: clipEntry.speed || 1.0,
      speed_segments: normalizeSpeedSegmentsForClip(
        clipEntry.speed_segments,
        Number(clipEntry.source_end || 0) - Number(clipEntry.source_start || 0),
        clipEntry.speed || 1.0
      ),
    });
  }

  if (videoDuration > 0) {
    const totalClipDuration = finalCuts.reduce(
      (sum, c) => sum + Math.max(0, Number(c.source_end || 0) - Number(c.source_start || 0)),
      0
    );
    const coverageRatio = totalClipDuration / videoDuration;
    if (coverageRatio < 0.3) {
      console.warn(
        `[generate-edit] WARNING: Claude's clips only cover ${(coverageRatio * 100).toFixed(0)}% `
        + `of the video (${totalClipDuration.toFixed(1)}s of ${videoDuration.toFixed(1)}s)`
      );
    }
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
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 120,
        temperature: 0,
        messages: [
          {
            role: 'user',
            content: `The user described how they want their video edited in a few words. Your job is to turn their brief into a clear, complete creative direction that a professional video editor can follow. The expanded version will be passed directly to the editor as their instructions.

Keep every specific technique, effect, or style the user mentioned in the output — words like "transitions", "captions", "zoom", "speed", "sound effects", "fast", "slow", "cinematic" etc. should appear in your expansion exactly as the user stated them. Add clarity and detail around what the user's words mean for the edit, but preserve their original intent and specific requests.

User input: "${vibe}"`,
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

function buildPrompt(analysis, transcript, vibe) {
  const shotsBlock = analysis.shots.map((shot) =>
    `[${shot.start.toFixed(2)}s – ${shot.end.toFixed(2)}s]\n  ${shot.visual || ''}\n  ${shot.action || ''}\n  Energy: ${(shot.energy || shot.score || 0.5).toFixed(1)}${shot.editing_value ? `\n  Value: ${shot.editing_value}` : ''}`
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

  const sceneChanges = Array.isArray(analysis?.visual_cuts) ? analysis.visual_cuts : [];
  const sceneChangesBlock = sceneChanges.length > 0
    ? sceneChanges
      .slice()
      .sort((a, b) => Number(a || 0) - Number(b || 0))
      .map((time) => {
        const t = Number(time || 0);
        const shot = (analysis.shots || []).find((s) => t >= Number(s?.start || 0) && t <= Number(s?.end || 0));
        const desc = shot?.description || shot?.action || shot?.visual || 'scene change';
        return `  ${t.toFixed(2)}s — ${desc}`;
      })
      .join('\n')
    : '  none';

  const sentenceBoundaries = Array.isArray(analysis?.speech?.sentence_boundaries)
    ? analysis.speech.sentence_boundaries
    : [];
  const speechBoundariesBlock = sentenceBoundaries.length > 0
    ? sentenceBoundaries
      .slice()
      .sort((a, b) => Number(a?.time || 0) - Number(b?.time || 0))
      .map((b) => {
        const t = Number(b?.time || 0);
        const pause = Number(b?.pause_after || 0);
        const seg = (analysis?.speech?.segments || []).find((s) => Number(s?.end || 0) >= t - 0.05 && Number(s?.end || 0) <= t + 0.6);
        const prevText = seg?.text ? `, preceding text: "${seg.text}"` : '';
        return `  ${t.toFixed(2)}s — pause ${pause.toFixed(3)}s${prevText}`;
      })
      .join('\n')
    : '  none';

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

  let tightenedBlock = '';
  const tightened = analysis.tightened_timeline;
  if (tightened && Array.isArray(tightened.segments) && tightened.segments.length > 0) {
    const originalDuration = Number(analysis.duration || 0);
    const tightenedDuration = tightened.segments.reduce((sum, s) => sum + Math.max(0, (s.end || 0) - (s.start || 0)), 0);
    const segText = tightened.segments
      .map((s) => `${Number(s.start || 0).toFixed(2)}s-${Number(s.end || 0).toFixed(2)}s`)
      .join(', ');
    tightenedBlock = `\nTightened timeline (dead air and filler words already removed):
  Original: ${originalDuration.toFixed(2)}s → Tightened: ${tightenedDuration.toFixed(2)}s (removed ${Number(tightened.removedSeconds || 0).toFixed(2)}s)
  Keep segments: ${segText}`;
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

  const fullPrompt = `You are the professional editor inside Promptly, a mobile app that competes with CapCut and Captions. Users upload raw talking-head footage and receive back a fully edited short-form video (TikTok, Instagram Reels, YouTube Shorts) in under 90 seconds. You produce the edit recipe — every creative decision about how this video gets cut, graded, and polished.

Your output needs to be indistinguishable from a video edited by a skilled freelance editor who specializes in short-form content for TikTok and Instagram Reels.

=== WHERE THIS VIDEO LIVES ===

This video will be posted to TikTok, Instagram Reels, or YouTube Shorts. Here is how these platforms work:

Feed behavior: Videos appear in a vertical infinite scroll feed. Each video takes up the full screen. The viewer swipes up to skip to the next video. The decision to stay or scroll happens in the first 2-3 seconds.

Looping: When a video ends, the platform automatically loops it back to the beginning. The transition from the last frame to the first frame is visible to the viewer. Videos that end abruptly loop seamlessly. Videos that fade to black show a flash of black before the first frame reappears.

Screen layout: The video plays at 1080x1920 on a phone screen. The platform overlays UI elements on top of the video:
  - Right side: a vertical stack of buttons (like, comment, share, save) covering roughly the right 15% of the frame from the middle down
  - Bottom 20%: the creator's username, video caption text, and a sound ticker
  - Top 10%: status bar, back button, search icon
  These UI elements are always present during playback. Text or important visual content placed in these zones is partially or fully hidden.

Captions on the platform: The majority of top-performing short-form content on TikTok and Reels in 2025 uses large, bold, word-by-word animated captions. These are typically centered or in the lower-third of the frame, with high contrast (white or yellow text with black outlines). Videos without any form of captions get significantly lower average watch time because a large portion of viewers browse with sound off or in noisy environments. Videos that already have captions burned into the frames already have this coverage.

Pacing: Short-form content on these platforms is edited with fast pacing relative to traditional video. Clips are typically 2-8 seconds long. Speed adjustments of 1.05x-1.15x are common on talking-head content to tighten delivery without being perceptible. Static framing (no zoom, no cut-zoom, no transitions) for more than 5-6 seconds reads as unedited raw footage on these platforms.

The video will be viewed on a 1080px wide phone screen.

=== YOUR RECIPE GOES DIRECTLY TO RENDER ===

Your edit recipe is a JSON object that controls every parameter of the FFmpeg render. The downstream system reads your JSON literally — every value you set becomes an FFmpeg filter parameter. There is no human review between your recipe and the rendered output. Your decisions go directly to the user's screen.

=== HOW THIS RENDERING PIPELINE WORKS ===

Some tool combinations produce specific results in this rendering pipeline. These are technical realities of how FFmpeg processes the video:

Captions and burned-in captions: The frame layout analysis below tells you whether this video already has captions burned into the frames. If it does, those captions are baked into the pixel data and cannot be removed. Adding a caption_style on top of existing burned-in captions means the viewer sees two overlapping text tracks. On TikTok and Reels, the bottom 20% of the screen is already covered by platform UI (username, caption text, buttons). Two caption layers plus platform UI produces three layers of overlapping text at the bottom of a phone screen.

Zoom effects and frame content: Zoom works by scaling the frame larger than 1080x1920 and cropping back to 1080x1920. This crops the edges. If the video has text burned into the frame — captions, watermarks, lower thirds — zoom crops into that text, cutting off letters or words. On videos without burned-in text, zoom works cleanly.

Zoom and cut-zoom on the same clip: Zoom applies a continuous scale change across the clip. Cut-zoom alternates between two framing levels at sentence boundaries. Both active on the same clip produces two competing scale changes — continuous drift plus sudden jumps.

Sound effect files: Each transition sound and text overlay sound is a single short audio recording. When the same sound file plays on consecutive transitions (e.g., whoosh then whoosh), the viewer hears the identical audio sample repeated back-to-back.

Fade-to-black timing: On TikTok, Reels, and Shorts, the platform auto-advances or loops when a video ends. A fade-to-black darkens the last second of the video. Viewers scrolling their feed see the darkening in peripheral vision before the video finishes.

Text overlay rendering: Text overlays use FFmpeg's drawtext filter at a fixed font size on the 1080px wide frame. Text longer than 4-5 words gets rendered at a smaller size to fit, or extends past the frame edges and gets clipped.

=== PIPELINE STEPS ===

Before you see anything, the pipeline has already:
1. Downloaded the user's raw footage
2. Normalized it to 1080x1920 at 30fps
3. Transcribed all speech with word-level timestamps (Deepgram)
4. Analyzed the footage visually — identified shots, scene changes, speaker energy, frame layout, existing overlays, color character (Gemini, with frame thumbnails)
5. Detected scene change timestamps from the raw video (FFmpeg scdet)
6. Tightened the timeline by removing dead air and filler words

You decide the clip structure for this video. Each clip in your response has a source_start and source_end timestamp — these are the exact timestamps the pipeline uses to extract clips from the source video.

Choose your cuts based on the shot analysis, transcript, and scene frames above. Effective cuts in short-form content land at moments where the visual content, speaker topic, or energy level changes.

For videos with speech: speech boundary timestamps (listed below) produce the cleanest audio cuts because the speaker is naturally pausing. Cutting mid-sentence produces an audible break in speech that sounds like a glitch.

For videos without speech or with continuous movement: scene change timestamps and visual transitions (indoor to outdoor, subject position changes, camera movement changes) are the best cut points.

Sections of the video that are static, blurry, or have no visual or narrative value can be excluded from your clips. The pipeline will only render the sections you include.

After you respond, the pipeline:
1. Extracts each clip from the source video at the timestamps
2. Builds a single FFmpeg filter graph using every value from your recipe
3. Sends it to a GPU server which renders the final video in one pass
4. Uploads the rendered video directly to the user's library

=== TOOLS ===

Each clip in your recipe has these parameters:
  source_start / source_end — timestamps in the source video that define this clip's boundaries. Clips must be strictly sequential and non-overlapping: each clip's source_start must be greater than or equal to the previous clip's source_end. You cannot reuse or revisit a segment of the source video that has already appeared in an earlier clip.

  transition_out — visual effect between this clip and the next:
    none — clean hard cut, no visual effect
    fade — gradual opacity fade between clips
    fadeblack — first clip fades to black, then next clip fades in from black
    fadewhite — same as fadeblack but through white
    dissolve — cross-fade blend where both clips are briefly visible
    wipeleft — next clip slides in from the right, pushing current clip left
    wiperight — next clip slides in from the left
    wipeup — next clip slides in from the bottom
    wipedown — next clip slides in from the top
    smoothleft / smoothright / smoothup / smoothdown — polished versions of the wipe transitions with eased motion
    zoomin — current clip zooms in and reveals next clip underneath

  transition_sound — audio that plays during the transition:
    none — silent transition
    swoosh — fast tight air swipe sound
    shutter — camera shutter click
    thud — short punchy impact hit
    pop — quick bright snap
    ding — clean single-note bell
    reverb_hit — impact with reverb tail
    typing — rapid keyboard clicks
    ching — cash register sound

  sfx_style — sound accent on the clip itself:
    none, swoosh, thud, shutter

  zoom — camera movement applied across the entire clip duration:
    none — static framing
    slow_in — gradually zooms in from wide to tight over the clip
    slow_out — gradually zooms out from tight to wide
    punch_in — quick zoom in at the start of the clip
    punch_out — quick zoom out at the start of the clip

  cut_zoom — simulates a multi-camera shoot from a single take:
    true — alternates between normal and slightly zoomed-in framing at sentence boundaries within the clip, creating the appearance of camera angle changes
    false — single continuous framing for the whole clip

  speed — playback speed multiplier. Values above 1.0 speed up the clip and shorten its duration. Values below 1.0 slow it down. Audio pitch is preserved.
    0.5, 0.75, 1.0, 1.05, 1.1, 1.15, 1.25, 1.5, 2.0

Global parameters:
  color_intent — sets the overall color character of the video. The rendering system combines your chosen intent with the measured color baseline above to produce the final FFmpeg eq values.
    ${intents}

  vignette — darkens the edges of the frame, drawing the eye toward the center:
    none — no edge darkening
    light — slight darkening at the very edges
    medium — visible darkening across the outer 20-30% of the frame
    strong — heavy edge darkening

  caption_style — word-by-word captions synchronized to the speaker's voice, rendered over the video:
    none — no captions added
    standard — clean white text
    bold_centered — bold white text centered on screen
    minimal_bottom — small text at the bottom
    animated_word — words pop in one at a time synced to speech
    bold_white — large bold white with thick black outline
    bold_yellow — large bold yellow with thick black outline
    keyword_pop — white text with key words highlighted in color. Requires a caption_keywords array with 3-8 important transcript words to highlight.
    box_caption — white text on a dark semi-transparent background box

  caption_position — where captions are placed vertically: top, center, lower-third, bottom

  outro — what happens after the last frame of the last clip:
    none — video ends immediately on the last frame
    fade_black — last clip gradually fades to black
    fade_white — last clip gradually fades to white

  background_music — always "none" (users add their own music from TikTok/Instagram after export)
  aspect_ratio — always "9:16"

Text overlays — text graphics displayed on specific clips:
  text — the words displayed. Plain text only — the FFmpeg drawtext filter cannot render emojis.
  position — top, center, or bottom of the frame
  appear_at_clip — which clip number the text appears on (displayed for the clip's full duration)
  style — title (large, bold), callout (medium, emphasized), or cta (call-to-action styling)
  sfx_style — sound that plays when the text appears:
    none — silent appearance
    pop — quick bright snap
    ding — clean single-note bell
    typing — rapid keyboard clicks, gives text a "being typed" feel
    ching — cash register sound
    reverb_hit — impact with reverb tail
    shutter — camera shutter click

=== HOW THESE TOOLS LOOK ON TIKTOK / REELS / SHORTS ===

Transitions on short-form: On a phone screen in a vertical feed, transitions are visible for 0.3 seconds. Dissolves read as a smooth scene change. Wipes and slides read as energetic forward motion. Hard cuts (none) read as raw, fast-paced editing — the dominant style on TikTok. Fade-to-black between clips reads as a dramatic pause or topic shift. Fadewhite between clips creates a bright white flash on the phone screen — in dark environments this is physically jarring to viewers. Wipedown moves in the same direction as the TikTok/Reels scroll gesture, which visually mimics swiping away from the video. Zoomin is one of the more visually aggressive transitions — it reads as high energy and hype, and pairs with content that has a strong reveal or punchline at the cut point. Most professionally edited short-form content uses a mix of hard cuts and 1-2 transitions placed at the moments where the content shifts — the rest are clean cuts.

Transition sounds on short-form: On phone speakers, short percussive sounds (shutter, swoosh, thud, pop) cut through clearly because they have energy in the mid-to-high frequency range where phone speakers perform best. The shutter click pairs with cut-zoom framing changes and hard cuts. The swoosh pairs with wipe and slide transitions. The thud pairs with reveals and emphasis moments. The reverb_hit adds weight to a moment through its reverb tail. The typing sound gives text overlays a "being typed in real time" feel. The ding is a clean notification bell. The ching is a cash register sound that pairs with money-related moments. Transition sounds are audible during the 0.3-second transition window — if the speaker is talking through the transition, the sound competes with the voice. The sound draws the viewer's ear to that specific transition, so it has more impact when used on one or two transitions per video rather than on every transition.

Zoom on short-form: On a 1080px phone screen, a slow_in zoom across a 5-10 second clip creates a gradual tightening that draws the viewer closer to the subject. Viewers don't consciously notice it but it adds visual motion to an otherwise static talking-head shot. Punch_in and punch_out create an abrupt framing change at the start of the clip — this reads as intentional emphasis only when the content at that frame is worth emphasizing. If the speaker isn't changing energy or topic at that moment, the punch looks like a glitch or encoding error. On screen recordings or product demos, any zoom effect crops the UI content and makes text harder to read.

Cut-zoom on short-form: Cut-zoom is the technique that makes a single-camera talking-head video look like it was shot with two cameras. On TikTok and Reels, this is one of the most recognizable markers of a professionally edited talking-head video. It works on clips where a person is speaking to camera from a relatively fixed position. On clips with physical movement, screen recordings, or product demos, the framing jumps look unnatural because the content within the frame is also moving.

Speed on short-form: Speed manipulation is one of the most effective editing techniques on TikTok and Reels. There are two distinct ways speed is used:

Pacing adjustment: Speed changes between 1.0x and 1.15x are imperceptible to viewers on talking-head content — the speech sounds natural but the pacing feels tighter. This is used across entire clips to remove the feeling of drag without the viewer noticing.

Speed ramps for entertainment: A popular editing style on TikTok is visibly speeding up and slowing down parts of a talking-head video. This is done intentionally to match the rhythm of what the speaker is saying. The speed-up typically goes on the setup or filler portion of a sentence — the part where the speaker is building to their point. The slow-down goes on the payoff — the punchline, the key word, the reveal, the emotional beat. This creates a rhythm where the video accelerates through the less important words and lingers on the important ones. The contrast between fast and slow is what makes it entertaining — the viewer feels the emphasis physically. This technique works on content that has clear setups and payoffs in the delivery: comedy, storytelling, hot takes, advice with a punchline. It works less well on content with steady, even delivery where there's no natural emphasis point.

The speed values available per clip are: 0.5, 0.75, 1.0, 1.05, 1.1, 1.15, 1.25, 1.5, 2.0. Because speed is set per clip (not per word), the speed ramp effect comes from adjacent clips having different speeds — a 1.25x clip followed by a 0.75x clip creates the fast-then-slow rhythm. The clip structure from the pipeline determines where the speed boundaries fall, so the speed ramp effect works when clip boundaries align with the setup/payoff boundary in the speech.

On screen recordings and demos, speeds up to 1.25x work because viewers are watching visual content rather than listening to speech cadence. At 2.0x, visual content plays as a time-lapse. At 0.5x, motion becomes slow-motion which reads as dramatic emphasis on a specific visual moment.

Color grading on short-form: On a phone screen viewed in various lighting conditions (sunlight, dark room, fluorescent office), color grading needs to be visible enough to register. The color baseline measurements above tell you what the footage looks like right now. The color_intent you choose gets combined with that baseline by the rendering system. Footage that's already well-exposed and well-colored needs less adjustment. Footage that's flat, washed out, or has a strong color cast benefits from stronger grading.

Vignette on short-form: Vignette is a cinematic technique from film photography and movie lighting. It darkens the edges of the frame to draw the eye toward the center. On TikTok and Reels, vignette is not part of the standard visual language — top-performing creators and professional TikTok editors do not use it. CapCut does not apply vignette in any of its templates. On a phone screen, vignette makes the video look processed in a way that stands out from other content in the feed, and not in the way that professional editing stands out. On videos with burned-in text near the edges of the frame, vignette darkens that text.

Captions on short-form: Captions are one of the highest-impact elements on short-form platforms. They serve two functions: making the video watchable without sound, and adding visual rhythm to the edit through word-by-word animation. Bold styles (bold_white, bold_yellow) are the most common on TikTok. Keyword_pop highlights key words in color, which draws the eye to important terms. Minimal_bottom places small text in the bottom zone of the frame — on TikTok and Reels this zone is where the platform renders the creator's username and caption text, so minimal_bottom captions overlap with platform UI and become hard to read. The caption_position determines where on screen they render — lower-third and bottom are standard but compete with platform UI for space. Top and center are less conventional but more visible.

Text overlays on short-form: Text overlays on TikTok and Reels serve as visual hooks — they give the viewer something to read in the first 1-2 seconds before they've decided whether to listen to the audio. The most effective text overlays on the platform use the speaker's own words from the transcript rather than a rewritten summary, because the speaker's actual phrasing carries the tone and specificity of how they said it. On a 1080px screen, 2-4 words at title size are readable at a glance. Longer text requires the viewer to actively read, which competes with watching the video.

Outro on short-form: Because these platforms auto-loop, the transition from the last frame of the video to the first frame is a visible edit point. A hard cut ending (outro: none) loops seamlessly if the first and last frames are visually similar. Fade-to-black creates a beat of black screen on each loop. Fade-to-white creates a bright white flash on each loop — on a phone screen in a dark environment, this flash is physically uncomfortable and becomes more noticeable with each loop. The outro choice affects how the video feels on repeat views — viewers who watch a second time experience the outro-to-intro transition every loop.

The "notes" field must be 50 words maximum. Be ruthlessly brief.

=== RESPONSE FORMAT ===

Respond with ONLY this JSON object:

{
  "notes": "<50 words max. Key decisions only, no justification>",
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
  "cuts": [
    { "source_start": <n>, "source_end": <n>, "transition_out": "<transition>", "transition_sound": "<sound>", "sfx_style": "<sfx>", "zoom": "<zoom>", "cut_zoom": <true|false>, "speed": <n> }
  ]
}

=== WHO THE USER IS ===

The user is a content creator who either doesn't know how to edit or doesn't have time. They uploaded raw footage and chose a vibe because they want their content to look like they hired a professional editor. They will watch the output on their phone and compare it to what CapCut produces.

The user said: "${vibe}"

The user's vibe describes exactly what they want done to their video. Edit the video to match what they described — nothing more, nothing less. The tools and techniques you apply should be the ones the user's words call for. If their vibe doesn't reference a specific capability, they didn't ask for it.

=== THIS VIDEO ===

Duration: ${Number(analysis.duration || 0).toFixed(2)}s
Content type: ${contentType}
Visual character: ${visualCharacter}
Strongest moments: ${strongestMoments}
Weakest moments: ${weakestMoments}

Color baseline (measured from the raw footage):
  ${cb.assessment || 'No major exposure or white-balance issues detected.'}
  Brightness: ${typeof cb.brightness === 'number' ? cb.brightness : 0}, Contrast: ${typeof cb.contrast === 'number' ? cb.contrast : 1}, Saturation: ${typeof cb.saturation === 'number' ? cb.saturation : 1}, Gamma: ${typeof cb.gamma === 'number' ? cb.gamma : 1}, Temperature: ${cb.color_temperature || 'neutral'}

Frame layout:
  Subject: ${frameLayout.subject_position}
  Existing overlays: ${frameOverlayLocations}
  ${hasBurnedCaptions ? 'Captions are already burned into the video frames.' : 'No burned-in captions detected.'}
  Open space for graphics: ${frameLayout.free_zones}

Platform safe zones (9:16 vertical):
  Bottom 20% of frame is covered by TikTok/Reels/Shorts UI (username, caption text, like/comment/share buttons) — text placed here is hidden.
  Top 10% may be partially covered by status bar.
  Safe zone for text: middle 70% vertically.

=== SHOTS ===

${shotsBlock}

=== TRANSCRIPT ===

${speechBlock}

=== SCENE FRAMES ===

Frame thumbnails with timestamps — the actual images from the video at each scene change.

=== REFERENCE DATA FOR YOUR CUTS ===

Scene changes detected by FFmpeg (reliable visual cut timestamps):
${sceneChangesBlock}

Speech boundaries detected by Deepgram (timestamps where sentences end with a natural pause):
${speechBoundariesBlock}

${tightenedBlock || `Tightened timeline (dead air and filler words already removed):
  Original: ${Number(analysis.duration || 0).toFixed(2)}s → Tightened: ${tightenedDuration.toFixed(2)}s (removed ${Number(tightened?.removedSeconds || 0).toFixed(2)}s)
  Keep segments: none`}

These are reference points for choosing your cuts. Scene change timestamps produce visually clean cuts because the image is already changing at that frame. Speech boundary timestamps produce audio-clean cuts because the speaker is pausing naturally. Cutting at other timestamps is valid when the footage calls for it — the pipeline will force keyframes at your chosen timestamps to ensure frame-perfect extraction.

`;
  const splitMarker = '=== WHO THE USER IS ===';
  const splitIndex = fullPrompt.indexOf(splitMarker);
  if (splitIndex === -1) {
    throw new Error('Prompt split marker not found');
  }
  const staticPrefix = fullPrompt.slice(0, splitIndex).trim();
  const dynamicSuffix = fullPrompt.slice(splitIndex).trim();
  return { staticPrefix, dynamicSuffix };
}

module.exports = { generateEdit, expandVibeIntent };
