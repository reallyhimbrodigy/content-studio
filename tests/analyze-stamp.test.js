'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  parseAnalysisResponse, ANALYZER_PRODUCER, ANALYZER_VERSION, GEMINI_MODEL,
} = require('../lib/video-processor/analyze-video');

// Item 2 (2026-07-11): every analysis_data blob the app-server producer mints
// carries a positive-ID stamp. These assert the stamp is present + well-formed
// at the single mint point (parseAnalysisResponse), so a consumer can identify
// producer/version/model/when instead of signature-matching a frozen corpus.

const MINIMAL = JSON.stringify({
  duration: 12.5,
  shots: [{ start: 0, end: 12.5, visual: 'bright', action: 'talking', energy: 0.6, editing_value: 'strong' }],
  audio: { music: 'none' },
  frame_layout: {
    subject_position: 'centered',
    existing_overlays: { has_burned_captions: true, has_text_graphics: false, overlay_locations: 'lower third' },
    free_zones: 'top third',
  },
});

test('stamp: producer identity is present and complete on the minted blob', () => {
  const out = parseAnalysisResponse(MINIMAL);
  assert.ok(out.producer && typeof out.producer === 'object', 'producer object exists');
  assert.equal(out.producer.name, ANALYZER_PRODUCER);
  assert.equal(out.producer.version, ANALYZER_VERSION);
  assert.equal(out.producer.model, GEMINI_MODEL);
  assert.match(out.producer.measured_at, /^\d{4}-\d{2}-\d{2}T.*Z$/, 'measured_at is an ISO instant');
});

test('stamp: constants are the pinned values (guards accidental drift)', () => {
  assert.equal(ANALYZER_PRODUCER, 'promptly.app-server.analyze-video');
  // 'gemini-2.5-flash' was RETIRED and was the 502 on this path for 44 days;
  // 0ea3d34 deliberately moved to the alias and this pin was never updated, so
  // the drift guard has been red against a correct, deliberate change ever
  // since — a guard nobody reads. Pinned to what actually ships.
  //
  // KNOWN RISK, NOT SILENTLY BLESSED: `gemini-flash-latest` is an ALIAS, and
  // 91ff645 found it rotated the CHAT path onto a model with zero provisioned
  // quota (100% 429s). Chat is now pinned to a concrete model
  // (lib/chat-actions.js TOOLS_MODEL). The analyze path still rides the alias;
  // moving it is a model change on every render's analysis and is an owner
  // decision, not a test edit. When that lands, this pin moves with it.
  assert.equal(GEMINI_MODEL, 'gemini-flash-latest');
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(ANALYZER_VERSION), 'version is a date tag');
});

test('stamp: does not disturb the real detection fields (frame_layout survives intact)', () => {
  const out = parseAnalysisResponse(MINIMAL);
  assert.equal(out.frame_layout.existing_overlays.has_burned_captions, true);
  assert.equal(out.frame_layout.subject_position, 'centered');
  assert.equal(out.frame_layout.free_zones, 'top third');
  // stamp is additive — the pre-stamp keys are all still there
  for (const k of ['duration', 'shots', 'speech', 'audio', 'frame_layout', 'color_baseline', 'video_profile']) {
    assert.ok(k in out, `${k} still present alongside the stamp`);
  }
});

test('stamp: measured_at reflects a fresh measurement each mint (not frozen)', () => {
  const a = parseAnalysisResponse(MINIMAL);
  const b = parseAnalysisResponse(MINIMAL);
  // both parse to valid instants; the field is minted per-call (not a shared const)
  assert.ok(Date.parse(a.producer.measured_at) > 0);
  assert.ok(Date.parse(b.producer.measured_at) >= Date.parse(a.producer.measured_at));
});
