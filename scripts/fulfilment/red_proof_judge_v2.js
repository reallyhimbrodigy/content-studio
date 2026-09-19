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
  console.log(`RED PROOF: ${allok ? 'PASS' : 'FAIL'} — 3 planted cases, baseline clean`);
  console.error(`judge cost $${cost().toFixed(4)} over 4 runs = $${(cost() / 4).toFixed(4)}/run`);
  process.exit(allok ? 0 : 1);
})();
