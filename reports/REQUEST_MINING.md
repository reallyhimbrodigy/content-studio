# REQUEST MINING — what users actually ask for (full corpus)

**Lane 1 / JUDGE, 2026-08-10. Sources: all 6,352 `vibe_input`(+`change_request`) texts `[MEASURED]` (`scripts/request-mining.js`, regex v1) cross-validated by the LLM judge's ask decomposition on the 1,282 recipe-bearing jobs `[MEASURED]` (`scripts/fulfillment-judge.js`). PostgREST paginated throughout.**

## The headline split
- **Preset taps: 2,540 / 6,352 = 40.0%** — 7 distinct strings; "Viral engaging video" alone is 1,306 (20.6% of ALL requests). "Clean and engaging edit" 540, "Professional corporate style" 276, "Make this a smooth video, add zooms, sound effects and motion graphics" (3 variants) 309, "Fast paced punchy" 109.
- **Custom requests: 3,812 = 60.0%.** The majority of users type something specific. This corpus is the roadmap input.

**Note the third preset's content:** 309 preset taps *literally name* zooms + sound effects + motion graphics. Fulfillment on those components is a preset-path promise, not an edge case (see FULFILLMENT_BASELINE — motion_graphics is the #1 concrete silent drop).

## Buckets (custom requests, first-match regex; n=3,812)
| bucket | n | % of custom |
|---|---|---|
| unbucketed (named below) | 934 | 24.5% |
| **language / captions** | 905 | 23.7% |
| zoom / effects / MG | 640 | 16.8% |
| **generative AI** | 626 | 16.4% |
| style (generic) | 390 | 10.2% |
| pacing / cuts | 169 | 4.4% |
| music / audio | 148 | 3.9% |

## Deep cut 1 — language/captions (the 23.7%): what exactly they ask
| sub-intent | n | note |
|---|---|---|
| add captions/subtitles, **no language named** | 492 | the dominant ask by far — supported, and the judge shows it 82% honored |
| translate (whole video / unspecified target) | 31 | NOT supported — no translation path exists |
| captions **in a specific language** (Hindi, Spanish, …) | 27 | e.g. "Make captions in hindi in this video"; judge: 17/37 honored, 17 dropped-silently |
| fix caption spelling/accuracy | 24 | re-edit-shaped ask; the surgical path is 0.11% of traffic |
| remove captions | 6 | |

**Read:** the bucket is dominated by *supported* caption asks (good), but **translation (31+27=58 explicit asks) is the biggest *unsupported* language demand**, and the judge's class table confirms `captions_language` drops silently ~46% of the time when asked.

## Deep cut 2 — generative (the 16.4%): top asks by count
| sub-intent | n | note |
|---|---|---|
| **upscale / quality enhance (4K/8K/HD/clarity)** | 195 | the single biggest generative-bucket ask; users say "Trun in to 4k", "8k", "make video HD" — today judged DROPPED_SILENTLY (not on the unsupported list, no note fires) |
| generate scene/background/world | 81 | "change Background to professional Studio…", "luxury swimming pool" |
| make subject speak/sing (synthetic speech) | 34 | + 35 explicit voiceover asks in the judge corpus — all UNSUPPORTED today |
| AI image/graphic generation | 27 | |
| transform me into X (avatar/character) | 12 | "Make me a Zulu King…" |
| insert people/objects | 5 | |

**Read:** the generative demand is real but *narrower than "generative AI" suggests* — **the #1 ask is resolution/quality enhancement (195×)**, which is neither built nor noted; background replacement (81×) is second. Full synthetic video ("Veo-style") requests exist but are a tail.

## The unbucketed 24.5%, named `[MEASURED sample]`
- **~86% content-descriptions-as-titles** — users describing the video, not asking ("He speaking about jdm cars", one user's repeated Paw-Patrol captions). Not asks; correctly excluded from fulfillment denominators (judge rubric emits zero asks for these).
- **47+ non-Latin-script requests** (Russian, Hindi, Arabic, Khmer…) the regex can't parse — e.g. "Сделай рилс с субтитрами и подходящими картинками" (= "make a reel with subtitles and matching pictures" — a real captions+broll ask). **The LLM judge reads these; regex v1 undercounts every bucket by roughly this margin.** `[INFERRED]`
- Hook/retention/story asks (11): "High converting video", "Find the story in this, edit accordingly".
- Audio-enhancement asks the regex missed: "Enhence my voice like it recorded in studio. With some reverb & autotunes".
- **1 multi-clip ask** ("combine these videos") in the unbucketed sample; more live inside bucketed texts ("Turn these videos into one fast-paced YouTube short…"). Multi-input demand exists but is small in this corpus. `[MEASURED, sample-based]`

## Judge cross-validation (LLM-labeled classes, 3,104 asks over 1,282 jobs)
Top ask classes by volume: style_preset 1,002 · motion_graphics 324 · zoom 282 · sound_effects 281 · captions 209 · other 157 · text_overlay 102 · pacing 99 · color_grade 93 · generative_ai 75 · music 62 · cut_content 68 · specific_moment_edit 54 · captions_language 37 · voiceover 35 `[MEASURED]`. Consistent with the regex buckets modulo the preset mass; the judge sees non-English and multi-ask texts the regex can't.

## What the capability lane should build in, this order (by counted demand × current drop rate)
1. **Quality/upscale ask handling** (195× asked, 100% silently dropped today — even an honest note would move the number; an actual upscale path moves it more).
2. **Caption translation / captions-in-language-X** (58 explicit + the 46% silent-drop rate on captions_language).
3. **Background replacement / scene generation** (81×; the matting + genscene assets exist dark in the worker per recon).
4. **Background music** (62 asks, 0 honored, 59 unsupported — highest fully-unsupported class with real demand).
5. **Voiceover/TTS** (69 combined asks, all unsupported).

Known limits: regex v1 undercounts non-English (~1–2% of corpus) and multi-ask texts; bucket order biases first-match; the judge covers only recipe-bearing jobs. The daily judge cron labels every new job from here on, so this table self-refreshes.
