#!/usr/bin/env bash
# CONSTRUCTED non-English fixture: the EXISTING talking_head fixture's video
# with its audio replaced by Hindi speech of a translated script.
# Same face, same motion, same duration. No new media.
#
# LIP-SYNC IS OFF BY CONSTRUCTION and that is a RECORDED PROPERTY, not a defect:
# the speaker's mouth forms English words while the audio is Hindi. Anything
# that judges this fixture on mouth/audio agreement is measuring the fixture,
# not the pipeline.
set -euo pipefail
voice="${TTS_VOICE:-Lekha}"        # hi_IN system voice; swap for ElevenLabs when quota exists
src=talking_head-f4195ca9.mp4
dur=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$src")

# 1. speech from the translated script
say -v "$voice" -f th_transcript_hi.txt -o hi_speech.aiff
ffmpeg -nostdin -v error -y -i hi_speech.aiff -ac 2 -ar 44100 -c:a aac -b:a 128k hi_speech.m4a

# 2. fit to the video's exact length: pad with silence or trim, never stretch
#    (stretching would change the voice's pitch and make the fixture a second
#    variable rather than a language fixture)
ffmpeg -nostdin -v error -y -i hi_speech.m4a -af "apad" -t "$dur" -c:a aac -b:a 128k hi_speech_fit.m4a

# 3. mux: original video stream untouched, original audio DROPPED
ffmpeg -nostdin -v error -y -i "$src" -i hi_speech_fit.m4a \
  -map 0:v:0 -map 1:a:0 -c:v copy -c:a copy -movflags +faststart \
  talking_head_hi.mp4
