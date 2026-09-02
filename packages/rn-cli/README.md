# @capgo/rn-cli

React Native CLI for Capgo live updates. Builds a Metro export folder and uploads it with Capgo's **file-level delta** system (`--delta`), the same backend used by Capacitor apps.

## Install

```bash
npm install -D @capgo/rn-cli @capgo/cli
npm install @capgo/react-native-updater
```

## Commands

```bash
# Export Metro bundles (android + ios) into .capgo-rn/export
npx @capgo/rn-cli@latest bundle

# Check React Native native metadata vs a Capgo channel
npx @capgo/rn-cli@latest compatibility com.example.app --channel production

# Bundle + metadata check + upload with Capgo delta
npx @capgo/rn-cli@latest upload com.example.app --channel production

# Init wiring tips + install deps
npx @capgo/rn-cli@latest init
```

`upload` scans React Native native modules, compares them to the channel metadata, then uploads through the shared `@capgo/cli` upload library (no subprocess) with precomputed `native_packages`.

## Export layout

```text
.capgo-rn/export/
  index.android.bundle
  main.jsbundle
  assets/
```

Capgo file-level delta then downloads only changed files per platform.
