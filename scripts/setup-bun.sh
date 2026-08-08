#!/usr/bin/env bash

set -euo pipefail

BUN_VERSION="1.3.11"

case "$(uname -s):$(uname -m)" in
  "Darwin:arm64")
    asset_name="bun-darwin-aarch64.zip"
    asset_sha256="6f5a3467ed9caec4795bf78cd476507d9f870c7d57b86c945fcb338126772ffc"
    ;;
  "Darwin:x86_64")
    asset_name="bun-darwin-x64.zip"
    asset_sha256="c4fe2b9247218b0295f24e895aaec8fee62e74452679a9026b67eacbd611a286"
    ;;
  "Linux:aarch64" | "Linux:arm64")
    asset_name="bun-linux-aarch64.zip"
    asset_sha256="d13944da12a53ecc74bf6a720bd1d04c4555c038dfe422365356a7be47691fdf"
    ;;
  "Linux:x86_64")
    asset_name="bun-linux-x64.zip"
    asset_sha256="8611ba935af886f05a6f38740a15160326c15e5d5d07adef966130b4493607ed"
    ;;
  *)
    echo "Unsupported Bun platform: $(uname -s) $(uname -m)" >&2
    exit 1
    ;;
esac

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

archive_path="$tmp_dir/$asset_name"
extract_path="$tmp_dir/extract"
asset_url="https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/${asset_name}"

download_attempts=5
download_ok=0
for attempt in $(seq 1 "$download_attempts"); do
  if curl --retry 3 --retry-delay 2 --retry-all-errors -fsSL "$asset_url" -o "$archive_path"; then
    download_ok=1
    break
  fi
  echo "Bun download failed (attempt ${attempt}/${download_attempts}), retrying..." >&2
  sleep $((attempt * 2))
done

if [ "$download_ok" -ne 1 ]; then
  echo "Failed to download Bun from $asset_url after ${download_attempts} attempts" >&2
  exit 1
fi

if command -v shasum >/dev/null 2>&1; then
  echo "$asset_sha256  $archive_path" | shasum -a 256 -c -
else
  echo "$asset_sha256  $archive_path" | sha256sum -c -
fi

unzip -q "$archive_path" -d "$extract_path"

mkdir -p "$HOME/.bun/bin"
bun_binary_path="$(find "$extract_path" -type f -name bun | head -n 1)"

if [ -z "$bun_binary_path" ]; then
  echo "Bun binary not found in $asset_name" >&2
  exit 1
fi

install -m 755 "$bun_binary_path" "$HOME/.bun/bin/bun"
ln -sf "$HOME/.bun/bin/bun" "$HOME/.bun/bin/bunx"
echo "$HOME/.bun/bin" >> "$GITHUB_PATH"
export PATH="$HOME/.bun/bin:$PATH"

bun --version
