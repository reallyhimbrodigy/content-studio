#!/bin/bash
# reedit-versions-wire-gate.sh — the re-edit version wiring, and the two ways it
# fails without failing.
#
# 1. A SWIFT FILE IN THE REPO IS NOT IN THE BUILD. Registering a file needs FOUR
#    pbxproj entries — a PBXBuildFile, a PBXFileReference, membership in its
#    group, and membership in the Sources phase. Miss the last and the file
#    compiles nowhere, the app runs, and the feature is simply absent. This repo
#    has shipped that before: UploadTiming.swift existed, was wired, and emitted
#    nothing for thirteen days.
#
# 2. THE 409 MUST BE A TYPED CASE. "One re-edit at a time" arrives as HTTP 409
#    carrying a `status` of queued | processing | needs_input. Parked on an
#    unanswered question is not "already re-editing" in any sense a user
#    recognises — telling them to wait sends them to watch a render that is not
#    running. If the 409 degrades to a message string, the composer has to
#    re-parse prose to tell those apart and will eventually get it wrong.
#
# Exit 0 = clean. Exit 1 = the wiring is present and inert, or the state is lost.
set -uo pipefail
cd "$(dirname "$0")"
fail=0

python3 - <<'PY' || fail=1
import re, sys
pbx = open('Promptly.xcodeproj/project.pbxproj', encoding='utf8').read()
api = open('Promptly/Services/APIService.swift', encoding='utf8').read()
mdl = open('Promptly/Models/ReeditVersions.swift', encoding='utf8').read()
bad = []

# ---- 1. all four registrations, named separately so the failure says WHICH ----
m = re.search(r'([A-Za-z0-9]+) /\* ReeditVersions\.swift in Sources \*/ = \{isa = PBXBuildFile; fileRef = ([A-Za-z0-9]+);', pbx)
if not m:
    bad.append('no PBXBuildFile for ReeditVersions.swift')
else:
    build_id, file_id = m.group(1), m.group(2)
    if not re.search(rf'{file_id} /\* ReeditVersions\.swift \*/ = \{{isa = PBXFileReference', pbx):
        bad.append('no PBXFileReference for ReeditVersions.swift')
    if not re.search(rf'isa = PBXGroup; children = \([^)]*{file_id}[^)]*\); path = Models', pbx):
        bad.append('ReeditVersions.swift is not in the Models group — invisible in Xcode')
    # THERE ARE TWO SOURCES PHASES — the app's and PromptlyUITests'. Matching
    # only the first found the UITests phase and reported the app's membership
    # as missing. And NOT [^;]*: buildActionMask ends in a semicolon, which that
    # class cannot cross. Check EVERY phase and require membership in one.
    phases = re.findall(r'isa = PBXSourcesBuildPhase;[\s\S]{0,400}?files = \(([^)]*)\)', pbx)
    if not phases:
        bad.append('no PBXSourcesBuildPhase found at all — the scan is broken, not the project')
    elif not any(build_id in ph for ph in phases):
        bad.append('ReeditVersions.swift is NOT in the Sources build phase — it compiles '
                   'nowhere and every type in it is absent at runtime')

# ---- 2. the 409 is typed, and carries the status ----
if 'case reeditInFlight(ReeditInFlight)' not in api:
    bad.append('APIError.reeditInFlight is gone — the 409 has degraded to a message')
if not re.search(r'http\.statusCode == 409[\s\S]{0,260}?APIError\.reeditInFlight', api):
    bad.append('the 409 is no longer decoded into the typed case at the re-edit call')
if not re.search(r'let status: String', mdl):
    bad.append('ReeditInFlight no longer carries `status` — parked-on-a-question and '
               'actively-rendering become indistinguishable')

# ---- 3. the server's own invariant is checked, not assumed ----
if 'isConsistent' not in mdl or 'INVARIANT BROKEN' not in api:
    bad.append('versions.count vs version_count is no longer checked — a switcher that '
               'renders fewer entries than it claims looks like a UI glitch and is not')

# ---- 4. a failed job has NO ordinal ----
if not re.search(r'let version: Int\?', mdl):
    bad.append('ReeditJobFields.version is no longer optional — a failed job would be '
               'given a version number, and a failure is not a version')

if bad:
    print('reedit-versions-wire: FAIL')
    for b in bad: print('  -', b)
    sys.exit(1)
print('  registered in all four pbxproj places including Sources; the 409 is typed and '
      'carries status; the count invariant is checked; a failure has no ordinal.')
PY

[ "$fail" -eq 0 ] || { echo "reedit-versions-wire: FAIL"; exit 1; }
echo "reedit-versions-wire: PASS"
