#!/bin/sh
#
# Sentry dSYM upload — Build Phase script.
#
# Runs during Archive builds to ship the app's debug symbols up to
# Sentry's cloud so crash reports in the dashboard are symbolicated
# (otherwise stack traces show hex addresses instead of file:line).
#
# Wired as a Build Phase in Xcode → Targets → Promptly → Build Phases
# → "+ → New Run Script Phase" with this body:
#     "${SRCROOT}/Scripts/upload-sentry-dsyms.sh"
#
# Required setup (one time, done outside the project):
#   1. brew install getsentry/tools/sentry-cli
#   2. Create a Sentry Internal Integration token with org:read +
#      project:releases + project:write scopes (Sentry → Settings →
#      Developer Settings → New Internal Integration).
#   3. Drop a .sentryclirc file at the repo root with:
#        [defaults]
#        org = your-org-slug
#        project = promptly-ios
#        [auth]
#        token = <YOUR_TOKEN>
#      Add .sentryclirc to .gitignore so the token never lands in
#      git.
#
# Safety properties:
#   - Skips entirely if sentry-cli isn't installed (warns, doesn't
#     fail the build — local non-archive Debug builds shouldn't have
#     to install Sentry tooling to compile).
#   - Skips entirely on Debug configuration — only archives need
#     symbols uploaded.
#   - Skips entirely when DWARF_DSYM_FOLDER_PATH is empty (true for
#     normal Run-from-Xcode builds).
#   - All output is prefixed [sentry] so the build log is greppable.

set -e

if [ "${CONFIGURATION}" != "Release" ]; then
    echo "[sentry] skipping dSYM upload (not Release: ${CONFIGURATION})"
    exit 0
fi

if [ -z "${DWARF_DSYM_FOLDER_PATH:-}" ]; then
    echo "[sentry] skipping dSYM upload (DWARF_DSYM_FOLDER_PATH not set — not an archive build)"
    exit 0
fi

# Resolve sentry-cli. Prefer one on PATH; fall back to /usr/local/bin
# (Homebrew x86) and /opt/homebrew/bin (Homebrew arm). Xcode build
# scripts run with a stripped PATH so explicit fallbacks matter.
SENTRY_CLI=""
if command -v sentry-cli >/dev/null 2>&1; then
    SENTRY_CLI=$(command -v sentry-cli)
elif [ -x "/opt/homebrew/bin/sentry-cli" ]; then
    SENTRY_CLI="/opt/homebrew/bin/sentry-cli"
elif [ -x "/usr/local/bin/sentry-cli" ]; then
    SENTRY_CLI="/usr/local/bin/sentry-cli"
fi

if [ -z "${SENTRY_CLI}" ]; then
    echo "[sentry] sentry-cli not found — skipping dSYM upload"
    echo "[sentry] install with: brew install getsentry/tools/sentry-cli"
    exit 0
fi

echo "[sentry] uploading dSYMs from ${DWARF_DSYM_FOLDER_PATH}"
"${SENTRY_CLI}" upload-dif \
    --include-sources \
    "${DWARF_DSYM_FOLDER_PATH}" \
    || {
        # Non-fatal — log and let the archive succeed. A failed upload
        # only loses dashboard symbolication; the app itself is fine.
        echo "[sentry] upload failed (continuing build) — check sentry-cli auth + project slug"
        exit 0
    }
echo "[sentry] dSYM upload complete"
