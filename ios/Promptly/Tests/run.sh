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

# TrialCopy — paywall trust-package copy + trial-reminder date math (pure
# Foundation: monthly-equivalent anchor, reminder fire-date, confirmation copy).
swiftc "$DIR/../Promptly/Services/TrialCopy.swift" \
       "$DIR/TrialCopyTests.swift" \
       -o "${TMPDIR:-/tmp}/trialcopytest"
"${TMPDIR:-/tmp}/trialcopytest"

# PaywallRouting — wedge/deferral state machine behind the RACE 1/RACE 2 fixes
# (park-behind-modal, flush-on-dismiss, re-drive-so-nothing-gets-wedged).
swiftc "$DIR/../Promptly/Services/PaywallRouting.swift" \
       "$DIR/PaywallRoutingTests.swift" \
       -o "${TMPDIR:-/tmp}/prtest"
"${TMPDIR:-/tmp}/prtest"

# EntitlementTier — the trial-wall tier composition rule (most-privileged wins;
# RC-vs-server disagreement resolution). Pure Foundation.
swiftc "$DIR/../Promptly/Services/EntitlementTier.swift" \
       "$DIR/EntitlementTierTests.swift" \
       -o "${TMPDIR:-/tmp}/tiertest"
"${TMPDIR:-/tmp}/tiertest"

# UsageMeter — free-tier quota display never invents a limit (build-215 revenue fix).
swiftc "$DIR/UsageMeterRegressionTests.swift" -o "${TMPDIR:-/tmp}/usagetest"
"${TMPDIR:-/tmp}/usagetest"

# ExportRouting — the export-gate whitelist (build-225 revenue gate): a 402 must
# present the paywall and NEVER fall back to the public save. Exercises the REAL
# router against the REAL error types (ExportRouting + APIError are standalone).
swiftc "$DIR/../Promptly/Services/APIError.swift" \
       "$DIR/../Promptly/Services/ExportRouting.swift" \
       "$DIR/ExportRoutingTests.swift" \
       -o "${TMPDIR:-/tmp}/exporttest"
"${TMPDIR:-/tmp}/exporttest"
