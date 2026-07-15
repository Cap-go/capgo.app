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

# Bundle + upload with Capgo delta
npx @capgo/rn-cli@latest upload com.example.app --channel production

# Init wiring tips + install deps
npx @capgo/rn-cli@latest init
```

## Export layout

```
.capgo-rn/export/
  index.android.bundle
  main.jsbundle
  assets/
```

Capgo file-level delta then downloads only changed files per platform.
