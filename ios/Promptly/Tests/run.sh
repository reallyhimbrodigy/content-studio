#!/bin/bash
# Runs the standalone unit tests. The Xcode project has no test target; these
# are pure Foundation and compile/run natively in well under a second. Exit
# code is non-zero if any check fails.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"

# TricklePacing — render progress bar pacing math.
swiftc "$DIR/../Promptly/Views/TricklePacing.swift" \
       "$DIR/TricklePacingTests.swift" \
       -o "${TMPDIR:-/tmp}/pacingtest"
"${TMPDIR:-/tmp}/pacingtest"

# FeedbackGate — in-app feedback prompt cadence decisions.
swiftc "$DIR/../Promptly/Views/FeedbackGate.swift" \
       "$DIR/FeedbackGateTests.swift" \
       -o "${TMPDIR:-/tmp}/feedbacktest"
"${TMPDIR:-/tmp}/feedbacktest"

# ModelSelection — Flare/Lumen tier-gate logic (free can never select Lumen
# or emit the premium flag; downgrade falls back to Flare).
swiftc "$DIR/../Promptly/Models/VideoModel.swift" \
       "$DIR/ModelSelectionTests.swift" \
       -o "${TMPDIR:-/tmp}/modeltest"
"${TMPDIR:-/tmp}/modeltest"

# AskPayload — Phase D ask-back model decode + answer builder (unknown-kind
# forward-compat; text/image/clip/choice/skip request bodies).
swiftc "$DIR/../Promptly/Models/AskPayload.swift" \
       "$DIR/AskPayloadTests.swift" \
       -o "${TMPDIR:-/tmp}/asktest"
"${TMPDIR:-/tmp}/asktest"
