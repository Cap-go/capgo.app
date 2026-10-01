#!/usr/bin/env bash
# Regenerate every raster Capgo logo asset from the master SVGs in assets/brand/.
# Requires rsvg-convert (librsvg) and magick (ImageMagick 7). macOS: brew install librsvg imagemagick
# Native app icons + splash screens are generated afterwards with `bun run capacitor:assets`.
set -euo pipefail

cd "$(dirname "$0")/.."
BRAND=assets/brand
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

png() { rsvg-convert -w "$2" -h "$2" "$1" -o "$3"; }

# Favicons + PWA icons, one set per environment (prod has no suffix)
for env in "" development local preprod; do
  suffix=${env:+-$env}
  icon="$BRAND/capgo-icon$suffix.svg"
  cp "$icon" "public/favicon$suffix.svg"
  png "$icon" 32 "public/favicon$suffix.png"
  png "$icon" 192 "public/pwa$suffix-192x192.png"
  png "$icon" 512 "public/pwa$suffix-512x512.png"
done

# Multi-size .ico
for s in 16 32 48; do png "$BRAND/capgo-icon.svg" $s "$TMP/ico-$s.png"; done
magick "$TMP/ico-16.png" "$TMP/ico-32.png" "$TMP/ico-48.png" public/favicon.ico

# Safari pinned tab: monochrome silhouette of the mark
sed 's/fill="#001827"/fill="#000"/' "$BRAND/capgo-mark.svg" > public/safari-pinned-tab.svg

# In-app logo (white mark on transparent, inverted in light mode by the UI)
rsvg-convert -w 920 -h 920 "$BRAND/capgo-mark-white.svg" -o "$TMP/mark-920.png"
magick -size 1024x1024 xc:none "$TMP/mark-920.png" -gravity center -composite -define webp:lossless=true public/capgo.webp

# @capacitor/assets sources (custom mode) for the native app icons and splash screens
navy='#001827'; splash_bg='#111827'
rsvg-convert -w 1024 -h 1024 "$BRAND/capgo-icon.svg" -o "$TMP/icon-rounded.png"
magick -size 1024x1024 "xc:$navy" "$TMP/icon-rounded.png" -composite assets/icon-only.png
magick -size 1024x1024 "xc:$navy" assets/icon-background.png
# Adaptive icon foreground: Android masks to the inner ~61%, keep the mark inside it
rsvg-convert -w 560 -h 560 "$BRAND/capgo-mark-white.svg" -o "$TMP/fg.png"
magick -size 1024x1024 xc:none "$TMP/fg.png" -gravity center -composite assets/icon-foreground.png
rsvg-convert -w 640 -h 640 "$BRAND/capgo-mark-white.svg" -o "$TMP/splash-mark.png"
magick -size 2732x2732 "xc:$splash_bg" "$TMP/splash-mark.png" -gravity center -composite assets/splash.png
cp assets/splash.png assets/splash-dark.png

# Legacy PWA icons
for s in 48 72 96 128 192 256 512; do
  rsvg-convert -w $s -h $s "$BRAND/capgo-icon.svg" -o "$TMP/icon.png"
  magick "$TMP/icon.png" -define webp:lossless=true "icons/icon-$s.webp"
done

# Legacy PWA apple splash screens: mark centered, ~78% of the short side
for f in icons/apple-splash-*.png; do
  read -r w h < <(magick identify -format '%w %h\n' "$f")
  short=$(( w < h ? w : h )); size=$(( short * 78 / 100 ))
  if [[ $f == *-dark.png ]]; then bg='#000000'; mark="$BRAND/capgo-mark-white.svg"; else bg='#ffffff'; mark="$BRAND/capgo-mark.svg"; fi
  rsvg-convert -w $size -h $size "$mark" -o "$TMP/splash-mark.png"
  magick -size "${w}x${h}" "xc:$bg" "$TMP/splash-mark.png" -gravity center -composite "$f"
done

# Play Store feature graphic
rsvg-convert -w 355 -h 355 "$BRAND/capgo-mark-white.svg" -o "$TMP/feature-mark.png"
magick -size 1024x500 xc:'#001827' "$TMP/feature-mark.png" -gravity center -composite public/featured.png

# macOS app icon for the CLI helper
iconset="$TMP/Capgo.iconset"; mkdir -p "$iconset"
for s in 16 32 128 256 512; do
  png "$BRAND/capgo-icon.svg" $s "$iconset/icon_${s}x${s}.png"
  png "$BRAND/capgo-icon.svg" $((s * 2)) "$iconset/icon_${s}x${s}@2x.png"
done
if command -v iconutil >/dev/null; then
  iconutil -c icns "$iconset" -o cli-helper/assets/Capgo.icns
else
  echo "iconutil not found (macOS only), skipped cli-helper/assets/Capgo.icns" >&2
fi

echo "Done. Now run: bun run capacitor:assets"
