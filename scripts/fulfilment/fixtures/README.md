# Two constructed fixtures — the gaps D2 could not cover

Built from the EXISTING reliability fixtures. No new media was captured, and no
production media is retained (standing law).

**STAGED 2026-09-18.** Uploaded to the existing fixtures prefix and verified
readable through the lane's own `presign.py` (HTTP 206 on all four):

    ab-sources/reliability-fixtures-v3/talking_head_hi-7282e45a.mp4
    ab-sources/reliability-fixtures-v3/multiclip_a-acece224.mp4
    ab-sources/reliability-fixtures-v3/multiclip_b-79a536dd.mp4
    ab-sources/reliability-fixtures-v3/multiclip_c-f89c7a74.mp4

The `h_stage.sh` entries were SENT TO BUILDER-1, not written — that file is his.

**The multi-clip fixture does not fit the staging shape, and the placeholder is
deliberately withheld.** `key()` returns ONE key and the stage body presigns one
SRC; three sources need either three presigns or a `--clip-urls` list. Staging
`multiclip_a` alone under the name "multiclip" would quietly exercise the
SINGLE-source path under a multi-clip name — worse than leaving the row
UNRUNNABLE, so it stays unrunnable until the interface exists.

## `talking_head_hi.mp4` — a non-English talking head

`make_hindi_fixture.sh`. The existing `talking_head-f4195ca9.mp4` with its audio
replaced by Hindi speech of a translated script.

| property | value |
|---|---|
| video stream | **byte-identical to the original** (MD5 `26b0729043...` both) — same face, same motion, provably |
| duration | 20.362s, exactly the original |
| audio | Hindi, replacing the English original |
| ASR round-trip | Deepgram `language=hi` returns 152/291 Devanagari chars at **0.996** confidence — it is Hindi to the pipeline's own ear |
| **lip-sync** | **OFF BY CONSTRUCTION — a recorded property, not a defect.** The mouth forms English words while the audio is Hindi. Anything scoring this fixture on mouth/audio agreement is measuring the fixture, not the pipeline. |
| voice | **macOS `Lekha` (hi_IN), NOT ElevenLabs** — see below |

**The voice is a deviation from the ruling and it is not a budget one.** Zac
ruled ElevenLabs, natural voice, capped at $1. The ElevenLabs account is on the
FREE tier with **9,999 of 10,000 characters already used — 1 character
remaining**. The script needs 454. The cap was never the binding constraint;
the quota is, and topping it up is a billing decision.

So the chain is built and proven end to end, with the system voice standing in.
`TTS_VOICE` swaps it; re-running the script with an ElevenLabs step is the only
change needed, and everything downstream — fitting, muxing, the byte-identical
video — is already verified.

## `multiclip_{a,b,c}.mp4` — three sources for a multi-clip brief

`make_multiclip.sh`. One 6s segment cut from each of the three existing
fixtures, as three separate files.

| property | value |
|---|---|
| determinism | **byte-identical on rebuild**, all three — fixed seeks, fixed durations, fixed encoder settings, no wall-clock |
| geometry | normalised to 1080x1920 / 30fps / stereo 44.1k |
| content | genuinely different: a talking head, a high-motion clip, a car exterior |

**MIXED GEOMETRY IS NOT COVERED, and that is stated rather than discovered
later.** The three sources are natively 1080x1920@30, 540x960@59.94 and
2160x3840@30. Leaving them mixed would mean a failed multi-clip run could be a
geometry failure wearing a multi-clip failure's clothes. A mixed-geometry
fixture is a separate, and probably necessary, second one.
