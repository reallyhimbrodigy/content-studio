#!/bin/bash
# Runs the standalone TricklePacing unit tests. The Xcode project has no test
# target; these are pure Foundation and compile/run natively in well under a
# second. Exit code is non-zero if any check fails.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
swiftc "$DIR/../Promptly/Views/TricklePacing.swift" \
       "$DIR/TricklePacingTests.swift" \
       -o "${TMPDIR:-/tmp}/pacingtest"
"${TMPDIR:-/tmp}/pacingtest"
