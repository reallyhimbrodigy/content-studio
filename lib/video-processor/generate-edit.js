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

async function generateEdit(analysis, transcript, vibe, onProgress, preExpandedVibe = null) {
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

  console.log('[generate-edit] Starting Claude API call...');
  const claudeStartedAt = Date.now();
  let response;
  try {
    response = await withTimeout(
      anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        temperature: 0.4,
        messages: [{ role: 'user', content: prompt }],
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

  // Promptly does not add background music.
  if (editPlan.background_music && editPlan.background_music !== 'none') {
    console.log(`[generate-edit] Ignoring background_music="${editPlan.background_music}" — music disabled`);
  }
  editPlan.background_music = 'none';
  editPlan.audio_ducking = false;

  for (const clipEntry of editPlan.clips) {
    if (!clipEntry.transition_sound) clipEntry.transition_sound = 'none';
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

  return `You are a professional short-form video editor cutting raw footage into a polished TikTok / Instagram Reels / YouTube Shorts clip.

Brief: "${vibe}"

=== FOOTAGE ===
Duration: ${analysis.duration}s
${profileBlock}
${audioBlock}
${colorBaselineBlock}

Shots:
${shotsBlock}

${speechBlock}
${deepgramBlock}
${cutPointsBlock}
${highlightsBlock}
${clipsBlock}
${tightenedBlock}
${brollCandidatesBlock}
${frameContext}
${platformSafeZones}

=== YOUR JOB ===

You are a professional short-form video editor specializing in TikTok, Instagram Reels, and YouTube Shorts. Your edits should look like they came from CapCut — punchy, bold, optimized for mobile viewers scrolling their feed. Every choice you make should maximize watch time and engagement.

Platform context: Viewers decide in the first 2-3 seconds whether to keep watching. Bold captions significantly boost retention and engagement — most viral short-form content uses captions. Subtle edits get scrolled past. When in doubt, be bold rather than understated. Match your editing energy to the content — hype content gets fast transitions and punchy zooms, educational content gets clean transitions and readable captions, emotional content gets smooth fades and warm tones.

The numbered clips above are your edit structure. Each clip is a clean cut between natural pauses or scene changes. Your job is to choose a transition between each clip and set the color grade.

The client brief is your creative direction. Every decision you make should deliver what the client described.
You have full context about this footage — the shots, the frame layout, existing overlays, and platform constraints. Use common sense. If the video already has burned-in captions (check the frame layout analysis), use caption_style "none" to avoid doubling up. Otherwise, lean toward adding captions — they significantly boost engagement on short-form platforms. If the brief doesn't mention text, you probably don't need to add text. If you do add text or captions, place them where they won't be hidden by the platform UI and won't cover the subject's face. Think about it like a real editor would.
Every video is different and your edit should reflect that. A real editor watches the footage, feels the energy, and makes choices that serve THIS specific video — not choices that would work on any video. Lean into what makes this particular footage unique. The best short-form editors make bold, specific creative choices rather than safe, generic ones.

Transitions available:
  none — no transition, clean cut to the next clip
  fade — gradual opacity fade, good for endings
  fadeblack — fade through black, good for topic changes
  fadewhite — fade through white, good for bright or dreamy moments
  dissolve — cross-fade blend, best between different scenes or locations
  wipeleft — slide wipe left, good for moving forward in a sequence
  wiperight — slide wipe right, good for callbacks or contrasts
  wipeup — vertical wipe up, good for reveals
  wipedown — vertical wipe down, good for conclusions
  smoothleft — polished slide left
  smoothright — polished slide right
  smoothup — polished slide up
  smoothdown — polished slide down
  zoomin — zoom into next clip, good for emphasis

Transition sounds:
  none — no sound
  whoosh — fast air swoosh for slide and swipe transitions
  swoosh — softer swoosh for smooth vertical transitions
  pop — bubble pop for text appearances and hard cuts
  boom — bass impact for dramatic reveals and hooks
  ding — chime for product demos and calls to action
  rise — ascending tone for topic shifts and pre-reveal moments
  cashier — register cha-ching for pricing, discounts, and money references

Background music:
  none — Promptly does not add music. Users add their own music from TikTok/Instagram after export.
  Always use "none".

Zoom:
  none, slow_in, slow_out, punch_in, punch_out

Cut-zoom:
  true — alternates between normal and slightly zoomed framing at sentence boundaries within the clip. Creates the appearance of a multi-camera shoot from a single take.
  false — no cut-zoom, use standard framing.
  
Cut-zoom is one of the most effective techniques for talking-head content, but like any technique, it works best when it's not the only thing happening visually. A video where every clip uses the same framing technique feels monotonous — the same way a song where every instrument plays at the same volume feels flat. Think about visual rhythm: some clips benefit from cut-zoom energy, some land better with a steady frame, and some work best with a slow zoom that builds tension. Consider what each clip is showing and what the speaker is doing — screen recordings and product demos almost always look better without cut-zoom.

Captions:
  none — only use when video already has burned-in captions
  standard — clean white text, good for professional/corporate content
  bold_centered — bold white text centered on screen, versatile
  minimal_bottom — small subtle text at bottom, understated
  animated_word — word-by-word pop synced to speech, very high engagement
  bold_white — large bold white with thick black outline, the classic TikTok look
  bold_yellow — large bold yellow with thick black outline, high energy and attention-grabbing
  keyword_pop — white text with key words highlighted in color (green/red/yellow), great for educational content. If you choose this, you MUST include a "caption_keywords" array in your response with 3-8 important words from the transcript to highlight.
  box_caption — white text on dark semi-transparent box, clean Instagram style

Speed:
  1.0 (normal), 0.5 (half speed), 0.75 (slight slow-mo), 1.25 (slightly fast), 1.5 (fast), 2.0 (double speed)

Pacing is one of the biggest differences between amateur and professional edits. Real editors adjust speed to match the energy of what's being said. Clips where the speaker pauses or takes breaths between thoughts can feel tighter with a slight speed increase that the viewer won't consciously notice. Key moments or reveals can land harder with a subtle slowdown that gives the brain an extra beat to process. Supporting visuals like screen recordings or demos often benefit from being slightly sped up since they're illustrating a point, not carrying the narrative. The goal is to keep the viewer's attention locked — if a clip feels like it drags, it probably needs a pacing adjustment.

Text overlays:
  Provide an array of text items, each with: text, position (top, center, bottom), appear_at (clip number), style (title, callout, cta)
  IMPORTANT: Do NOT include emojis in text overlay text. Use plain text only — emojis cannot be rendered in the video.
  The most effective text overlays use the speaker's own language from the transcript rather than a sanitized summary. The words the speaker actually chose are almost always more engaging and authentic than a rewritten version. Shorter text has more impact on a phone screen than longer text. If the video already has burned-in captions that cover the key moments, consider whether additional text adds value or just adds visual noise.
  Or "none" if not needed.

B-roll:
  Provide an array of b-roll moments, each with: keyword (search term), timestamp (seconds), duration (1-3 seconds).
  B-roll overlays the main video briefly to illustrate concrete visual concepts.

Think about b-roll the way a real editor does. The opening seconds of a short-form video are where the viewer decides to stay or scroll — the speaker's face, energy, and eye contact are doing the heavy lifting there, so consider whether covering them with stock footage helps or hurts. B-roll tends to land best where it can re-engage viewers and add visual variety during explanations or descriptions. It works well to illustrate concrete things — a product, an action, a place — rather than abstract ideas. If the video already has a screen recording or product demo, that's already visual variety and layering b-roll on top may be redundant.

Outro:
  none — hard cut ending. The video ends on the last word or action.
  fade_black — fade through black.
  fade_white — fade through white.

Think about how this video ends on a phone screen. On TikTok and Reels, a fade-out often signals viewers to scroll before the video finishes — great content can lose its punch this way. A hard cut ending keeps energy through the last frame. That said, some content genuinely benefits from a fade — an emotional story, a cinematic moment, a deliberate pause. Match the ending to the content's energy and intent.

Aspect ratio:
  original, 9:16, 16:9, 1:1, 4:5

Vignette:
  none, light, medium, strong

Color: Choose one color_intent that serves THIS specific video based on the color baseline assessment above.

The color baseline tells you exactly what this footage looks like right now. Your job is to choose a grade that enhances what's already there, not to apply a generic filter. Read the baseline assessment carefully — it tells you whether the footage is flat, overexposed, warm, cool, or already well-graded. Footage that already looks great needs a lighter touch. Footage that looks flat or washed out can handle a stronger grade. Footage with a strong existing character should be enhanced, not fought against.

Available intents: ${intents}

Respond with ONLY this JSON structure. Use clip NUMBERS, not timestamps:

{
  "strategy": "<your creative rationale>",
  "color_intent": "<one word from the list>",
  "background_music": "none",
  "caption_style": "<style from the captions list — most short-form videos perform better WITH captions>",
  "caption_position": "<where to place captions: 'top', 'center', 'lower-third', 'bottom' — choose based on frame layout and platform safe zones>",
  "caption_keywords": ["<only if caption_style is keyword_pop: 3-8 important words from the transcript to highlight in color>"],
  "audio_ducking": false,
  "outro": "<none, fade_black, or fade_white>",
  "aspect_ratio": "<original, 9:16, 16:9, 1:1, or 4:5>",
  "vignette": "<none, light, medium, or strong>",
  "text_overlays": [
    { "text": "<text to display>", "position": "<top, center, or bottom>", "appear_at_clip": <clip number>, "style": "<title, callout, or cta>" }
  ],
  "broll": [
    { "keyword": "<visual search term>", "timestamp": <seconds>, "duration": <1-3> }
  ],
  "clips": [
    { "clip": 1, "transition_out": "<transition>", "transition_sound": "<sound or none>", "zoom": "<zoom or none>", "cut_zoom": <true or false>, "speed": <number> },
    { "clip": 2, "transition_out": "<transition>", "transition_sound": "<sound or none>", "zoom": "<zoom or none>", "cut_zoom": <true or false>, "speed": <number> }
  ]
}`;
}

module.exports = { generateEdit, expandVibeIntent };
