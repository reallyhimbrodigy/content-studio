#!/bin/bash
# associated-domains-gate.sh — DECLARED IS NOT THE SAME AS PROVISIONED (2026-08-29).
#
# WHY: referral attribution measured 0% ALL TIME — 57 users shared an invite
# link, 14 opened one, zero were ever attributed — because the link could never
# open the app. Two halves are required and BOTH were missing:
#   • server: the AASA at /.well-known/apple-app-site-association  (shipped 551bc59, live)
#   • client: the com.apple.developer.associated-domains entitlement
#
# There is a THIRD thing that is easy to miss and fails quietly: an entitlement
# may be declared in the .entitlements file while the App ID does not have the
# capability enabled and the provisioning profile therefore does not carry it.
# Automatic signing will happily produce a build. The app installs. Universal
# links simply never fire — the same silent nothing as before, but now with the
# entitlement visible in source, which reads like it is done.
#
# So this asserts all three: DECLARED, ENABLED on the App ID, and PRESENT in the
# profile embedded in the signed product.
#
# Runs before archiving. Cheap when the entitlement is not declared (exits at
# the first check), one API call when it is.
set -uo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
ENTS="$DIR/Promptly/Promptly.entitlements"
KEY_ID="6UXQ2STG2D"
ISSUER="64bc4b23-6b09-469c-967c-8a87a619dacb"
P8="$HOME/.appstoreconnect/private_keys/AuthKey_${KEY_ID}.p8"
BUNDLE="app.usepromptly.ios"

# ── 1. DECLARED? ────────────────────────────────────────────────────────────
if ! grep -q "com.apple.developer.associated-domains" "$ENTS" 2>/dev/null; then
  echo "associated-domains-gate: SKIP — entitlement not declared, nothing to provision."
  exit 0
fi
DOMAIN=$(grep -o "applinks:[a-zA-Z0-9.-]*" "$ENTS" | head -1)
echo "associated-domains-gate: declared in entitlements ($DOMAIN)"

# ── 2. ENABLED on the App ID? ───────────────────────────────────────────────
if [ ! -f "$P8" ]; then
  echo "  CANNOT VERIFY — ASC key missing at $P8. Not a pass."
  exit 2
fi

CAPS=$(node -e '
const fs=require("fs"),crypto=require("crypto"),https=require("https");
const KID=process.argv[1],ISS=process.argv[2],P8=fs.readFileSync(process.argv[3],"utf8"),B=process.argv[4];
function jwt(){const n=Math.floor(Date.now()/1e3),b=o=>Buffer.from(JSON.stringify(o)).toString("base64url");const h=b({alg:"ES256",kid:KID,typ:"JWT"}),p=b({iss:ISS,iat:n,exp:n+600,aud:"appstoreconnect-v1"});return h+"."+p+"."+crypto.sign("SHA256",Buffer.from(h+"."+p),{key:P8,dsaEncoding:"ieee-p1363"}).toString("base64url");}
https.get({host:"api.appstoreconnect.apple.com",path:`/v1/bundleIds?filter[identifier]=${B}&include=bundleIdCapabilities&limit=5`,headers:{Authorization:"Bearer "+jwt()}},r=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>{try{const j=JSON.parse(d);const u=(j.data||[]).find(x=>x.attributes.identifier===B&&x.attributes.platform!=="SERVICES");const caps=(j.included||[]).filter(i=>i.type==="bundleIdCapabilities").map(i=>i.attributes.capabilityType);console.log(caps.join(","))}catch(e){console.log("READFAIL")}})});
' "$KEY_ID" "$ISSUER" "$P8" "$BUNDLE" 2>/dev/null)

if [ "$CAPS" = "READFAIL" ] || [ -z "$CAPS" ]; then
  echo "  CANNOT VERIFY — could not read App ID capabilities. Not a pass."
  exit 2
fi

if ! printf '%s' "$CAPS" | grep -q "ASSOCIATED_DOMAINS"; then
  echo ""
  echo "associated-domains-gate: FAILED — declared in source, NOT enabled on the App ID."
  echo "  App ID capabilities today: $CAPS"
  echo ""
  echo "  This is the quiet failure: automatic signing still produces a build, the app"
  echo "  still installs, and universal links simply never fire — identical to having no"
  echo "  entitlement at all, except the source now says it is done."
  echo ""
  echo "  Owner action: enable Associated Domains on App ID $BUNDLE in the developer"
  echo "  portal, then regenerate the provisioning profile before archiving."
  exit 1
fi
echo "  ASSOCIATED_DOMAINS enabled on the App ID ✓"

# ── 3. PRESENT in the profile the signed product carries? ───────────────────
# READ THE EXPORTED IPA, NOT THE ARCHIVE. They are different artifacts: the
# archive is signed BEFORE the export step re-signs for distribution, so its
# entitlements are the development ones. Reading the archive here reported
# `aps-environment: development` on a build that ships `production` — a false
# alarm that looks exactly like a real finding. The IPA is what Apple receives.
#
# Absence of an artifact is NOT a pass — it is an unchecked leg, and it says so.
IPA=$(ls -t /private/tmp/claude-501/*/*/scratchpad/export*/Promptly.ipa \
             "$DIR"/../../export*/Promptly.ipa 2>/dev/null | head -1)
if [ -z "$IPA" ] || [ ! -f "$IPA" ]; then
  echo "  no exported IPA found — profile leg UNCHECKED (re-run after the next archive+export)."
  exit 0
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
if ! unzip -q "$IPA" -d "$WORK" 2>/dev/null; then
  echo "  could not read $IPA — profile leg UNCHECKED."
  exit 0
fi
APP=$(ls -d "$WORK"/Payload/*.app 2>/dev/null | head -1)
PROF="$APP/embedded.mobileprovision"
if [ -z "$APP" ] || [ ! -f "$PROF" ]; then
  echo "  exported IPA carries no embedded profile — profile leg UNCHECKED."
  exit 0
fi

# A STALE artifact cannot answer this. The most recent IPA may predate both the
# entitlement and the capability — build 237 does — and failing on it would be
# blocking the next cut with evidence from the last one. That is the cry-wolf
# shape: the gate would be red before anyone had a chance to make it green.
# STALENESS BY BUILD NUMBER, not by file mtime.
#
# The first version compared the entitlements file's mtime against the IPA's.
# That is defeated by anything that touches either file — including a `touch`
# during a negative-control run of this very gate, which made a stale IPA look
# fresh and produced a FAILED verdict about a build that was never meant to
# carry the entitlement. A gate whose correctness depends on filesystem
# timestamps is a gate that lies after any routine file operation.
#
# The build number is the semantic fact: an IPA is only evidence about the
# version it actually contains.
WANT_BUILD=$(grep -m1 -o 'CURRENT_PROJECT_VERSION = [0-9]*' "$DIR/Promptly.xcodeproj/project.pbxproj" | grep -o '[0-9]*')
IPA_BUILD=$(unzip -p "$IPA" 'Payload/*.app/Info.plist' 2>/dev/null \
            | plutil -extract CFBundleVersion raw - 2>/dev/null || echo "")
if [ -z "$IPA_BUILD" ] || [ "$IPA_BUILD" != "$WANT_BUILD" ]; then
  echo "  newest IPA is build ${IPA_BUILD:-unknown}, current source is build ${WANT_BUILD}."
  echo "  A different build cannot answer this — profile leg UNCHECKED until build ${WANT_BUILD} is exported."
  exit 0
fi
echo "  reading the EXPORTED IPA: $(basename "$(dirname "$(dirname "$IPA")")")/$(basename "$IPA")"
if security cms -D -i "$PROF" 2>/dev/null | grep -q "com.apple.developer.associated-domains"; then
  echo "  embedded provisioning profile carries the entitlement ✓"
  echo "associated-domains-gate: PASS — declared, enabled, and provisioned."
  exit 0
fi
echo ""
echo "associated-domains-gate: FAILED — the App ID has the capability, but the"
echo "  profile embedded in the SHIPPED IPA does not carry it. The profile predates"
echo "  the capability. Re-archive with -allowProvisioningUpdates so the regenerated"
echo "  profile is embedded, or the build ships unable to receive referral links."
exit 1
