'use strict';
// RED PROOF — the fulfilment judge must catch a planted drop.
//
// Zac named three. Each is built by MUTATING a baseline record that the judge
// scores clean, and each mutation is VERIFIED TO HAVE APPLIED before the
// verdict is read — a plant that silently failed to change the record would
// produce a green that proves nothing, which is the oldest way a proof lies.
const { judgeRun, cost } = require('./fulfilment_judge_v2.js');

const BASE = {
  id: 'rp-base',
  brief: 'Edit this into a tight reel. Add captions.',
  ops: [
    { tool: 'edit_captions', args: { style: 'bold' }, why: 'the brief asks for captions' },
    { tool: 'edit_item', args: { trim: true }, why: 'tightening per the brief' },
  ],
  timeline: { caption_track: true, caption_language: 'en', items: 6, duration_s: 31.2, components: [], audio_tracks: ['dialogue'] },
  agent_reply: 'Tightened the cut and added captions.',
  rewatch: [{ verdict: 'clean' }],
};

const CASES = [
  {
    name: 'Hinglish captions asked, English captions delivered -> DROPPED',
    want: 'DROPPED_SILENTLY',
    ask: /hinglish|language/i,
    mutate: r => { r.brief = 'Edit this into a tight reel. Add captions in Hinglish.'; return r; },
    applied: r => /hinglish/i.test(r.brief) && r.timeline.caption_language === 'en',
    applied_why: 'brief must name Hinglish AND the timeline must still say caption_language=en',
  },
  {
    name: '"no captions" asked, a caption track is present -> DROPPED',
    want: 'DROPPED_SILENTLY',
    ask: /caption/i,
    mutate: r => { r.brief = 'Edit this into a tight reel. No captions at all.'; return r; },
    applied: r => /no captions/i.test(r.brief) && r.timeline.caption_track === true,
    applied_why: 'brief must forbid captions AND caption_track must still be true',
  },
  {
    name: 'music refused in an op `why` -> NEGOTIATED, not DROPPED',
    want: 'NEGOTIATED',
    ask: /music/i,
    mutate: r => {
      r.brief = 'Edit this into a tight reel. Add captions and some background music.';
      r.ops.push({ tool: 'edit_track', args: {}, why: 'cannot add music, proceeding without' });
      r.agent_reply = 'Tightened the cut and added captions. I cannot add music, so I proceeded without it.';
      return r;
    },
    applied: r => /music/i.test(r.brief) && r.ops.some(o => /cannot add music/i.test(o.why || '')),
    applied_why: 'brief must ask for music AND an op `why` must refuse it',
  },
];

(async () => {
  console.log('RED PROOF — fulfilment judge v2');
  // BASELINE FIRST: the judge must score the unmutated record clean, or a red
  // below could be the judge failing on everything rather than on the plant.
  const base = await judgeRun(JSON.parse(JSON.stringify(BASE)));
  const baseBad = base.asks.filter(a => a.verdict === 'DROPPED_SILENTLY');
  console.log(`  baseline: ${base.asks.length} ask(s), ${baseBad.length} silently dropped -> ${baseBad.length === 0 ? 'CLEAN' : 'NOT CLEAN'}`);
  if (baseBad.length) { console.log(JSON.stringify(base.asks, null, 1)); process.exit(1); }

  let allok = true;
  for (const c of CASES) {
    const rec = c.mutate(JSON.parse(JSON.stringify(BASE)));
    if (!c.applied(rec)) {                       // the plant must really be there
      console.log(`  MISS    [plant did not apply] ${c.name}\n          needed: ${c.applied_why}`);
      allok = false; continue;
    }
    const out = await judgeRun(rec);
    const hit = out.asks.filter(a => c.ask.test(a.text) || c.ask.test(a.class));
    const got = hit.map(a => a.verdict);
    const ok = got.includes(c.want);
    if (!ok) allok = false;
    console.log(`  ${ok ? 'RED ok ' : 'MISS   '} ${c.name}`);
    console.log(`          plant applied: yes | matching ask(s): ${hit.length} | verdict(s): ${got.join(', ') || '(none matched)'}`);
    for (const a of hit) console.log(`            "${a.text}" -> ${a.verdict}  noted=${JSON.stringify(a.noted_where)}`);
  }
  // ── ZAC'S SEP-9 LAW: placing more than was asked is a FAILURE ─────────
  // The judge could not see this before — it scored what was asked and never
  // what was added, so a surgical brief answered with a full edit scored 1.0.
  console.log('\n  SURGICAL SCOPE — did more than asked:');

  // A SURGICAL brief: one change named. The record also adds three zooms.
  const SURG = {
    id: 'rp-surgical',
    brief: 'Just make the captions bigger.',
    request_class: 'SURGICAL_REEDIT',
    ops: [
      { tool: 'edit_captions', args: { size: 'large' }, why: 'the brief asks for bigger captions' },
      { tool: 'edit_item', args: { type: 'effect', kind: 'zoom', at: 2.0 }, why: 'adds energy' },
      { tool: 'edit_item', args: { type: 'effect', kind: 'zoom', at: 7.5 }, why: 'adds energy' },
      { tool: 'edit_item', args: { type: 'effect', kind: 'zoom', at: 14.0 }, why: 'adds energy' },
    ],
    timeline: { caption_track: true, caption_language: 'en', items: 4, duration_s: 20.4,
                components: [{ kind: 'zoom' }, { kind: 'zoom' }, { kind: 'zoom' }],
                audio_tracks: ['dialogue'] },
    agent_reply: 'Made the captions bigger and added some zooms for energy.',
  };
  const sv = await judgeRun(JSON.parse(JSON.stringify(SURG)));
  const capHonored = sv.asks.some(a => /caption/i.test(a.text) && a.verdict === 'HONORED');
  const sOk = sv.did_more_than_asked >= 3 && sv.scope_verdict === 'FAILED_DID_MORE_THAN_ASKED' && capHonored;
  if (!sOk) allok = false;
  console.log(`  ${sOk ? 'RED ok ' : 'MISS   '} three unasked zooms on a surgical brief -> ${sv.scope_verdict}, did_more=${sv.did_more_than_asked}`);
  console.log(`           and the ASK itself still reads HONORED (${capHonored}) — the failure is the EXTRA, not the ask`);
  for (const u of (sv.unasked || []).slice(0, 4)) console.log(`             unasked: ${u.what} — ${u.evidence}`.slice(0, 118));

  // GREEN: the SAME placements under a PRESET brief are the preset working.
  const PRESET = { ...JSON.parse(JSON.stringify(SURG)), id: 'rp-preset',
    brief: 'Viral engaging video', request_class: 'PRESET' };
  const pv = await judgeRun(PRESET);
  const pOk = pv.scope_verdict !== 'FAILED_DID_MORE_THAN_ASKED';
  if (!pOk) allok = false;
  console.log(`  ${pOk ? 'RED ok ' : 'MISS   '} [green] the SAME zooms under a PRESET brief -> ${pv.scope_verdict}`);
  console.log(`           a preset licenses the standard families; flagging them would make the check noise`);

  // GREEN: a surgical brief answered with ONLY the asked change is clean.
  const CLEAN = { ...JSON.parse(JSON.stringify(SURG)), id: 'rp-surgical-clean',
    ops: [SURG.ops[0]],
    timeline: { ...SURG.timeline, items: 1, components: [] },
    agent_reply: 'Made the captions bigger.' };
  const cv = await judgeRun(CLEAN);
  const cOk = cv.did_more_than_asked === 0 && cv.scope_verdict === 'IN_SCOPE';
  if (!cOk) allok = false;
  console.log(`  ${cOk ? 'RED ok ' : 'MISS   '} [green] surgical brief, only the asked change -> ${cv.scope_verdict}, did_more=${cv.did_more_than_asked}`);

  // ── RULE (b): NOTHING THE USER LIKED WAS TOUCHED ─────────────────────
  console.log('\n  RE-EDIT SCOPE — nothing the user liked was touched:');
  const BEFORE = { items: [
    { id: 'v1', from: 0,   dur: 300, track: 'V1', kind: 'video' },
    { id: 'c1', from: 40,  dur: 60,  track: 'V2', kind: 'motion-graphic' },
    { id: 'z1', from: 150, dur: 30,  track: 'V3', kind: 'effect' },
  ]};
  const mk = (after, extra = {}) => ({
    id: 'rp-reedit', brief: 'Make the captions bigger.',
    request_class: 'SURGICAL_REEDIT',
    ops: [{ tool: 'edit_captions', args: { size: 'large' }, why: 'the tweak' }],
    before_timeline: BEFORE,
    timeline: { caption_track: true, items: after.items.length, duration_s: 20.4,
                components: [], audio_tracks: ['dialogue'], ...after },
    agent_reply: 'Captions are bigger.', ...extra });

  // the tweak alone: every before-item survives unchanged
  const clean = await judgeRun(mk({ items: BEFORE.items.map(i => ({ ...i })) }));
  const r1 = clean.untouched_state === 'MEASURED' && clean.touched_without_an_ask === 0;
  if (!r1) allok = false;
  console.log(`  ${r1 ? 'RED ok ' : 'MISS   '} [green] only the tweak -> ${clean.scope_verdict}, kept=${clean.untouched_kept}, touched=${clean.touched_without_an_ask}`);

  // a zoom the user already had is silently deleted — the failure rule (b) exists for
  const harmed = await judgeRun(mk({ items: BEFORE.items.filter(i => i.id !== 'z1').map(i => ({ ...i })) }));
  const r2 = harmed.touched_without_an_ask >= 1 && harmed.scope_verdict === 'FAILED_TOUCHED_WHAT_WAS_LIKED';
  if (!r2) allok = false;
  console.log(`  ${r2 ? 'RED ok ' : 'MISS   '} a zoom the user already had is REMOVED -> ${harmed.scope_verdict}, touched=${harmed.touched_without_an_ask}`);
  console.log(`           ${JSON.stringify(harmed.touched_detail && harmed.touched_detail[0] || null)}`.slice(0, 118));

  // NO BEFORE-TIMELINE: the judge must say ABSENT, not pass and not fail
  const blind = await judgeRun(mk({ items: BEFORE.items.map(i => ({ ...i })) }, { before_timeline: null }));
  const r3 = blind.untouched_state === 'ABSENT' && blind.touched_without_an_ask === null;
  if (!r3) allok = false;
  console.log(`  ${r3 ? 'RED ok ' : 'MISS   '} no before-timeline -> untouched_state=${blind.untouched_state}, touched=${JSON.stringify(blind.touched_without_an_ask)}`);
  console.log(`           not a pass and not a fail: "left alone" and "never existed" are indistinguishable`);

  // ── THE DURATION DERIVATION — Builder-1 caught this and it was real ───
  // ChatCut omits durationInFrames on an untrimmed item. Comparing the raw
  // field made two IDENTICAL timelines read kept=0, touched=every row, which
  // would have failed rule (b) on every re-edit. Both sides must derive or
  // neither can.
  console.log('\n  DURATION DERIVATION:');
  const { diffTimelines } = require('./fulfilment_judge_v2.js');
  const RAW_B = { items: [
    { id: 'a', fromFrame: 0,   toFrame: 335, trackAlias: 'V1', itemType: 'video' },
    { id: 'b', fromFrame: 565, toFrame: 611, trackAlias: 'V2', itemType: 'motion-graphic' }] };
  const RAW_A = { items: [
    { id: 'a', fromFrame: 0,   toFrame: 335, durationInFrames: 335, trackAlias: 'V1', itemType: 'video' },
    { id: 'b', fromFrame: 565, toFrame: 611, durationInFrames: 46,  trackAlias: 'V2', itemType: 'motion-graphic' }] };
  const d1 = diffTimelines(RAW_B, RAW_A);
  const g1 = d1.kept === 2 && d1.touched.length === 0;
  if (!g1) allok = false;
  console.log(`    ${g1 ? 'RED ok ' : 'MISS   '} [green] identical timelines, one read omitting durationInFrames -> kept=${d1.kept}, touched=${d1.touched.length}`);

  const RETIMED = JSON.parse(JSON.stringify(RAW_A));
  RETIMED.items[1].durationInFrames = 90; RETIMED.items[1].toFrame = 655;
  const d2 = diffTimelines(RAW_B, RETIMED);
  const g2 = d2.touched.length === 1 && d2.touched[0].id === 'b';
  if (!g2) allok = false;
  console.log(`    ${g2 ? 'RED ok ' : 'MISS   '} a genuinely retimed item is still caught -> ${d2.touched.length} touched (${d2.touched[0] && d2.touched[0].id})`);

  const SHORT = { items: [
    { id: 'a', from: 0,   dur: 335, track: 'V1', kind: 'video' },
    { id: 'b', from: 565, dur: 46,  track: 'V2', kind: 'motion-graphic' }] };
  const d3 = diffTimelines(SHORT, RAW_A);
  const g3 = d3.touched.length === 0;
  if (!g3) allok = false;
  console.log(`    ${g3 ? 'RED ok ' : 'MISS   '} [green] the short-name and ChatCut spellings agree -> ${d3.touched.length} touched`);

  console.log(`RED PROOF: ${allok ? 'PASS' : 'FAIL'} — 3 planted drops + 3 scope + 3 re-edit + 3 duration legs`);
  console.error(`judge cost $${cost().toFixed(4)} over 4 runs = $${(cost() / 4).toFixed(4)}/run`);
  process.exit(allok ? 0 : 1);
})();
