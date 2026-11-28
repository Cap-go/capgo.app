#!/usr/bin/env bash
# scripts/deploy-state.ts and its imports only need zod. Installing the whole workspace cost
# ~8s on the deploy critical path; install the version package.json pins, alone, instead.
set -euo pipefail
version="$(jq -er '.dependencies.zod // .devDependencies.zod' package.json)"
helper_dir="${RUNNER_TEMP:-$(mktemp -d)}/deploy-helper-deps"
mkdir -p "$helper_dir"
printf '{"private":true,"dependencies":{"zod":"%s"}}\n' "$version" > "$helper_dir/package.json"
bun install --cwd "$helper_dir" --no-save --silent
rm -rf node_modules
ln -s "$helper_dir/node_modules" node_modules
