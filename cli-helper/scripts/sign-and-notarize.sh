#!/usr/bin/env bash
# Sign (Developer ID + hardened runtime), notarize, and STAPLE each CapgoKeychainHelper.app
# bundle, then verify against the same designated requirement the CLI enforces
# at runtime — a cert/team mismatch fails the release, not the user.
#
# The bundle identifier (app.capgo.cli.helper) comes from Info.plist; it is part
# of the designated requirement and keys the Keychain "Always Allow" grant, so
# it must never change. Unlike a bare executable, an app bundle can be stapled,
# so the notarization ticket travels with the bundle.
#
# Required env:
#   DEVELOPER_ID_IDENTITY   codesign identity, e.g. "Developer ID Application: <name> (<TEAMID>)"
#   CAPGO_APPLE_TEAM_ID     10-char Apple Team ID (must match macos-signing.ts)
#   APPLE_KEY_ID            App Store Connect API key id
#   APPLE_ISSUER_ID         App Store Connect API key issuer
#   APPLE_KEY_PATH          path to the API key .p8 file
set -euo pipefail
cd "$(dirname "$0")/.."

: "${DEVELOPER_ID_IDENTITY:?}" "${CAPGO_APPLE_TEAM_ID:?}" "${APPLE_KEY_ID:?}" "${APPLE_ISSUER_ID:?}" "${APPLE_KEY_PATH:?}"

# Single source of truth: the runtime verifier (CAPGO_APPLE_TEAM_ID in
# cli/src/build/onboarding/macos-signing.ts) accepts ONLY this team. If the CI
# secret drifts from it, the release would succeed but every shipped helper
# would be rejected at runtime. Fail fast here instead. Keep in sync with
# macos-signing.ts.
EXPECTED_TEAM_ID="UVTJ336J2D"
# Bundle identifier baked into Info.plist; pinned in the designated requirement
# (must match HELPER_BUNDLE_IDENTIFIER in macos-signing.ts).
HELPER_IDENTIFIER="app.capgo.cli.helper"
if [[ "$CAPGO_APPLE_TEAM_ID" != "$EXPECTED_TEAM_ID" ]]; then
  echo "CAPGO_APPLE_TEAM_ID ($CAPGO_APPLE_TEAM_ID) != $EXPECTED_TEAM_ID expected by the CLI verifier." >&2
  echo "Fix the APPLE_TEAM_ID secret or update macos-signing.ts; refusing to sign a helper users can't run." >&2
  exit 1
fi

REQUIREMENT='=identifier "'"$HELPER_IDENTIFIER"'" and anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] and certificate leaf[subject.OU] = "'"$CAPGO_APPLE_TEAM_ID"'"'

for arch in arm64 x64; do
  app="dist/$arch/CapgoKeychainHelper.app"
  echo "── Signing $app"
  codesign --force --options runtime --timestamp --identifier "$HELPER_IDENTIFIER" --sign "$DEVELOPER_ID_IDENTITY" "$app"

  echo "── Notarizing $app"
  ditto -c -k --keepParent "$app" "dist/$arch/Capgo.zip"
  out=$(xcrun notarytool submit "dist/$arch/Capgo.zip" \
    --key "$APPLE_KEY_PATH" --key-id "$APPLE_KEY_ID" --issuer "$APPLE_ISSUER_ID" \
    --wait --timeout 30m --output-format json) || true
  id=$(echo "$out" | jq -r '.id // empty')
  status=$(echo "$out" | jq -r '.status // empty')
  if [[ "$status" != "Accepted" ]]; then
    echo "Notarization failed for $app (status: ${status:-unknown})" >&2
    if [[ -n "$id" ]]; then
      xcrun notarytool log "$id" \
        --key "$APPLE_KEY_PATH" --key-id "$APPLE_KEY_ID" --issuer "$APPLE_ISSUER_ID" >&2 || true
    fi
    exit 1
  fi
  echo "── Notarization accepted ($id); stapling"
  xcrun stapler staple "$app"
  rm -f "dist/$arch/Capgo.zip"

  echo "── Verifying $app"
  codesign --verify --strict --deep "$app"
  codesign --verify --strict -R "$REQUIREMENT" "$app"
  if ! spctl_out=$(spctl -a -t exec -vv "$app" 2>&1); then
    echo "$spctl_out" | head -5 >&2
    echo "Gatekeeper assessment (spctl) failed for $app" >&2
    exit 1
  fi
  echo "$spctl_out" | head -3
done
echo "All bundles signed, notarized, stapled, and verified."
