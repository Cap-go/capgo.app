#!/usr/bin/env bash
# Deploy jobs check out only the target commit. resolve-deploy-tag.ts needs every Capgo tag
# and its commit (not trees or blobs), which this fetches in ~2s instead of a full history.
set -euo pipefail
git fetch --quiet --no-tags --depth=1 --filter=tree:0 origin '+refs/tags/capgo-*:refs/tags/capgo-*'
