#!/usr/bin/env bash
# Capgo Cloud Build only uploads native plugin sources that live under node_modules.
# Workspace plugins are symlinked into node_modules, so `cap sync` resolves them to
# packages/<name>, which the upload skips. Replace those symlinks with real copies
# before `cap sync` so the generated native project points into node_modules.
set -euo pipefail

for pkg in capacitor-notifications; do
  target="node_modules/@capgo/${pkg}"
  if [ -L "${target}" ]; then
    rm "${target}"
    mkdir -p "${target}"
    rsync -a --exclude node_modules --exclude dist "packages/${pkg}/" "${target}/"
    echo "Vendored packages/${pkg} into ${target}"
  fi
done
