#!/usr/bin/env bash
# CONSTRUCTED, DETERMINISTIC multi-clip fixture: three segments cut from the
# three existing reliability fixtures, as three separate source files.
# Fixed seeks, fixed durations, fixed encoder settings, no wall-clock, no
# unseeded randomness — re-running produces the same bytes.
#
# NORMALISED to 1080x1920 / 30fps / stereo 44.1k ON PURPOSE. The three sources
# have three different geometries (1080x1920@30, 540x960@59.94, 2160x3840@30),
# and leaving them mixed would mean a failed multi-clip run could be a geometry
# failure wearing a multi-clip failure's clothes. MIXED GEOMETRY IS THEREFORE
# NOT COVERED by this fixture, and that is a stated gap, not an oversight.
set -euo pipefail
out="${1:-.}"
enc=(-c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -g 60 -x264-params threads=8
     -vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,fps=30"
     -c:a aac -ar 44100 -ac 2 -movflags +faststart)

# one 6s segment from each, seeking past the opening so the cut is mid-action
ffmpeg -nostdin -v error -y -ss 4.0  -t 6 -i talking_head-f4195ca9.mp4 "${enc[@]}" "$out/multiclip_a.mp4"
ffmpeg -nostdin -v error -y -ss 8.0  -t 6 -i motion-31fa2646.mp4       "${enc[@]}" "$out/multiclip_b.mp4"
ffmpeg -nostdin -v error -y -ss 3.0  -t 6 -i car_mid-0643be1c.mp4  -map 0:v:0 -map 0:a:0 "${enc[@]}" "$out/multiclip_c.mp4"
